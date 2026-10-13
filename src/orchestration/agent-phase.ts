import * as core from "@actions/core";
import { runAgentLoop, type AgentLoopStats } from "../agent/loop.js";
import { publishTaskAnswer } from "../commands/task.js";
import { DshAgentEngine } from "../dsh/engine.js";
import type { DshFailureTelemetry } from "../dsh/errors.js";
import type { ActionInputs } from "../inputs.js";
import { buildDshToolPolicyAudit } from "../permissions/profile.js";
import type { RunOutcome, AgentRunSummary, ValidationSummary } from "../result.js";
import { createControllerSession, type ControllerSession } from "../session/controller.js";
import type { PreparedExecution } from "./execution.js";
import type { RunLifecycle } from "./lifecycle.js";
import {
  prepareDiagnosisOperation,
  prepareReviewOperation,
  prepareWorkspaceOperation,
  type FinalizedOperation,
  type PreparedOperation,
} from "./operation-finalizer.js";
import type { AuthorizedRun } from "./prepare.js";
import type { PreparedWorkspace } from "./workspace.js";

export interface AgentPhaseOptions {
  readonly lifecycle: RunLifecycle;
  readonly authorized: AuthorizedRun;
  readonly workspace: PreparedWorkspace;
  readonly execution: PreparedExecution;
  readonly inputs: ActionInputs;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

type AgentPhaseSnapshot = ReturnType<PreparedOperation["snapshot"]> &
  Pick<RunOutcome, "agent" | "toolPolicy" | "session" | "validation">;

/** Project Controller and DSH evidence without mixing their receipt planes. */
function agentSummary(evidence: DshFailureTelemetry, stats: AgentLoopStats): AgentRunSummary {
  return {
    durationMs: evidence.durationMs,
    isolation: evidence.isolationReport,
    turns: stats.turns,
    toolCalls: stats.toolCalls,
    validationRetries: stats.validationRetries,
    toolReceipts: stats.toolReceipts,
    ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
    ...(evidence.toolReceipts === undefined ? {} : { dshToolReceipts: evidence.toolReceipts }),
    ...(evidence.extensionAudit === undefined ? {} : { extensionAudit: evidence.extensionAudit }),
  };
}

/** Bind only the dependencies used by the selected business operation. */
function prepareOperation(options: AgentPhaseOptions): PreparedOperation {
  const { authorized, inputs, workspace, execution, lifecycle, deadlineMs, signal } = options;
  const publication = {
    client: authorized.client,
    repository: authorized.context.repository,
    expectedAuthorId: inputs.botUserId,
    runUrl: authorized.currentRunUrl,
    revalidateAuthority: authorized.revalidateAuthority,
    lifecycle,
  };
  if (authorized.command.operation === "review" && authorized.snapshot?.kind === "pull_request") {
    return prepareReviewOperation({
      ...publication,
      snapshot: authorized.snapshot,
      maxFindings: inputs.maxFindings,
    });
  }
  if (authorized.command.operation === "diagnose") {
    return prepareDiagnosisOperation({
      ...publication,
      ...(authorized.issueNumber === undefined ? {} : { issueNumber: authorized.issueNumber }),
    });
  }
  return prepareWorkspaceOperation({
    authorized,
    inputs,
    taskIdentity: execution.operationIdentity,
    runUrl: authorized.currentRunUrl,
    lifecycle,
    deadlineMs,
    signal,
    ...(workspace.snapshot === undefined ? {} : { workspaceCopy: workspace.snapshot }),
    ...(workspace.boundWriteSha === undefined ? {} : { boundWriteSha: workspace.boundWriteSha }),
    ...(authorized.issueNumber === undefined ? {} : { issueNumber: authorized.issueNumber }),
    ...(execution.validation === undefined ? {} : { validation: execution.validation }),
    ...(execution.githubAuthority === undefined
      ? {}
      : { githubAuthority: execution.githubAuthority }),
  });
}

/** Own turn telemetry and the selected operation through success, failure and checkpoint save. */
export class AgentPhase {
  private readonly operation: PreparedOperation;
  private readonly session: ControllerSession | undefined;
  private agent: AgentRunSummary | undefined;
  private toolPolicy: RunOutcome["toolPolicy"];
  private blockedCommentId: number | undefined;

