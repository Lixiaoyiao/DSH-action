import type { AgentToolReceipt } from "../agent/loop.js";
import type { EntitySnapshot } from "../github/fetch.js";
import type { parseGitHubContext } from "../github/context.js";
import type { GitHubToolBackend } from "../tools/github-backend.js";
import {
  GitHubAuthorityGateway,
  GitHubToolFlushError,
  githubFlushHasExternalEffect,
  mergeGitHubFlushReceipts,
  type GitHubToolBinding,
  type GitHubToolFlushReceipt,
} from "../tools/github.js";
import type { GitHubToolId } from "../tools/schema.js";
import type { SecurityPolicy } from "../security/policy.js";

type GitHubContext = ReturnType<typeof parseGitHubContext>;

export function createGitHubToolBinding(
  context: GitHubContext,
  snapshot: EntitySnapshot | undefined,
): GitHubToolBinding | undefined {
  const repository = {
    repositoryId: context.repository.id,
    owner: context.repository.owner,
    repo: context.repository.repo,
  } as const;
  if (context.kind === "entity" && snapshot?.kind === "issue") {
    return {
      ...repository,
      target: "issue",
      entityNumber: snapshot.number,
      state: snapshot.state,
      updatedAt: snapshot.updatedAt,
      contentFingerprint: snapshot.contentFingerprint,
    };
  }
  if (context.kind === "entity" && snapshot?.kind === "pull_request") {
    if (snapshot.headRepositoryId === null) return undefined;
    return {
      ...repository,
      target: "pull_request",
      entityNumber: snapshot.number,
      headSha: snapshot.headSha,
      headRef: snapshot.headRef,
      headRepositoryId: snapshot.headRepositoryId,
      baseSha: snapshot.baseSha,
      baseRef: snapshot.baseRef,
      baseRepositoryId: snapshot.baseRepositoryId,
    };
  }
  if (context.kind === "automation" && context.workflowRun !== undefined) {
    return { ...repository, target: "workflow_run", headSha: context.workflowRun.headSha };
  }
  return undefined;
}

/** Run-scoped Controller boundary for GitHub binding, queue flush, and receipt projection. */
export class GitHubAuthoritySession {
  public readonly gateway: GitHubAuthorityGateway;
  private readonly flushReceipts: GitHubToolFlushReceipt[] = [];

  public constructor(options: {
    readonly ids: readonly GitHubToolId[];
    readonly binding: GitHubToolBinding;
    readonly policy: SecurityPolicy;
    readonly allowWrite: boolean;
    readonly expectedAuthorId: number;
    readonly backend: GitHubToolBackend;
    readonly revalidateAuthority: () => Promise<void>;
    readonly onPhase: () => void;
    readonly workspacePath: string;
    readonly deadlineMs: number;
    readonly signal: AbortSignal;
  }) {
    this.options = options;
    this.gateway = new GitHubAuthorityGateway({
      ids: options.ids,
      binding: options.binding,
      policy: options.policy,
      allowWrite: options.allowWrite,
      expectedAuthorId: options.expectedAuthorId,
      backend: options.backend,
      revalidateAuthority: options.revalidateAuthority,
    });
  }

  private readonly options: {
    readonly onPhase: () => void;
    readonly workspacePath: string;
    readonly deadlineMs: number;
    readonly signal: AbortSignal;
  };

  public advanceValidatedPullHead(commitSha: string, expectedHeadRef: string): void {
    this.gateway.advancePullHead(commitSha, expectedHeadRef);
  }

  public reconcileAgentReceipts(
    receipts: readonly AgentToolReceipt[],
  ): readonly AgentToolReceipt[] {
    return mergeGitHubFlushReceipts(receipts, this.flushReceipts);
  }

  public async flush(remainingMs: number): Promise<void> {
    if (!this.gateway.hasPendingMutations()) return;
    this.options.onPhase();
    try {
      this.record(
        await this.gateway.flush({
          workspacePath: this.options.workspacePath,
          timeoutMs: Math.min(remainingMs, this.options.deadlineMs - Date.now()),
          signal: this.options.signal,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof GitHubToolFlushError) this.record(error.receipts);
      throw error;
    }
  }

  public get hasExternalEffect(): boolean {
    return githubFlushHasExternalEffect(this.flushReceipts);
  }

  private record(receipts: readonly GitHubToolFlushReceipt[]): void {
    this.flushReceipts.push(...receipts);
  }
}
