import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type * as DshModule from "../src/dsh/runner.js";
import type * as GitHubModule from "../src/github/client.js";
import type * as ProcessModule from "../src/security/argv.js";
import { runAction } from "../src/orchestrator.js";
import { inspectWorkspaceChanges } from "../src/write/workspace.js";
import { WorkspaceValidation } from "../src/write/workspace-validation.js";
import { actionLifecycleGitHub } from "./helpers/action-lifecycle-github.js";
import { githubClientFixture } from "./helpers/github-client.js";
import { inputs } from "./helpers.js";
import { cleanupWriteFixtures, writeFixture } from "./helpers/repository-write.js";

const ports = vi.hoisted(() => ({
  client: vi.fn(),
  worker: vi.fn<typeof DshModule.runDsh>(),
  process: vi.fn<typeof ProcessModule.runCommand>(),
}));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof GitHubModule>()),
  createGitHubClient: ports.client,
}));
vi.mock("../src/dsh/runner.js", async (original) => ({
  ...(await original<typeof DshModule>()),
  runDsh: ports.worker,
}));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof ProcessModule>()),
  runCommand: ports.process,
}));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupWriteFixtures();
});

const passed: ProcessModule.CommandResult = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};

function workerResult(queued = false): DshModule.DshRunResult {
  return {
    output: {
      protocolVersion: 1,
      operation: "task",
      state: queued ? "needs_tool" : "final",
      summary: "Create hello.txt",
      findings: [],
      ...(queued
        ? {
            toolRequest: {
              id: "github.comment.create",
              input: { body: "Pending metadata update" },
            },
          }
        : {}),
    },
    durationMs: 1,
    isolationReport: {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled: true,
      processIsolated: true,
      networkIsolated: true,
      workspaceAccess: "read-write",
      extensionProfile: "github-action",
      limitations: [],
    },
  };
}

