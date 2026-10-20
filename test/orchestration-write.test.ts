import { afterEach, expect, it, vi } from "vitest";
import type * as ProcessTransport from "../src/security/argv.js";
import type { IssueSnapshot, PullRequestSnapshot } from "../src/github/fetch.js";
import type { AuthorizedRun } from "../src/orchestration/prepare.js";
import { RunLifecycle } from "../src/orchestration/lifecycle.js";
import { createPublication } from "../src/orchestration/operation-finalizer.js";
import { evaluatePolicy } from "../src/security/policy.js";
import type { GitHubToolBackend } from "../src/tools/github-backend.js";
import { inputs, permissions, pullRequestContext } from "./helpers.js";
import {
  agentResult,
  baseSha,
  cleanupWriteFixtures,
  commitSha,
  issueIdentity,
  successfulValidation,
  writeFixture,
} from "./helpers/repository-write.js";

const transport = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof ProcessTransport>()),
  runCommand: transport.process,
}));
afterEach(async () => {
  vi.clearAllMocks();
  await cleanupWriteFixtures();
});

async function publicationFixture(
  operation: "task" | "implement" | "fix" | "diagnose",
  metadataOnly = false,
) {
  const repository = await writeFixture();
  const context = pullRequestContext({
    isPullRequest: operation === "fix",
    entityNumber: 7,
    repository: { id: 1, owner: "o", repo: "r", fullName: "o/r", defaultBranch: "main" },
  });
  const snapshot: IssueSnapshot | PullRequestSnapshot =
    operation === "fix"
      ? {
          kind: "pull_request",
          number: 7,
          title: "Fix",
          body: "Body",
          author: "alice",
          comments: [],
          baseSha,
          baseRef: "main",
          baseRepository: "o/r",
          baseRepositoryId: 1,
          headSha: baseSha,
          headRef: "feature",
          headRepository: "o/r",
          headRepositoryId: 1,
          draft: false,
          isFork: false,
          changedFiles: [],
          diffTruncated: false,
        }
      : {
          kind: "issue",
          number: 7,
          title: "Add a parser",
          body: "Keep existing behavior",
          author: "alice",
          comments: [],
          ...issueIdentity,
        };
  const configured = inputs({
    allowWrite: true,
    runTests: !metadataOnly,
    testCommands: metadataOnly ? [] : [["npm", "test"]],
  });
  const command = {
    operation,
    requestedAccess: metadataOnly ? ("read" as const) : ("write" as const),
    source: "explicit-input" as const,
    instructions: "Act on the bound target",
  };
  const policy = evaluatePolicy({
    context,
    operation,
    requestedAccess: command.requestedAccess,
    commandSource: command.source,
    allowWrite: true,
    permissions: permissions(true),
  });
  const authorized: AuthorizedRun = {
    client: repository.client,
    context,
    command,
    snapshot,
    policy,
    issueNumber: 7,
    baseBranch: "main",
    currentRunUrl: "https://github.com/o/r/actions/runs/10",
    deferWriteProgress: true,
    revalidateAuthority: repository.revalidateAuthority,
    initializeProgress: () => undefined,
  };
  let labels: readonly string[] = [];
  const unsupported = () => Promise.reject(new Error("Unexpected metadata transport"));
  const backend: GitHubToolBackend = {
    getRepository: () => Promise.resolve({ id: 1 }),
    getIssue: () =>
      Promise.resolve({
        kind: "issue",
        number: 7,
        title: "Add a parser",
        body: "Keep existing behavior",
        authorId: 101,
        state: "open",
        stateReason: null,
        labels,
        assignees: [],
      }),
    setLabels: (_target, desired) => {
      labels = desired;
      return Promise.resolve();
    },
    setAssignees: unsupported,
    updateIssueState: unsupported,
    listRecentComments: unsupported,
    createComment: unsupported,
    getPull: unsupported,
    updatePull: unsupported,
    readChecks: unsupported,
  };
  const publication = createPublication({
    authorized,
    inputs: configured,
    lifecycle: new RunLifecycle(),
    workspace: {
      tempRoot: repository.snapshot.sourceRoot,
      agentWorkspace: repository.snapshot.workerRoot,
      ...(metadataOnly ? {} : { snapshot: repository.snapshot, boundWriteSha: baseSha }),
    },
    deadlineMs: Date.now() + 30_000,
    signal: new AbortController().signal,
    taskIdentity: "task-identity",
    githubTools: metadataOnly ? ["github.issue.labels.set"] : [],
    ...(metadataOnly
      ? {
          githubBackend: backend,
          githubBinding: {
            repositoryId: 1,
            owner: "o",
            repo: "r",
            target: "issue" as const,
            entityNumber: 7,
            ...issueIdentity,
          },
        }
      : {}),
  });
  return { repository, publication, labels: () => labels };
}

it.each(["task", "implement", "fix"] as const)(
  "publishes %s through real validation and bound GitHub writes",
  async (operation) => {
    transport.process.mockResolvedValue(successfulValidation);
    const { repository, publication } = await publicationFixture(operation);
    await expect(publication.attempt(agentResult(operation), 30_000)).resolves.toMatchObject({
      kind: "write",
    });
    expect(publication.facts).toMatchObject({
      validation: { status: "passed", commandCount: 1 },
      ...(operation === "fix" ? { commitSha } : { pullRequestNumber: 9 }),
    });
    expect(repository.effects).toContain(operation === "fix" ? "update_ref" : "pull_request");
  },
);

it.each(["task", "diagnose"] as const)(
  "flushes %s metadata without workspace mutation authority or repository test configuration",
  async (operation) => {
    const { publication, labels } = await publicationFixture(operation, true);
    await publication.tools?.invoke(
      { callId: "labels", id: "github.issue.labels.set", input: { labels: ["triaged"] } },
      { workspacePath: "unused", timeoutMs: 30_000 },
    );
    expect(labels()).toEqual([]);
    const result = agentResult("task");
    await expect(
      publication.attempt({ ...result, output: { ...result.output, operation } }, 30_000),
    ).resolves.toMatchObject({
      kind: operation === "task" ? "answer" : "diagnose",
    });
    expect(labels()).toEqual(["triaged"]);
    expect(publication.facts.validation).toBeUndefined();
    expect(transport.process).not.toHaveBeenCalled();
  },
);

it("retains a confirmed branch when PR publication fails", async () => {
  transport.process.mockResolvedValue(successfulValidation);
  const { repository, publication } = await publicationFixture("task");
  repository.api.rest.pulls.create.mockRejectedValue(new Error("PR publication failed"));
  await expect(publication.attempt(agentResult("task"), 30_000)).rejects.toThrow();
  expect(publication.facts).toMatchObject({
    commitSha,
    writeStatus: "partial-success",
    validation: { status: "passed" },
  });
  expect(repository.effects).toContain("create_ref");
});
