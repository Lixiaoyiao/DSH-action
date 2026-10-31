import { configureCommentPublication } from "../github/comments.js";
import { createAuthorityRevalidator } from "./authority.js";
import * as core from "@actions/core";

import { finalizeWorkflowRunRoute, routeCommand, type RoutedCommand } from "../commands/router.js";
import { PolicyDeniedError } from "../errors.js";
import { configuredExtensionSecrets } from "../extensions/plan.js";
import { createGitHubClient, githubRequestAudit, type GitHubClient } from "../github/client.js";
import { parseGitHubContext } from "../github/context.js";
import { fetchEntitySnapshot, type EntitySnapshot } from "../github/fetch.js";
import { isFailedWorkflowRun, readEventPayload } from "../github/payload.js";
import { checkActorPermissions } from "../github/permissions.js";
import { StickyProgressReporter } from "../github/progress.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import type { RunOutcome } from "../result.js";
import { evaluatePolicy, type SecurityPolicy } from "../security/policy.js";
import {
  assertOperationContext,
  deferProgressUntilWriteValidation,
  resolveBaseBranch,
  resolvePullRequest,
  runUrl,
} from "./context.js";
import type { RunLifecycle } from "./lifecycle.js";
import { resolveTrustedPrompt } from "../text-files.js";

type GitHubContext = ReturnType<typeof parseGitHubContext>;
export interface AuthorizedRun {
  readonly context: GitHubContext;
  readonly client: GitHubClient;
  readonly command: RoutedCommand;
  readonly baseBranch?: string;
  readonly currentRunUrl: string;
  readonly snapshot?: EntitySnapshot;
  readonly policy: SecurityPolicy;
  readonly issueNumber?: number;
  readonly deferWriteProgress: boolean;
  /** Recompute current actor authority without expanding the admitted capability set. */
  readonly revalidateAuthority: () => Promise<void>;
  initializeProgress(): StickyProgressReporter | undefined;
}

export type PrepareRunResult =
  | {
      readonly kind: "complete";
      readonly outcome: Omit<RunOutcome, "schemaVersion" | "durationMs">;
    }
  | { readonly kind: "authorized"; readonly run: AuthorizedRun };

/** Own admission observations even when preparation fails before returning a run. */
export class RunPreparation {
  private readonly facts: {
    operation?: RoutedCommand["operation"];
    policy?: SecurityPolicy;
    runUrl?: string;
    githubClient?: GitHubClient;
  } = {};

  public constructor(
    private readonly options: {
      readonly lifecycle: RunLifecycle;
      readonly deadlineMs: number;
      readonly inputs: ActionInputs;
      readonly signal: AbortSignal;
    },
  ) {}

  public snapshot() {
    const { githubClient, ...facts } = this.facts;
    const githubRequests =
      githubClient === undefined ? undefined : githubRequestAudit(githubClient);
    return { ...facts, ...(githubRequests === undefined ? {} : { githubRequests }) };
  }