/** Persist only the external GitHub effects, so the retry authenticates a real previous transaction. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-completed-gateway-"));
  roots.push(root);
  const repository = {
    id: 1,
    name: "repo",
    full_name: "octo/repo",
    default_branch: "main",
    owner: { login: "octo" },
  };
  const issue = {
    id: 301,
    number: 7,
    title: "Create hello.txt",
    body: "Implement the change",
    user: { id: 101, login: "alice" },
    state: "open",
    updated_at: "2026-10-10T00:00:00Z",
    labels: [],
    assignees: [],
  };
  const eventPath = join(root, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({ action: "opened", repository, sender: { login: "alice" }, issue }),
  );
  for (const [name, value] of Object.entries({
    GITHUB_EVENT_NAME: "issues",
    GITHUB_ACTOR: "alice",
    GITHUB_RUN_ID: "99",
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: root,
    "INPUT_DEEPSEEK-API-KEY": "synthetic-controller-key",
    "INPUT_GITHUB-TOKEN": "synthetic-github-token",
    INPUT_COMMAND: "task",
    INPUT_PROMPT: "Create hello.txt",
    "INPUT_TASK-ACCESS": "write",
    "INPUT_ALLOW-WRITE": "true",
    "INPUT_PROGRESS-COMMENT": "false",
    "INPUT_TEST-COMMANDS": '[["node","--version"]]',
    "INPUT_ALLOWED-TOOLS": '["workspace.read","workspace.edit","github.comment.create"]',
    "INPUT_MAX-TURNS": "2",
  }))
    vi.stubEnv(name, value);
  const base = "a".repeat(40),
    tree = "b".repeat(40),
    commit = "d".repeat(40);
  const github = actionLifecycleGitHub({ base, tree, commit, permission: () => "write" });
  const commits = new Map<
    string,
    { sha: string; message: string; tree: { sha: string }; parents: { sha: string }[] }
  >();
  const pulls: {
    number: number;
    html_url: string;
    state: string;
    title: string;
    body: string;
    head: { ref: string; sha: string; repo: typeof repository };
    base: { ref: string; repo: typeof repository };
  }[] = [];
  const comments: { id: number; body: string; user: { id: number } }[] = [];
  const comment = vi.fn(({ body }: { body: string }) => {
    comments.push({ id: 901, body, user: { id: 41898282 } });
    return Promise.resolve({ data: comments[comments.length - 1] });
  });
  const client = githubClientFixture({
    ...github.transport,
    rest: {
      ...github.transport.rest,
      repos: { ...github.transport.rest.repos, get: () => Promise.resolve({ data: repository }) },
      issues: {
        ...github.transport.rest.issues,
        get: () => Promise.resolve({ data: issue }),
        listComments: () => Promise.resolve({ data: comments, headers: {} }),
        createComment: comment,
      },
      git: {
        ...github.transport.rest.git,
        getCommit: ({ commit_sha }: { commit_sha: string }) =>
          Promise.resolve({
            data: commits.get(commit_sha) ?? {
              sha: base,
              tree: { sha: tree },
              parents: [],
              message: "base",
            },
          }),
        createCommit: async (request: { message: string; tree: string; parents: string[] }) => {
          await github.created.commit(request);
          commits.set(commit, {
            sha: commit,
            message: request.message,
            tree: { sha: request.tree },
            parents: request.parents.map((sha) => ({ sha })),
          });
          return { data: { sha: commit } };
        },
      },
      pulls: {
        ...github.transport.rest.pulls,
        list: () => Promise.resolve({ data: pulls }),
        create: async (request: { head: string; base: string; title: string; body: string }) => {
          await github.created.pull(request);
          const pull = {
            number: 123,
            html_url: "https://github.com/octo/repo/pull/123",
            state: "open",
            title: request.title,
            body: request.body,
            head: { ref: request.head, sha: commit, repo: repository },
            base: { ref: request.base, repo: repository },
          };
          pulls.push(pull);
          return { data: pull };
        },
      },
    },
  });
  ports.client.mockReturnValue(client);
  return { github, comment, pulls, commits };
}

it.each(["passed", "failed"] as const)(
  "requires current workspace validation before queued mutations after reusing a completed write (%s)",
  async (currentValidation) => {
    const { github, comment, pulls, commits } = await fixture();
    ports.process.mockResolvedValue(passed);
    ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      await writeFile(join(workspacePath, "hello.txt"), "previous completed candidate\n");
      return workerResult();
    });
    const first = await runAction();
    expect(first).toMatchObject({ conclusion: "success", pullRequestNumber: 123 });
    expect(pulls).toHaveLength(1);
    expect([...commits.values()][0]?.message).toContain("DSH-Task-Key:");
    for (const effect of Object.values(github.created)) effect.mockClear();
    ports.process.mockClear();
    let candidateInvocations = 0;
    ports.process.mockImplementation(({ args }) => {
      if (args[0] === "rm") return Promise.resolve(passed);
      candidateInvocations += 1;
      return Promise.resolve(
        candidateInvocations === 2 && currentValidation === "failed"
          ? { ...passed, exitCode: 1 }
          : passed,
      );
    });
    ports.worker.mockImplementationOnce(() => Promise.resolve(workerResult(true)));
    ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      await writeFile(join(workspacePath, "hello.txt"), "different current candidate\n");
      return workerResult();
    });
    const retry = await runAction();
    for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
    expect(pulls).toHaveLength(1);
    expect(
      comment,
      "queued mutations must wait for the current candidate validation",
    ).toHaveBeenCalledTimes(currentValidation === "passed" ? 1 : 0);
    expect(
      candidateInvocations,
      "baseline validation cannot authorize the different retry candidate",
    ).toBe(2);
    expect(retry).toMatchObject({
      conclusion: currentValidation === "passed" ? "success" : "failure",
      validation: { status: currentValidation, commandCount: 1 },
      ...(currentValidation === "failed" ? { error: { code: "VALIDATION_FAILED" } } : {}),
    });
  },
);

it("requires current validation after a completed write workspace advances", async () => {
  const repository = await writeFixture();
  const configuration = inputs({ testCommands: [["npm", "test"]] });
  const gate = new WorkspaceValidation({
    workspace: repository.snapshot,
    configuration: {
      runTests: configuration.runTests,
      commands: configuration.testCommands,
      containerImage: configuration.containerImage,
    },
    integrityMode: configuration.validationIntegrity,
    onPhase: () => undefined,
    deadlineMs: Date.now() + 30_000,
    signal: new AbortController().signal,
  });
  ports.process.mockResolvedValue(passed);
  await repository.task({
    validateWorkspace: async (budget) => {
      const changes = await inspectWorkspaceChanges(repository.snapshot);
      const run = await gate.prepareWrite(changes, budget);
      return await run();
    },
  });
  await gate.validate();
  expect(ports.process).toHaveBeenCalledOnce();
  await writeFile(join(repository.snapshot.workerRoot, "parser.ts"), "different later revision\n");
  const oldEffects = [...repository.effects];
  gate.completedOperation();
  ports.process.mockResolvedValue({ ...passed, exitCode: 1 });
  await expect(gate.validate()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(repository.effects).toEqual(oldEffects);
  expect(gate.snapshot()).toMatchObject({ status: "failed", commandCount: 1 });
});

it.each([30, 10])(
  "starts current validation after long completed-write recovery within the %s-minute overall deadline",
  async (timeoutMinutes) => {
    const { github, comment, pulls } = await fixture();
    vi.stubEnv("INPUT_TIMEOUT-MINUTES", String(timeoutMinutes));
    ports.process.mockResolvedValue(passed);
    ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      await writeFile(join(workspacePath, "hello.txt"), "previous completed candidate\n");
      return workerResult();
    });
    expect(await runAction()).toMatchObject({ conclusion: "success", pullRequestNumber: 123 });
    for (const effect of Object.values(github.created)) effect.mockClear();
    ports.process.mockClear();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    ports.worker.mockImplementationOnce(() => {
      now += 301_000;
      return Promise.resolve(workerResult(true));
    });
    ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      await writeFile(join(workspacePath, "hello.txt"), "different current candidate\n");
      now += 301_000;
      return workerResult();
    });
    const retry = await runAction();
    const hasTime = timeoutMinutes === 30;
    expect(retry).toMatchObject(
      hasTime
        ? {
            conclusion: "success",
            validation: { status: "passed", commandCount: 1 },
            pullRequestNumber: 123,
          }
        : { conclusion: "failure", error: { code: "AGENT_TIMEOUT" } },
    );
    expect(comment).toHaveBeenCalledTimes(hasTime ? 1 : 0);
    expect(ports.process).toHaveBeenCalledTimes(hasTime ? 2 : 1);
    if (hasTime) expect(ports.process.mock.calls[1]?.[0].timeoutMs).toBe(600_000);
    for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
    expect(pulls).toHaveLength(1);
  },
);
