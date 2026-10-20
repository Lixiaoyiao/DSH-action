import { AgentDeadlineError } from "../agent/loop-errors.js";
import { finishDiagnosis } from "../commands/diagnose.js";
import { finishReview } from "../commands/review.js";
import { publishTaskAnswer } from "../commands/task.js";
import type { DshRunResult } from "../dsh/runner.js";
import { PolicyDeniedError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import type { PullRequestSnapshot } from "../github/fetch.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import type { RunFacts } from "../result.js";
import { revalidatePullRequestHead } from "../write/pr.js";
import type { ValidationDeadline } from "../write/validation-deadline.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "../write/workspace.js";
import { WorkspaceValidation } from "../write/workspace-validation.js";
import { GitHubAuthoritySession } from "./github-authority.js";
import type { RunLifecycle } from "./lifecycle.js";
import { executeWrite, type ExecuteWriteOptions, type WriteOutcome } from "./write.js";
import type { AgentToolReceipt } from "../agent/loop.js";
import type { ToolProvider } from "../agent/contracts.js";
import type { ActionInputs } from "../inputs.js";
import type { AuthorizedRun } from "./prepare.js";
import type { PreparedWorkspace } from "./workspace.js";
import { createOctokitGitHubToolBackend } from "../github/octokit-tool-backend.js";
import type { GitHubToolBinding } from "../tools/github-catalog.js";
import type { GitHubToolId } from "../tools/schema.js";
import type { GitHubToolBackend } from "../tools/github-backend.js";
import { RepositoryWriter } from "../write/transaction.js";

export type FinalizedOperation =
  | { readonly kind: "review"; readonly publication: Awaited<ReturnType<typeof finishReview>> }
  | { readonly kind: "diagnose" }
  | { readonly kind: "answer"; readonly noChanges?: boolean; readonly commentId?: number }
  | { readonly kind: "blocked" }
  | { readonly kind: "write"; readonly write: WriteOutcome };

type OperationSnapshot = Pick<
  RunFacts,
  | "publication"
  | "writeStatus"
  | "commitSha"
  | "changedPaths"
  | "branchName"
  | "pullRequestNumber"
  | "pullRequestUrl"
  | "commentId"
>;

interface PreparedOperation {
  finalize(result: DshRunResult, remainingMs: number): Promise<FinalizedOperation>;
  /** Confirmed effects survive failure in a later flush or Session save. */
  snapshot(): OperationSnapshot;
}

export interface Publication {
  readonly tools?: ToolProvider;
  readonly facts: OperationSnapshot & Pick<RunFacts, "validation">;
  attempt(result: DshRunResult, remainingMs: number): Promise<FinalizedOperation>;
  reconcileAgentReceipts(receipts: readonly AgentToolReceipt[]): readonly AgentToolReceipt[];
}

/** Bind effect ownership once; callers provide a result, never validation or write callbacks. */
export function createPublication(options: {
  readonly authorized: AuthorizedRun;
  readonly inputs: ActionInputs;
  readonly workspace: PreparedWorkspace;
  readonly lifecycle: RunLifecycle;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly taskIdentity: string;
  readonly githubTools: readonly GitHubToolId[];
  readonly githubBinding?: GitHubToolBinding;
  readonly githubBackend?: GitHubToolBackend;
}): Publication {
  const { authorized, inputs, workspace, lifecycle, deadlineMs, signal } = options;
  const validation =
    authorized.command.requestedAccess !== "write" || workspace.snapshot === undefined
      ? undefined
      : new WorkspaceValidation({
          workspace: workspace.snapshot,
          configuration: {
            runTests: inputs.runTests,
            commands: inputs.testCommands,
            containerImage: inputs.containerImage,
          },
          integrityMode: inputs.validationIntegrity,
        });
  const githubAuthority =
    options.githubTools.length === 0 || options.githubBinding === undefined
      ? undefined
      : new GitHubAuthoritySession({
          ids: options.githubTools,
          binding: options.githubBinding,
          policy: authorized.policy,
          allowWrite: inputs.allowWrite,
          expectedAuthorId: inputs.botUserId,
          backend: options.githubBackend ?? createOctokitGitHubToolBackend(authorized.client),
          revalidateAuthority: authorized.revalidateAuthority,
          onPhase: () => lifecycle.enter("write"),
          workspacePath: workspace.agentWorkspace,
          deadlineMs,
          signal,
        });
  const shared = {
    client: authorized.client,
    repository: authorized.context.repository,
    expectedAuthorId: inputs.botUserId,
    runUrl: authorized.currentRunUrl,
    revalidateAuthority: authorized.revalidateAuthority,
    lifecycle,
  };
  const operation =
    authorized.command.operation === "review" && authorized.snapshot?.kind === "pull_request"
      ? prepareReviewOperation({
          ...shared,
          snapshot: authorized.snapshot,
          maxFindings: inputs.maxFindings,
        })
      : authorized.command.operation === "diagnose"
        ? prepareDiagnosisOperation({
            ...shared,
            ...(authorized.issueNumber === undefined
              ? {}
              : { issueNumber: authorized.issueNumber }),
          })
        : prepareWorkspaceOperation({
            authorized,
            inputs,
            lifecycle,
            deadlineMs,
            signal,
            taskIdentity: options.taskIdentity,
            runUrl: authorized.currentRunUrl,
            ...(workspace.snapshot === undefined ? {} : { workspaceCopy: workspace.snapshot }),
            ...(workspace.boundWriteSha === undefined
              ? {}
              : { boundWriteSha: workspace.boundWriteSha }),
            ...(authorized.issueNumber === undefined
              ? {}
              : { issueNumber: authorized.issueNumber }),
            ...(validation === undefined ? {} : { validation }),
            ...(githubAuthority === undefined ? {} : { githubAuthority }),
          });
  let blockedCommentId: number | undefined;
  const snapshot = () => ({
    ...(githubAuthority?.hasExternalEffect === true
      ? { writeStatus: "partial-success" as const }
      : {}),
    ...operation.snapshot(),
    ...(blockedCommentId === undefined ? {} : { commentId: blockedCommentId }),
    ...(validation === undefined ? {} : { validation: validation.snapshot() }),
  });
  return {
    ...(githubAuthority === undefined ? {} : { tools: githubAuthority.gateway }),
    get facts() {
      return snapshot();
    },
    attempt: async (result, remainingMs) => {
      if (result.output.state === "blocked") {
        lifecycle.enter("publication");
        if (
          authorized.command.operation === "task" &&
          authorized.issueNumber !== undefined &&
          lifecycle.reporter === undefined &&
          !authorized.deferWriteProgress
        ) {
          await authorized.revalidateAuthority();
          blockedCommentId = await publishTaskAnswer(
            authorized.client,
            {
              owner: authorized.context.repository.owner,
              repo: authorized.context.repository.repo,
              issueNumber: authorized.issueNumber,
            },
            inputs.botUserId,
            result,
            authorized.currentRunUrl,
          );
        }
        return { kind: "blocked" };
      }
      const finalized = await operation.finalize(result, remainingMs);
      await githubAuthority?.flush(remainingMs);
      return finalized;
    },
    reconcileAgentReceipts: (receipts) =>
      githubAuthority?.reconcileAgentReceipts(receipts) ?? receipts,
  };
}

interface PublicationOptions {
  readonly client: GitHubClient;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly expectedAuthorId: number;
  readonly runUrl: string;
  readonly revalidateAuthority: () => Promise<void>;
  readonly lifecycle: Pick<RunLifecycle, "enter" | "update">;
}

function prepareReviewOperation(
  options: PublicationOptions & {
    readonly snapshot: PullRequestSnapshot;
    readonly maxFindings: number;
  },
): PreparedOperation {
  const { client, repository, snapshot, lifecycle } = options;
  let publication: RunFacts["publication"];
  return {
    snapshot: () => (publication === undefined ? {} : { publication }),
    async finalize(result) {
      lifecycle.enter("publication");
      await lifecycle.update(
        "finalizing",
        "Structured output passed validation. Mapping findings to the current diff and publishing.",
      );
      await revalidatePullRequestHead(
        client,
        repository.owner,
        repository.repo,
        snapshot.number,
        snapshot.headSha,
      );
      await options.revalidateAuthority();
      publication = await finishReview(
        client,
        {
          ...repository,
          pullNumber: snapshot.number,
          expectedAuthorId: options.expectedAuthorId,
          runUrl: options.runUrl,
        },
        snapshot,
        result,
        options.maxFindings,
        (confirmed) => {
          publication = confirmed;
        },
      );
      return { kind: "review", publication };
    },
  };
}

function prepareDiagnosisOperation(
  options: PublicationOptions & { readonly issueNumber?: number },
): PreparedOperation {
  let commentId: number | undefined;
  return {
    snapshot: () => (commentId === undefined ? {} : { commentId }),
    async finalize(result) {
      options.lifecycle.enter("publication");
      await options.lifecycle.update(
        "finalizing",
        "Structured output passed validation. Publishing the bounded CI diagnosis.",
      );
      if (options.issueNumber !== undefined) {
        await options.revalidateAuthority();
        commentId = await finishDiagnosis(
          options.client,
          { ...options.repository, issueNumber: options.issueNumber },
          options.expectedAuthorId,
          result,
          options.runUrl,
        );
      }
      return { kind: "diagnose" };
    },
  };
}

/** Task and write operations share workspace inspection, validation and write ordering. */
function prepareWorkspaceOperation(
  options: Pick<ExecuteWriteOptions, "authorized" | "inputs" | "taskIdentity"> & {
    readonly workspaceCopy?: WorkspaceSnapshot;
    readonly boundWriteSha?: string;
    readonly issueNumber?: number;
    readonly runUrl: string;
    readonly lifecycle: Pick<RunLifecycle, "enter" | "update">;
    readonly validation?: WorkspaceValidation;
    readonly githubAuthority?: GitHubAuthoritySession;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
  },
): PreparedOperation {
  const {
    authorized,
    inputs,
    workspaceCopy,
    boundWriteSha,
    lifecycle,
    validation,
    githubAuthority,
    signal,
  } = options;
  const { client, context, command, policy, snapshot } = authorized;
  let effects: OperationSnapshot = {};
  const writer =
    workspaceCopy === undefined || validation === undefined
      ? undefined
      : new RepositoryWriter({
          client,
          repository: context.repository,
          workspace: workspaceCopy,
          validation,
          revalidateAuthority: authorized.revalidateAuthority,
          signal,
          onPhase: (phase) => lifecycle.enter(phase),
        });
  return {
    snapshot: () => ({
      ...(writer === undefined || Object.keys(writer.facts).length === 0
        ? {}
        : { ...writer.facts, writeStatus: "partial-success" as const }),
      ...effects,
    }),
    async finalize(agentResult, remainingMs) {
      // Each candidate gets one validation budget; a repair turn starts a new candidate.
      let validationBudget: ValidationDeadline | undefined;
      const remainingControllerMs = (): number => {
        throwIfCancelled(signal);
        const remaining = Math.min(remainingMs, options.deadlineMs - Date.now());
        if (remaining <= 0) throw new AgentDeadlineError();
        return remaining;
      };
      const controllerValidationBudget = (): ValidationDeadline => {
        throwIfCancelled(signal);
        if (validationBudget === undefined) {
          const phaseMs = Math.min(
            remainingControllerMs(),
            phaseTimeoutMs(options.deadlineMs, PHASE_TIMEOUTS.validationMs, Date.now),
          );
          validationBudget = { deadlineMs: Date.now() + phaseMs, signal };
        }
        return validationBudget;
      };

      const changes =
        workspaceCopy === undefined ? undefined : await inspectWorkspaceChanges(workspaceCopy);
      if (changes?.all.length === 0 && command.requestedAccess === "write") {
        lifecycle.enter("validation");
        remainingControllerMs();
        await validation?.inspect(changes, controllerValidationBudget());
      }
      if (command.operation === "task") {
        if ((changes?.all.length ?? 0) === 0) {
          remainingControllerMs();
          lifecycle.enter("publication");
          await authorized.revalidateAuthority();
          const commentId =
            options.issueNumber === undefined
              ? undefined
              : await publishTaskAnswer(
                  client,
                  {
                    owner: context.repository.owner,
                    repo: context.repository.repo,
                    issueNumber: options.issueNumber,
                  },
                  inputs.botUserId,
                  agentResult,
                  options.runUrl,
                );
          if (commentId !== undefined) effects = { ...effects, commentId };
          return {
            kind: "answer",
            ...(command.requestedAccess === "write" ? { noChanges: true } : {}),
            ...(commentId === undefined ? {} : { commentId }),
          };
        }
        if (!policy.capabilities.modifyWorkspace) {
          throw new PolicyDeniedError(
            "A read-only task produced workspace changes; refusing publication",
          );
        }
      }
      if (
        workspaceCopy === undefined ||
        boundWriteSha === undefined ||
        validation === undefined ||
        writer === undefined ||
        changes === undefined
      ) {
        throw new Error("Write operation requires a trusted checked-out workspace");
      }
      lifecycle.enter("validation");
      await lifecycle.update(
        "finalizing",
        "The structured change is ready. Running configured validation before any GitHub write.",
      );
      remainingControllerMs();
      const budget = controllerValidationBudget();
      const write = await executeWrite({
        authorized,
        inputs,
        boundWriteSha,
        agentResult,
        writer,
        budget,
        taskIdentity: options.taskIdentity,
        signal,
      });
      effects = { ...effects, ...write, writeStatus: "partial-success" };
      if (snapshot?.kind === "pull_request" && write.commitSha !== undefined) {
        githubAuthority?.advanceValidatedPullHead(write.commitSha, snapshot.headRef);
      }
      return { kind: "write", write };
    },
  };
}