  public constructor(private readonly options: AgentPhaseOptions) {
    const { authorized, inputs, execution, deadlineMs, signal } = options;
    this.operation = prepareOperation(options);
    this.session = createControllerSession({
      inputs,
      client: authorized.client,
      context: authorized.context,
      operation: authorized.command.operation,
      authority: {
        trust: authorized.policy.trust,
        allowed: authorized.policy.allowed,
        revalidate: authorized.revalidateAuthority,
      },
      compositionId: execution.selectedComposition.id,
      extensionDigest: execution.extensions.configurationDigest,
      deadlineMs,
      signal,
    });
  }

  public snapshot(): AgentPhaseSnapshot {
    const { githubAuthority, validation } = this.options.execution;
    const agent = this.agent;
    return {
      ...(githubAuthority?.hasExternalEffect === true
        ? { writeStatus: "partial-success" as const }
        : {}),
      ...this.operation.snapshot(),
      ...(this.blockedCommentId === undefined ? {} : { commentId: this.blockedCommentId }),
      ...(agent === undefined
        ? {}
        : {
            agent: {
              ...agent,
              ...(agent.toolReceipts === undefined
                ? {}
                : {
                    toolReceipts:
                      githubAuthority?.reconcileAgentReceipts(agent.toolReceipts) ??
                      agent.toolReceipts,
                  }),
            },
          }),
      ...(this.toolPolicy === undefined ? {} : { toolPolicy: this.toolPolicy }),
      ...(this.session === undefined ? {} : { session: this.session.snapshot() }),
      ...(validation === undefined ? {} : { validation: validation.snapshot() }),
    };
  }

  private observe(evidence: DshFailureTelemetry, stats: AgentLoopStats): void {
    if (evidence.observedTools !== undefined)
      this.toolPolicy = buildDshToolPolicyAudit(evidence.observedTools);
    this.agent = agentSummary(evidence, stats);
  }

  public async run(): Promise<Omit<RunOutcome, "schemaVersion" | "durationMs">> {
    try {
      return await this.execute();
    } catch (error) {
      this.session?.finish("failed");
      throw error;
    }
  }

