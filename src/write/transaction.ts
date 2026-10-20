import type { GitHubClient } from "../github/client.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  createRemoteBranch,
  updateRemoteBranch,
} from "./github.js";
import { revalidateIssueIdentity, type BoundIssueIdentity } from "./issue.js";
import {
  createPullRequest,
  findPullRequestByOperationKey,
  revalidatePullRequestIdentity,
  type BoundPullRequestIdentity,
} from "./pr.js";
import { withinValidationDeadline, type ValidationDeadline } from "./validation-deadline.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "./workspace.js";
import type { WorkspaceValidation } from "./workspace-validation.js";
import {
  assertEquivalentOperationCommit,
  assertOwnedOperationCommit,
  findOwnedBranchCommit,
  type BranchWriteOperation,
  type BranchWriteOperationKind,
} from "./operation-commit.js";

export interface RepositoryWriteContext {
  readonly writer: RepositoryWriter;
  readonly budget: ValidationDeadline;
}

interface RepositoryWriterOptions {
  readonly client: GitHubClient;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly workspace: WorkspaceSnapshot;
  readonly validation: WorkspaceValidation;
  readonly revalidateAuthority: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onPhase: (phase: "validation" | "write") => void;
}

export interface RepositoryWriteFacts {
  readonly branchName?: string;
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

interface BaseBranchWriteTarget {
  readonly branch: string;
  readonly sha: string;
  readonly issue?: { readonly number: number; readonly identity: BoundIssueIdentity };
}

export interface NewPullRequestWritePlan {
  readonly kind: "new-pr";
  readonly target: BaseBranchWriteTarget;
  readonly operationKind: BranchWriteOperationKind;
  readonly operation: BranchWriteOperation;
  readonly publication: { readonly title: string; readonly body: string };
}

export interface PullHeadWritePlan {
  readonly kind: "pr-head";
  readonly target: { readonly number: number; readonly identity: BoundPullRequestIdentity };
  readonly commitMessage: string;
}

type RepositoryWritePlan = NewPullRequestWritePlan | PullHeadWritePlan;
interface RepositoryWriteOptions extends RepositoryWriterOptions {
  readonly plan: RepositoryWritePlan;
  readonly budget: ValidationDeadline;
  readonly effects: { -readonly [K in keyof RepositoryWriteFacts]?: RepositoryWriteFacts[K] };
}
interface NewPullRequestWriteResult {
  readonly branch: string;
  readonly pullNumber: number;
  readonly url: string;
}
interface PullHeadWriteResult {
  readonly commitSha: string;
  readonly paths: readonly string[];
}

/** Bind validation and effect evidence once, rather than forwarding callbacks through commands. */
export class RepositoryWriter {
  private readonly effects: {
    -readonly [K in keyof RepositoryWriteFacts]?: RepositoryWriteFacts[K];
  } = {};
  public constructor(private readonly options: RepositoryWriterOptions) {}
  public get facts(): RepositoryWriteFacts {
    return { ...this.effects };
  }
  public write(
    plan: NewPullRequestWritePlan,
    budget: ValidationDeadline,
  ): Promise<NewPullRequestWriteResult>;
  public write(plan: PullHeadWritePlan, budget: ValidationDeadline): Promise<PullHeadWriteResult>;
  public async write(
    plan: RepositoryWritePlan,
    budget: ValidationDeadline,
  ): Promise<NewPullRequestWriteResult | PullHeadWriteResult> {
    return executeRepositoryWrite({ ...this.options, plan, budget, effects: this.effects });
  }
}

async function revalidateWriteTarget(options: RepositoryWriteOptions): Promise<void> {
  const {
    client,
    repository: { owner, repo },
    plan,
  } = options;
  if (plan.kind === "pr-head") {
    await revalidatePullRequestIdentity(
      client,
      owner,
      repo,
      plan.target.number,
      plan.target.identity,
    );
    return;
  }
  await assertRemoteBranchHead(client, owner, repo, plan.target.branch, plan.target.sha);
  if (plan.target.issue !== undefined) {
    await revalidateIssueIdentity(
      client,
      owner,
      repo,
      plan.target.issue.number,
      plan.target.issue.identity,
    );
  }
}

async function persistNewPullRequest(
  options: RepositoryWriteOptions & { readonly plan: NewPullRequestWritePlan },
  candidateSha: string,
  reconciledCommit: string | null,
): Promise<NewPullRequestWriteResult> {
  const {
    client,
    repository: { owner, repo },
    plan,
  } = options;
  const { operation, target } = plan;
  let commitSha = reconciledCommit;
  if (commitSha === null) {
    commitSha = candidateSha;
    await createRemoteBranch(client, owner, repo, operation.branch, commitSha);
  } else {
    await assertEquivalentOperationCommit(
      plan.operationKind,
      client,
      owner,
      repo,
      commitSha,
      candidateSha,
      operation,
      target.sha,
    );
  }
  Object.assign(options.effects, { branchName: operation.branch, commitSha });
  await assertRemoteBranchHead(client, owner, repo, operation.branch, commitSha);
  await revalidateWriteTarget(options);
  const pull = await createPullRequest(
    client,
    owner,
    repo,
    operation.branch,
    target.branch,
    plan.publication.title,
    plan.publication.body,
    operation.pullRequestMarker,
  );
  return { branch: operation.branch, pullNumber: pull.number, url: pull.url };
}

/** One owner enforces integrity, validation, fresh authority, target binding and reconciliation. */
async function executeRepositoryWrite(
  options: RepositoryWriteOptions,
): Promise<NewPullRequestWriteResult | PullHeadWriteResult> {
  const {
    client,
    repository: { owner, repo },
    plan,
    budget,
    validation,
    signal,
  } = options;
  options.onPhase("validation");
  const changes = await withinValidationDeadline(
    () => inspectWorkspaceChanges(options.workspace),
    budget,
  );
  const validateWorkspace = await validation.prepareWrite(changes, budget);
  let reconciledCommit: string | null = null;
  if (plan.kind === "new-pr") {
    const { operation, target } = plan;
    const completed = await withinValidationDeadline(
      async () =>
        findPullRequestByOperationKey(
          plan.operationKind,
          client,
          owner,
          repo,
          operation.branch,
          target.branch,
          operation.key,
        ),
      budget,
    );
    // Authenticate a completed prior attempt without replaying writes or relying
    // on an Issue/base snapshot which the completed operation may have advanced.
    if (completed !== null) {
      await withinValidationDeadline(
        async () =>
          assertOwnedOperationCommit(
            plan.operationKind,
            client,
            owner,
            repo,
            completed.headSha,
            operation.key,
            completed.snapshotFingerprint,
          ),
        budget,
      );
      // The authenticated completed operation was already Controller-validated.
      // Preserve that successful evidence without rerunning tests or mutations.
      validation.completedOperation();
      Object.assign(options.effects, {
        branchName: operation.branch,
        pullRequestNumber: completed.number,
        pullRequestUrl: completed.url,
      });
      return { branch: operation.branch, pullNumber: completed.number, url: completed.url };
    }
    reconciledCommit = await withinValidationDeadline(
      async () =>
        findOwnedBranchCommit(plan.operationKind, client, owner, repo, operation, target.sha),
      budget,
    );
  }
  await withinValidationDeadline(async () => revalidateWriteTarget(options), budget);
  if (plan.kind === "pr-head" && changes.all.length === 0)
    throw new Error("DSH reported a write but produced no file changes");
  await validateWorkspace();
  throwIfCancelled(signal);
  await withinValidationDeadline(() => revalidateWriteTarget(options), budget);
  await withinValidationDeadline(options.revalidateAuthority, budget);
  throwIfCancelled(signal);
  options.onPhase("write");
  // The authority gate precedes every initial persistent effect, including blobs.
  // After this seam, finish the bounded transport's existing reconciliation sequence
  // if cancellation races it, without replaying a ref or PR mutation.
  const candidate = await createGitHubCommitFromWorkspace(
    client,
    {
      owner,
      repo,
      baseSha: plan.kind === "new-pr" ? plan.target.sha : plan.target.identity.headSha,
      message: plan.kind === "new-pr" ? plan.operation.commitMessage : plan.commitMessage,
    },
    options.workspace,
  );
  await revalidateWriteTarget(options);
  if (plan.kind === "new-pr") {
    const result = await persistNewPullRequest(
      { ...options, plan },
      candidate.sha,
      reconciledCommit,
    );
    Object.assign(options.effects, {
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    });
    return result;
  }
  await assertRemoteBranchHead(
    client,
    owner,
    repo,
    plan.target.identity.headRef,
    plan.target.identity.headSha,
  );
  await updateRemoteBranch(client, owner, repo, plan.target.identity.headRef, candidate.sha);
  Object.assign(options.effects, { commitSha: candidate.sha, changedPaths: candidate.paths });
  return { commitSha: candidate.sha, paths: candidate.paths };
}
