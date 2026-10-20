import type { AuthorizedRun } from "./prepare.js";
import { finishImplementation } from "../commands/implement.js";
import { finishAutomationTask } from "../commands/task.js";
import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { issueTaskIdentity, resolveBaseBranch, runUrl } from "./context.js";
import type { RepositoryWriteContext } from "../write/transaction.js";

export interface WriteOutcome {
  readonly writeStatus: "success" | "partial-success";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

/** Route an already-authorized result to the matching Controller write finalizer. */
export interface ExecuteWriteOptions extends RepositoryWriteContext {
  readonly authorized: Pick<
    AuthorizedRun,
    "client" | "context" | "command" | "policy" | "snapshot" | "revalidateAuthority"
  >;
  readonly inputs: Pick<
    ActionInputs,
    "baseBranch" | "botUserId" | "branchPrefix" | "branchNameTemplate"
  >;
  readonly boundWriteSha: string;
  readonly agentResult: DshRunResult;
  readonly taskIdentity: string;
  readonly signal?: AbortSignal;
}

export async function executeWrite(options: ExecuteWriteOptions): Promise<WriteOutcome> {
  const { authorized, inputs, boundWriteSha, agentResult, taskIdentity, writer, budget, signal } =
    options;
  const { client, context, command, policy, snapshot } = authorized;
  throwIfCancelled(signal);
  const baseBranch = resolveBaseBranch(context, inputs.baseBranch);
  const requireBaseBranch = (): string => {
    if (baseBranch === undefined) {
      throw new Error("A repository base branch is required for pull-request creation");
    }
    return baseBranch;
  };
  if (
    command.operation === "implement" &&
    snapshot?.kind === "issue" &&
    policy.capabilities.createPullRequest
  ) {
    const result = await finishImplementation({
      owner: context.repository.owner,
      repo: context.repository.repo,
      issueNumber: snapshot.number,
      issueTitle: snapshot.title,
      issueIdentity: {
        state: snapshot.state,
        updatedAt: snapshot.updatedAt,
        contentFingerprint: snapshot.contentFingerprint,
      },
      baseBranch: requireBaseBranch(),
      boundHeadSha: boundWriteSha,
      operationKey: context.runId,
      result: agentResult,
      inputs,
      writer,
      budget,
    });
    return {
      writeStatus: "success",
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    };
  }
  if (
    command.operation === "task" &&
    (snapshot?.kind === "issue" || (snapshot === undefined && context.kind === "automation")) &&
    policy.capabilities.createPullRequest
  ) {
    const issue = snapshot?.kind === "issue" ? snapshot : undefined;
    const result = await finishAutomationTask({
      owner: context.repository.owner,
      repo: context.repository.repo,
      baseBranch: requireBaseBranch(),
      boundHeadSha: boundWriteSha,
      runIdentity: context.runId,
      taskIdentity: issue === undefined ? taskIdentity : issueTaskIdentity(taskIdentity, issue),
      result: agentResult,
      runUrl: runUrl(context),
      branchPrefix: inputs.branchPrefix,
      branchNameTemplate: inputs.branchNameTemplate,
      writer,
      budget,
      ...(issue === undefined
        ? {}
        : {
            relatedIssue: {
              number: issue.number,
              identity: {
                state: issue.state,
                updatedAt: issue.updatedAt,
                contentFingerprint: issue.contentFingerprint,
              },
            },
          }),
    });
    return {
      writeStatus: "success",
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    };
  }
  // Same-repository PR fixes are committed through the controller's GitHub API
  // after one final immutable-head check; DSH never receives that credential.
  if (
    snapshot?.kind === "pull_request" &&
    policy.capabilities.modifyWorkspace &&
    policy.capabilities.commit &&
    policy.capabilities.push
  ) {
    const { finishFix } = await import("../commands/fix.js");
    const result = await finishFix({
      client,
      target: {
        owner: context.repository.owner,
        repo: context.repository.repo,
        issueNumber: snapshot.number,
      },
      expectedAuthorId: inputs.botUserId,
      identity: {
        headSha: snapshot.headSha,
        headRef: snapshot.headRef,
        headRepositoryId: snapshot.headRepositoryId ?? -1,
        baseRepositoryId: snapshot.baseRepositoryId,
      },
      result: agentResult,
      runUrl: runUrl(context),
      writer,
      budget,
    });
    return {
      writeStatus: result.status,
      commitSha: result.commitSha,
      changedPaths: result.paths,
    };
  }
  throw new Error("The resolved entity does not support this write operation");
}