  private async execute(): Promise<Omit<RunOutcome, "schemaVersion" | "durationMs">> {
    const { lifecycle, authorized, workspace, execution, inputs, signal, deadlineMs } =
      this.options;
    const { context, client, command, currentRunUrl, policy, issueNumber, deferWriteProgress } =
      authorized;
    const {
      contextPacket,
      tools,
      toolProvider,
      extensions,
      hasGitHubMutationTools,
      selectedComposition,
      redact,
    } = execution;
    const session = this.session;
    await session?.prepare();
    lifecycle.enter("agent");
    const loop = await runAgentLoop<FinalizedOperation>(
      {
        operation: command.operation,
        requestedAccess: command.requestedAccess,
        policy,
        contextPacket,
        instructions: command.instructions,
        workspacePath: workspace.agentWorkspace,
        tools,
      },
      inputs,
      {
        deadlineMs,
        signal,
        ...(toolProvider === undefined ? {} : { toolProvider }),
        redact,
        ...(session === undefined
          ? {}
          : {
              onRuntimeReady: (runtime) => session.restore(runtime),
              onRuntimeCompleted: async (runtime, completed) => {
                this.observe(completed.agent, completed.stats);
                lifecycle.enter("publication");
                await session.save(runtime);
              },
            }),
        onTurn: async (turn, maxTurns) => {
          lifecycle.enter("agent");
          await lifecycle.update(
            "agent",
            `The isolated worker is running turn ${String(turn)} of ${String(maxTurns)}. Repository, event, and tool output remain untrusted data.`,
          );
        },
        onValidationRetry: async (turn) => {
          await lifecycle.update(
            "agent",
            `Configured validation failed after turn ${String(turn)}. The bounded error output is being returned to a fresh DSH turn for repair.`,
          );
        },
        onState: (result, stats) => this.observe(result, stats),
        onEngineFailure: (failure, stats) => {
          session?.finish("failed");
          this.observe(
            failure.extensionAudit === undefined &&
              (selectedComposition.actionManagedExtensionProfile ||
                extensions.audit.entries.length > 0)
              ? { ...failure, extensionAudit: extensions.audit }
              : failure,
            stats,
          );
        },
        onCleanupError: (component, error) => {
          const message = error instanceof Error ? error.message : String(error);
          core.warning(`Agent ${component} cleanup failed: ${redact(message)}`);
        },
        blocked: async (result) => {
          session?.finish("not_saved");
          lifecycle.enter("publication");
          if (
            command.operation === "task" &&
            issueNumber !== undefined &&
            lifecycle.reporter === undefined &&
            !deferWriteProgress
          ) {
            await authorized.revalidateAuthority();
            this.blockedCommentId = await publishTaskAnswer(
              client,
              { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
              inputs.botUserId,
              result,
              currentRunUrl,
            );
          }
          return { kind: "blocked" };
        },
        finalize: (result, remainingMs) => this.operation.finalize(result, remainingMs),
      },
      {
        createEngine: (runtime) =>
          new DshAgentEngine(inputs, policy, runtime, extensions, selectedComposition),
      },
    );

    const agentResult = loop.agent;
    this.observe(agentResult, loop.stats);
    const outcome = {
      conclusion: "success" as const,
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: agentResult.output.findings.length,
      ...(command.operation === "task" && agentResult.output.taskOutput !== undefined
        ? { taskOutput: agentResult.output.taskOutput }
        : {}),
    };
    const finalized = loop.finalization;
    if (finalized.kind === "blocked") {
      await lifecycle.reporter?.blocked(agentResult.output.summary);
      return {
        ...outcome,
        conclusion: "neutral",
        validation: { status: "not-applicable", commandCount: 0 },
      };
    }
    if (finalized.kind === "review") {
      return {
        ...outcome,
        findingsCount: finalized.publication.selected,
        publication: finalized.publication,
        validation: { status: "not-applicable", commandCount: 0 },
      };
    }
    const validation: ValidationSummary = execution.validation?.snapshot() ?? {
      status: "not-applicable",
      commandCount: 0,
    };
    if (finalized.kind === "diagnose" || finalized.kind === "answer") {
      return {
        ...outcome,
        validation:
          finalized.kind === "answer" && hasGitHubMutationTools
            ? { ...validation, status: "passed" }
            : {
                status: "not-applicable",
                commandCount: 0,
                ...(validation.integrity === undefined ? {} : { integrity: validation.integrity }),
              },
        ...(finalized.kind !== "answer" || !finalized.noChanges
          ? {}
          : { writeStatus: "no-changes" as const, changedPaths: [] }),
        ...(finalized.kind !== "answer" || finalized.commentId === undefined
          ? {}
          : { commentId: finalized.commentId }),
      };
    }
    const write = finalized.write;
    if (command.operation === "implement" || write.pullRequestUrl !== undefined) {
      await authorized
        .initializeProgress()
        ?.complete(`Task completed and pull request ${write.pullRequestUrl ?? "was created"}.`);
    } else if (write.writeStatus === "partial-success") {
      await lifecycle.reporter?.complete(
        `Commit \`${write.commitSha ?? "unknown"}\` was pushed, but the detailed final status publication reported a partial success.`,
      );
    }
    return { ...outcome, validation, ...write };
  }
}
