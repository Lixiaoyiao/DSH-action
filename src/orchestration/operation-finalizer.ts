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
import type { RunOutcome } from "../result.js";
import { ReviewPublicationQuotaError } from "../review/publisher.js";
import { revalidatePullRequestHead } from "../write/pr.js";
import type { ValidationDeadline } from "../write/validation-deadline.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "../write/workspace.js";
import type { WorkspaceValidation } from "../write/workspace-validation.js";
import type { GitHubAuthoritySession } from "./github-authority.js";
import type { RunLifecycle } from "./lifecycle.js";
import { executeWrite, type ExecuteWriteOptions, type WriteOutcome } from "./write.js";

export type FinalizedOperation =
  | { readonly kind: "review"; readonly publication: Awaited<ReturnType<typeof finishReview>> }
  | { readonly kind: "diagnose" }
  | { readonly kind: "answer"; readonly noChanges?: boolean; readonly commentId?: number }
  | { readonly kind: "blocked" }
  | { readonly kind: "write"; readonly write: WriteOutcome };

type OperationSnapshot = Pick<
  RunOutcome,
  | "publication"
  | "writeStatus"
  | "commitSha"
  | "changedPaths"
  | "branchName"
  | "pullRequestNumber"
  | "pullRequestUrl"
  | "commentId"
>;

export interface PreparedOperation {
  finalize(result: DshRunResult, remainingMs: number): Promise<FinalizedOperation>;
  /** Confirmed effects survive failure in a later flush or Session save. */
  snapshot(): OperationSnapshot;
}

interface PublicationOptions {
  readonly client: GitHubClient;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly expectedAuthorId: number;
  readonly runUrl: string;
  readonly revalidateAuthority: () => Promise<void>;
  readonly lifecycle: Pick<RunLifecycle, "enter" | "update">;
}

export function prepareReviewOperation(
  options: PublicationOptions & {
    readonly snapshot: PullRequestSnapshot;
    readonly maxFindings: number;
  },
): PreparedOperation {
  const { client, repository, snapshot, lifecycle } = options;
  let publication: RunOutcome["publication"];
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
      try {
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
        );
      } catch (error) {
        if (error instanceof ReviewPublicationQuotaError) publication = error.publication;
        throw error;
      }
      return { kind: "review", publication };
    },
  };
}

export function prepareDiagnosisOperation(
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
export function prepareWorkspaceOperation(
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
  return {
    snapshot: () => ({ ...effects }),
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
          await githubAuthority?.flush(remainingControllerMs());
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
      const validateWorkspace = await validation.prepareWrite(changes, budget);
      const write = await executeWrite({
        authorized,
        inputs,
        workspaceCopy,
        boundWriteSha,
        agentResult,
        validationDeadlineMs: budget.deadlineMs,
        taskIdentity: options.taskIdentity,
        onPhase: (phase) => lifecycle.enter(phase),
        validateWorkspace,
        onValidationPassed: (receipt) => {
          if (receipt.kind === "completed-operation") validation.completedOperation();
        },
        signal,
      });
      effects = { ...write, writeStatus: "partial-success" };
      if (snapshot?.kind === "pull_request" && write.commitSha !== undefined) {
        githubAuthority?.advanceValidatedPullHead(write.commitSha, snapshot.headRef);
      }
      await githubAuthority?.flush(remainingControllerMs());
      return { kind: "write", write };
    },
  };
}