  public async run(): Promise<PrepareRunResult> {
    const { lifecycle, deadlineMs, inputs, signal } = this.options;
    const state = this.facts;
    throwIfCancelled(signal);
    core.setSecret(inputs.githubToken);
    core.setSecret(inputs.deepseekApiKey);
    for (const secret of configuredExtensionSecrets(inputs.mcpConfig, inputs.pluginConfig)) {
      core.setSecret(secret);
    }

    lifecycle.enter("routing");
    const payload = await readEventPayload(process.env.GITHUB_EVENT_PATH);
    const context = parseGitHubContext(process.env, payload);
    const baseBranch = resolveBaseBranch(context, inputs.baseBranch);
    const currentRunUrl = runUrl(context);
    state.runUrl = currentRunUrl;
    let command = routeCommand(context, inputs);
    if (command !== null) state.operation = command.operation;
    if (
      command === null ||
      (context.rawEventName === "workflow_run" &&
        command.source === "automatic-event" &&
        !isFailedWorkflowRun(payload))
    ) {
      return {
        kind: "complete",
        outcome: {
          conclusion: "neutral",
          summary:
            inputs.triggerPhrase === "@dsh"
              ? "No matching @dsh command or automatic event"
              : "No matching configured command or automatic event",
          findingsCount: 0,
        },
      };
    }
    if (
      command.source === "automatic-event" &&
      context.kind === "entity" &&
      context.pullRequest?.draft === true
    ) {
      return {
        kind: "complete",
        outcome: {
          conclusion: "neutral",
          operation: command.operation,
          summary: "Draft pull requests are not reviewed automatically",
          findingsCount: 0,
        },
      };
    }

    const client = createGitHubClient(inputs.githubToken, signal, {
      deadlineMs,
    });
    const publication = {
      mode: inputs.commentMode,
      runId: context.runId,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    };
    configureCommentPublication(client, publication);
    state.githubClient = client;
    throwIfCancelled(signal);
    lifecycle.enter("authorization");
    const permissions = await checkActorPermissions(client, context, inputs.allowedBots);
    throwIfCancelled(signal);
    lifecycle.enter("context");
    const commentActorFilter = {
      include: inputs.includeCommentsByActor,
      exclude: inputs.excludeCommentsByActor,
    };
    const pullRequest = await resolvePullRequest(client, context, commentActorFilter);
    throwIfCancelled(signal);
    command = finalizeWorkflowRunRoute(context, command, pullRequest !== undefined);
    state.operation = command.operation;
    let snapshot: EntitySnapshot | undefined = pullRequest;
    if (snapshot === undefined && context.kind === "entity") {
      snapshot = await fetchEntitySnapshot(
        client,
        context,
        context.entityNumber,
        context.isPullRequest,
        commentActorFilter,
      );
      throwIfCancelled(signal);
    }
    assertOperationContext(command, context, snapshot, baseBranch);

    lifecycle.enter("authorization");
    const policy = evaluatePolicy({
      context,
      operation: command.operation,
      allowWrite: inputs.allowWrite,
      permissions,
      requestedAccess: command.requestedAccess,
      commandSource: command.source,
      allowWorkflowRunWrite:
        context.rawEventName === "workflow_run" &&
        command.operation === "fix" &&
        pullRequest !== undefined,
      ...(pullRequest === undefined ? {} : { resolvedPullRequest: { isFork: pullRequest.isFork } }),
    });
    state.policy = policy;
    if (!policy.allowed) throw new PolicyDeniedError(policy.reason);

    const revalidateAuthority = createAuthorityRevalidator({
      client,
      context,
      command,
      inputs,
      policy,
      signal,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });

    lifecycle.enter("context");
    command = await resolveTrustedPrompt({
      client,
      repository: context.repository,
      command,
      inputs,
    });
    throwIfCancelled(signal);
    core.info(
      `Task accepted: ${command.operation}; phase=context; trust=${policy.trust}; run=${currentRunUrl}`,
    );

    const issueNumber = snapshot?.number ?? pullRequest?.number;
    const deferWriteProgress = deferProgressUntilWriteValidation(command);
    const initializeProgress = (): StickyProgressReporter | undefined => {
      if (!inputs.progressComment || issueNumber === undefined) return undefined;
      if (lifecycle.reporter !== undefined) return lifecycle.reporter;
      const publicationClient = createGitHubClient(inputs.githubToken);
      configureCommentPublication(publicationClient, publication);
      const reporter = new StickyProgressReporter({
        // Terminal publication receives its own bounded client after SIGTERM.
        client: publicationClient,
        target: { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
        expectedAuthorId: inputs.botUserId,
        operation: command.operation,
        policy,
        runUrl: currentRunUrl,
        signal,
      });
      lifecycle.setReporter(reporter);
      return reporter;
    };
    if (!deferWriteProgress) {
      await initializeProgress()?.update(
        "context",
        "Permission checks passed. Preparing a bounded, immutable context snapshot.",
      );
      throwIfCancelled(signal);
    }

    return {
      kind: "authorized",
      run: {
        context,
        client,
        command,
        ...(baseBranch === undefined ? {} : { baseBranch }),
        currentRunUrl,
        ...(snapshot === undefined ? {} : { snapshot }),
        policy,
        ...(issueNumber === undefined ? {} : { issueNumber }),
        deferWriteProgress,
        revalidateAuthority,
        initializeProgress,
      },
    };
  }
}
