import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type * as DshModule from "../src/dsh/runner.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as ProcessModule from "../src/security/argv.js";
import { DshProcessError } from "../src/dsh/errors.js";
import { runAction } from "../src/orchestrator.js";
import { SessionCheckpointError } from "../src/session/errors.js";
import type { ControllerSession } from "../src/session/controller.js";
import type { SessionRunSummary } from "../src/result.js";
import { githubClientFixture } from "./helpers/github-client.js";
import { actionLifecycleGitHub } from "./helpers/action-lifecycle-github.js";
import type { ReviewFinding } from "../src/review/schema.js";
import { record } from "../src/security/record.js";
import { buildActionOutputs, formatStepSummary } from "../src/result.js";

const ports = vi.hoisted(() => ({
  client: vi.fn(),
  runDsh: vi.fn<typeof DshModule.runDsh>(),
  process: vi.fn<typeof ProcessModule.runCommand>(),
  session: vi.fn(),
}));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof GitHubClientModule>()),
  createGitHubClient: ports.client,
}));
vi.mock("../src/dsh/runner.js", async (original) => ({
  ...(await original<typeof DshModule>()),
  runDsh: ports.runDsh,
}));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof ProcessModule>()),
  runCommand: ports.process,
}));
// Session transport and ownership are exercised separately by the Controller Session suite.
vi.mock("../src/session/controller.js", () => ({ createControllerSession: ports.session }));

function checkpointSession(save: () => Promise<void>): ControllerSession {
  let status: SessionRunSummary["status"] = "claimed";
  return {
    prepare: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    save,
    finish: (completion) => {
      status = completion;
    },
    snapshot: () => ({ mode: "save", status }),
  };
}

const base = "a".repeat(40);
const tree = "b".repeat(40);
const commit = "c".repeat(40);
const controllerDeepSeekKey = "sk-fixture-controller-secret";
const controllerGitHubToken = "ghs_fixture-controller-secret";
let created: ReturnType<typeof actionLifecycleGitHub>["created"];
let published: ReturnType<typeof actionLifecycleGitHub>["published"];
let fixtureRoot: string;
let permission = "write";
let workerPath: string;
let fixture: NonNullable<Parameters<typeof githubClientFixture>[0]>;
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
};
const pullRequest = {
  ...issue,
  draft: false,
  head: { sha: base, ref: "feature", repo: repository },
  base: { sha: base, ref: "main", repo: repository },
};
const reviewFindings: readonly ReviewFinding[] = [
  {
    title: "Regression in changed line",
    body: "The replacement skips the required check.",
    evidence: "The changed line calls new() instead of the old validation routine.",
    severity: "high",
    category: "correctness",
    confidence: 0.99,
    path: "src/value.ts",
    line: 2,
  },
  {
    title: "Related source needs attention",
    body: "The consumer still assumes the old behavior.",
    evidence: "The consumer contract requires the result that old() returned.",
    severity: "high",
    category: "regression",
    confidence: 0.98,
    path: "src/consumer.ts",
    line: 8,
  },
  {
    title: "Uncertain observation",
    body: "This is not confirmed by the current evidence.",
    severity: "low",
    category: "other",
    confidence: 0.4,
    path: "src/value.ts",
    line: 1,
  },
];

async function selectEntity(
  operation: "review" | "diagnose" | "task" | "implement" | "fix",
  kind: "issue" | "pull_request",
) {
  vi.stubEnv("INPUT_COMMAND", operation);
  vi.stubEnv(
    "GITHUB_EVENT_NAME",
    kind === "issue" ? "issues" : operation === "fix" ? "pull_request" : "pull_request_target",
  );
  if (operation === "review" || operation === "diagnose") {
    vi.stubEnv("INPUT_TASK-ACCESS", "read");
    vi.stubEnv("INPUT_ALLOW-WRITE", "false");
  }
  await writeFile(
    join(fixtureRoot, "event.json"),
    JSON.stringify({
      action: "opened",
      repository,
      sender: { login: "alice" },
      ...(kind === "issue" ? { issue } : { pull_request: pullRequest }),
    }),
  );
}

function reviewWorkerResult(): DshModule.DshRunResult {
  const result = readonlyWorkerResult("final");
  return {
    ...result,
    output: {
      ...result.output,
      operation: "review",
      summary: "Two confirmed review findings",
      findings: [...reviewFindings],
    },
  };
}

function readonlyWorkerResult(
  state: "final" | "blocked",
  mode: "controlled" | "native" = "controlled",
): DshModule.DshRunResult {
  return {
    output: {
      protocolVersion: 1,
      operation: "task",
      state,
      summary: state === "blocked" ? "Cannot safely proceed" : "Task answered",
      findings: [],
    },
    durationMs: 20,
    isolationReport: {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled: true,
      processIsolated: true,
      networkIsolated: true,
      workspaceAccess: "read-only",
      extensionProfile: mode === "native" ? "headless-native" : "github-action",
      limitations: [],
    },
    ...(mode === "native" ? { observedTools: ["read", "grep"] } : {}),
  };
}

function issueMutationTransport() {
  let labels: readonly string[] = [];
  let assignees: readonly string[] = [];
  const setLabels = vi.fn((request: { labels: readonly string[] }) => {
    labels = request.labels;
    return Promise.resolve({ data: [] });
  });
  const updateIssue = vi.fn((request: { assignees: readonly string[] }) => {
    assignees = request.assignees;
    return Promise.resolve({ data: {} });
  });
  ports.client.mockReturnValue(
    githubClientFixture({
      ...fixture,
      rest: {
        ...fixture.rest,
        repos: { ...fixture.rest?.repos, get: () => Promise.resolve({ data: repository }) },
        issues: {
          ...fixture.rest?.issues,
          get: () =>
            Promise.resolve({
              data: {
                ...issue,
                state_reason: null,
                labels: labels.map((name) => ({ name })),
                assignees: assignees.map((login) => ({ login })),
              },
            }),
          setLabels,
          update: updateIssue,
        },
      },
    }),
  );
  return { setLabels, updateIssue, labels: () => labels };
}

const passedProcess: ProcessModule.CommandResult = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};

beforeEach(async () => {
  vi.resetAllMocks();
  permission = "write";
  fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-action-lifecycle-"));
  const eventPath = join(fixtureRoot, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: {
        id: 1,
        name: "repo",
        full_name: "octo/repo",
        default_branch: "main",
        owner: { login: "octo" },
      },
      sender: { login: "alice" },
    }),
  );
  for (const [name, value] of Object.entries({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "alice",
    GITHUB_RUN_ID: "99",
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: fixtureRoot,
    "INPUT_DEEPSEEK-API-KEY": controllerDeepSeekKey,
    "INPUT_GITHUB-TOKEN": controllerGitHubToken,
    INPUT_COMMAND: "task",
    INPUT_PROMPT: "Create hello.txt",
    "INPUT_TASK-ACCESS": "write",
    "INPUT_ALLOW-WRITE": "true",
    "INPUT_PROGRESS-COMMENT": "false",
    "INPUT_TEST-COMMANDS": '[["node","--version"]]',
    "INPUT_ALLOWED-TOOLS": '["workspace.read","workspace.edit"]',
  }))
    vi.stubEnv(name, value);
  const github = actionLifecycleGitHub({ base, tree, commit, permission: () => permission });
  fixture = github.transport;
  created = github.created;
  published = github.published;
  ports.client.mockReturnValue(githubClientFixture(fixture));
  ports.process.mockResolvedValue(passedProcess);
  ports.session.mockReturnValue(undefined);
  ports.runDsh.mockImplementation(async (request) => {
    if (request.workspacePath === undefined) throw new Error("Missing worker workspace");
    workerPath = request.workspacePath;
    await writeFile(join(workerPath, "hello.txt"), "hello\n");
    return {
      output: {
        protocolVersion: 1,
        operation: "task",
        state: "final",
        summary: "Created hello.txt",
        findings: [],
      },
      durationMs: 12,
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
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function naturalComment(body: string, kind: "issue" | "pull_request" = "issue") {
  vi.stubEnv("INPUT_COMMAND", "auto");
  vi.stubEnv("INPUT_PROMPT", "");
  vi.stubEnv("GITHUB_EVENT_NAME", "issue_comment");
  await writeFile(
    join(fixtureRoot, "event.json"),
    JSON.stringify({
      action: "created",
      repository,
      sender: { login: "alice", type: "User" },
      issue: { ...issue, ...(kind === "pull_request" ? { pull_request: {} } : {}) },
      comment: { id: 12, body, user: { login: "alice", type: "User" } },
    }),
  );
}

it.each([
  ["controlled", "issue"],
  ["native", "issue"],
  ["controlled", "pull_request"],
  ["native", "pull_request"],
] as const)(
  "keeps %s natural-language %s requests read-only without their own opt-in",
  async (mode, kind) => {
    await naturalComment("@dsh 修复这个 Bug 并提交 PR", kind);
    vi.stubEnv("INPUT_DSH-MODE", mode);
    // The fixture already has allow-write=true and task-access=write. Neither
    // may turn a natural-language request into a write without its separate flag.
    ports.runDsh.mockResolvedValue(readonlyWorkerResult("final", mode));
    const outcome = await runAction();
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({
      conclusion: "success",
      operation: "task",
      policy: { capabilities: { modifyWorkspace: false, commit: false, push: false } },
    });
    expect(ports.runDsh).toHaveBeenCalledOnce();
    expect(ports.process).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it.each(["controlled", "native"] as const)(
  "passes explicit model settings from Action inputs to the %s worker",
  async (mode) => {
    await naturalComment("@dsh explain this issue");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_MODEL", "deepseek-v4-pro");
    vi.stubEnv("INPUT_REASONING-EFFORT", "off");
    ports.runDsh.mockResolvedValue(readonlyWorkerResult("final", mode));
    const outcome = await runAction();
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({ conclusion: "success" });
    expect(ports.runDsh.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-pro",
      reasoningEffort: "off",
    });
  },
);

it("routes an explicitly opted-in natural change request through validated PR publication", async () => {
  await naturalComment("@dsh 修复这个 Bug 并提交 PR");
  vi.stubEnv("INPUT_NATURAL-LANGUAGE-WRITE", "true");
  vi.stubEnv("INPUT_TASK-ACCESS", "read");
  const outcome = await runAction();
  expect(outcome, JSON.stringify(outcome.error)).toMatchObject({
    conclusion: "success",
    operation: "task",
    policy: { capabilities: { modifyWorkspace: true, createPullRequest: true } },
    validation: { status: "passed", commandCount: 1 },
    pullRequestNumber: 123,
  });
  expect(ports.process).toHaveBeenCalledOnce();
  expect(created.commit).toHaveBeenCalledOnce();
  expect(created.pull).toHaveBeenCalledOnce();
});

it("keeps ambiguous natural requests read-only even with both write opt-ins", async () => {
  await naturalComment("@dsh 帮我看看这个问题");
  vi.stubEnv("INPUT_NATURAL-LANGUAGE-WRITE", "true");
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("final"));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    policy: { capabilities: { modifyWorkspace: false, push: false } },
  });
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["allow-write", "actor", "validation", "revoked"] as const)(
  "does not bypass the existing %s gate for natural-language writes",
  async (gate) => {
    await naturalComment("@dsh 修复这个 Bug 并提交 PR");
    vi.stubEnv("INPUT_NATURAL-LANGUAGE-WRITE", "true");
    if (gate === "allow-write") vi.stubEnv("INPUT_ALLOW-WRITE", "false");
    if (gate === "actor") permission = "read";
    if (gate === "validation")
      ports.process.mockResolvedValue({ ...passedProcess, exitCode: 1, stderr: "suite failed" });
    if (gate === "revoked") {
      const execute = ports.runDsh.getMockImplementation();
      ports.runDsh.mockImplementation(async (...args) => {
        if (execute === undefined) throw new Error("Missing model adapter");
        const result = await execute(...args);
        permission = "read";
        return result;
      });
    }
    const outcome = await runAction();
    expect(outcome).toMatchObject({ conclusion: "failure" });
    if (gate === "allow-write" || gate === "actor") expect(ports.runDsh).not.toHaveBeenCalled();
    if (gate === "validation") expect(outcome.validation).toMatchObject({ status: "failed" });
    if (gate === "revoked") expect(outcome.validation).toMatchObject({ status: "passed" });
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it.each(["prompt", "review"])(
  "stages %s image bytes in the read-only runtime home and leaves repository publication unchanged",
  async (source) => {
    const imageUrl =
      "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
    vi.stubEnv("INPUT_PROMPT", `Read this image: ![example](${imageUrl})`);
    vi.stubEnv("INPUT_TASK-ACCESS", "read");
    vi.stubEnv("INPUT_ALLOW-WRITE", "false");
    if (source === "review") {
      vi.stubEnv("INPUT_PROMPT", "");
      vi.stubEnv("INPUT_COMMAND", "auto");
      vi.stubEnv("GITHUB_EVENT_NAME", "pull_request_review");
      await writeFile(
        join(fixtureRoot, "event.json"),
        JSON.stringify({
          action: "submitted",
          repository,
          pull_request: pullRequest,
          sender: { login: "alice" },
          review: {
            id: 1,
            body: `@dsh task Read this image: ![example](${imageUrl})`,
            user: { login: "alice" },
            submitted_at: "2026-10-18T00:00:00Z",
          },
        }),
      );
    }
    const download = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(imageBytes, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", download);
    ports.runDsh.mockImplementation(async (request, dependencies) => {
      const runtime = dependencies?.runtime;
      if (runtime === undefined) throw new Error("Missing Worker runtime");
      const filename = `${createHash("sha256").update(imageBytes).digest("hex")}.png`;
      expect(await readFile(join(runtime.dshHome, "github-images", filename))).toEqual(imageBytes);
      expect(request.prompt).toContain(`/dsh-home/github-images/${filename}`);
      expect(request.nativeTools).toContain("workspace.read");
      expect(request.nativeTools).not.toContain("workspace.edit");
      expect(request.prompt).not.toContain(controllerGitHubToken);
      return readonlyWorkerResult("final");
    });
    const outcome = await runAction();
    expect(outcome.conclusion, JSON.stringify(outcome.error)).toBe("success");
    expect(download).toHaveBeenCalledTimes(1);
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("reports unavailable image reading without fetching or overriding an explicit read denial", async () => {
  vi.stubEnv(
    "INPUT_PROMPT",
    "![example](https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc)",
  );
  vi.stubEnv("INPUT_TASK-ACCESS", "read");
  vi.stubEnv("INPUT_ALLOW-WRITE", "false");
  vi.stubEnv("INPUT_DISALLOWED-TOOLS", '["workspace.read"]');
  const download = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", download);
  ports.runDsh.mockImplementation((request) => {
    expect(request.prompt).toContain("Image reading requires effective workspace.read");
    expect(request.nativeTools).not.toContain("workspace.read");
    return Promise.resolve(readonlyWorkerResult("blocked"));
  });
  const outcome = await runAction();
  expect(outcome.conclusion, JSON.stringify(outcome.error)).toBe("neutral");
  expect(download).not.toHaveBeenCalled();
});

it.each([
  ["missing commands", "INPUT_TEST-COMMANDS", "[]", "test-commands"],
  ["run-tests=false", "INPUT_RUN-TESTS", "false", "run-tests=false"],
  ["allow-write=false", "INPUT_ALLOW-WRITE", "false", "allow-write=true"],
])(
  "denies write configuration with %s before external work",
  async (_label, name, value, diagnostic) => {
    vi.stubEnv(name, value);
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: {
        code: "POLICY_DENIED",
        category: "policy",
        phase: "configuration",
        retryable: false,
      },
    });
    expect(outcome.error?.message).toContain(diagnostic);
    const outputs = buildActionOutputs(outcome);
    expect(outputs["error-code"]).toBe("POLICY_DENIED");
    expect(record(JSON.parse(String(outputs["result-json"]))).status).toBe("denied");
    expect(ports.client).not.toHaveBeenCalled();
    expect(ports.runDsh).not.toHaveBeenCalled();
    expect(ports.process).not.toHaveBeenCalled();
    expect(published.comment).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it.each(["main", "release/next"])(
  "materializes the immutable %s head rather than live runner files",
  async (branch) => {
    if (branch !== "main") vi.stubEnv("INPUT_BASE-BRANCH", branch);
    const boundSha = branch === "main" ? base : "e".repeat(40);
    const blobSha = "d".repeat(40);
    await writeFile(join(fixtureRoot, "runner-only.txt"), "runner state");
    const getRef = vi.fn(() => Promise.resolve({ data: { object: { sha: boundSha } } }));
    const getCommit = vi.fn(() =>
      Promise.resolve({ data: { sha: boundSha, tree: { sha: tree } } }),
    );
    ports.client.mockReturnValue(
      githubClientFixture({
        ...fixture,
        rest: {
          ...fixture.rest,
          git: {
            ...fixture.rest?.git,
            getRef,
            getCommit,
            getTree: () =>
              Promise.resolve({
                data: {
                  sha: tree,
                  truncated: false,
                  tree: [
                    { path: "baseline.txt", type: "blob", mode: "100644", sha: blobSha, size: 10 },
                  ],
                },
              }),
            getBlob: () =>
              Promise.resolve({
                data: {
                  sha: blobSha,
                  encoding: "base64",
                  content: Buffer.from("immutable\n").toString("base64"),
                },
              }),
          },
        },
      }),
    );
    ports.runDsh.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      expect(await readFile(join(workspacePath, "baseline.txt"), "utf8")).toBe("immutable\n");
      await expect(readFile(join(workspacePath, "runner-only.txt"))).rejects.toThrow();
      return readonlyWorkerResult("final");
    });

    const outcome = await runAction();
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({
      conclusion: "success",
      writeStatus: "no-changes",
    });
    expect(getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: `heads/${branch}` }));
    expect(getCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: boundSha }));
    expect(ports.process).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("does not publish a no-change answer after the Controller deadline expires", async () => {
  await selectEntity("task", "issue");
  vi.stubEnv("INPUT_TIMEOUT-MINUTES", "1");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  ports.runDsh.mockImplementationOnce(() => {
    now += 61_000;
    return Promise.resolve(readonlyWorkerResult("final"));
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    error: { code: "AGENT_TIMEOUT", category: "runtime" },
  });
  expect(published.comment).not.toHaveBeenCalled();
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["controlled", "native"] as const)(
  "validates queued %s metadata effects only during finalization",
  async (mode) => {
    await selectEntity("task", "issue");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_ALLOWED-TOOLS", '["workspace.edit","github.issue.labels.set"]');
    const metadata = issueMutationTransport();
    const worker = readonlyWorkerResult("final", mode);
    ports.runDsh.mockImplementationOnce(() => {
      expect(ports.process).not.toHaveBeenCalled();
      expect(metadata.labels()).toEqual([]);
      return Promise.resolve({
        ...worker,
        output: {
          ...worker.output,
          state: "needs_tool",
          toolRequest: { id: "github.issue.labels.set", input: { labels: ["triaged"] } },
        },
      });
    });
    ports.runDsh.mockImplementationOnce(() => {
      expect(metadata.labels()).toEqual([]);
      return Promise.resolve(worker);
    });

    const outcome = await runAction();
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({
      conclusion: "success",
      validation: { status: "passed", commandCount: 1 },
      agent: {
        turns: 2,
        toolCalls: 1,
        toolReceipts: [
          {
            id: "github.issue.labels.set",
            ok: true,
            effect: "updated",
            attempts: 1,
            reconciled: true,
          },
        ],
      },
    });
    expect(ports.process).toHaveBeenCalledOnce();
    expect(metadata.labels()).toEqual(["triaged"]);
    expect(metadata.setLabels).toHaveBeenCalledOnce();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it.each(["controlled", "native"] as const)(
  "allows the %s worker to repair a failing baseline with an unused metadata capability",
  async (mode) => {
    await selectEntity("task", "issue");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_ALLOWED-TOOLS", '["workspace.edit","github.issue.labels.set"]');
    const metadata = issueMutationTransport();
    ports.process.mockImplementation(async (request) => {
      const repaired = await readFile(join(request.cwd, "hello.txt"), "utf8").then(
        (value) => value === "hello\n",
        () => false,
      );
      return {
        ...passedProcess,
        exitCode: repaired ? 0 : 1,
        stderr: repaired ? "" : "suite failed",
      };
    });
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "success",
      validation: { status: "passed", commandCount: 1 },
    });
    expect(ports.process.mock.calls.filter(([{ args }]) => args[0] === "run")).toHaveLength(1);
    expect(ports.runDsh).toHaveBeenCalledOnce();
    expect(metadata.labels()).toEqual([]);
    expect(metadata.setLabels).not.toHaveBeenCalled();
    expect(published.comment).not.toHaveBeenCalled();
    expect(created.commit).toHaveBeenCalledOnce();
    expect(created.pull).toHaveBeenCalledOnce();
  },
);

it.each(["controlled", "native"] as const)(
  "blocks queued %s metadata effects when final workspace validation fails",
  async (mode) => {
    await selectEntity("task", "issue");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_ALLOWED-TOOLS", '["workspace.edit","github.issue.labels.set"]');
    const metadata = issueMutationTransport();
    const worker = readonlyWorkerResult("final", mode);
    ports.runDsh
      .mockResolvedValueOnce({
        ...worker,
        output: {
          ...worker.output,
          state: "needs_tool",
          toolRequest: { id: "github.issue.labels.set", input: { labels: ["triaged"] } },
        },
      })
      .mockResolvedValueOnce(worker)
      .mockResolvedValue(readonlyWorkerResult("blocked", mode));
    ports.process.mockResolvedValue({ ...passedProcess, exitCode: 1, stderr: "suite failed" });
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "failure",
      validation: { status: "failed", commandCount: 1 },
      error: { code: "VALIDATION_FAILED" },
    });
    expect(ports.runDsh).toHaveBeenCalledTimes(3);
    expect(metadata.setLabels).not.toHaveBeenCalled();
    expect(published.comment).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it.each(["controlled", "native"] as const)(
  "skips validation for an unused %s metadata capability with no workspace changes",
  async (mode) => {
    await selectEntity("task", "issue");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_ALLOWED-TOOLS", '["workspace.edit","github.issue.labels.set"]');
    const metadata = issueMutationTransport();
    ports.runDsh.mockResolvedValue(readonlyWorkerResult("final", mode));
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "success",
      writeStatus: "no-changes",
      validation: { status: "not-applicable", commandCount: 0 },
    });
    expect(ports.process).not.toHaveBeenCalled();
    expect(metadata.setLabels).not.toHaveBeenCalled();
  },
);

it("retains partial metadata effects and final receipts when a later postcondition fails", async () => {
  await selectEntity("task", "issue");
  vi.stubEnv(
    "INPUT_ALLOWED-TOOLS",
    '["workspace.edit","github.issue.labels.set","github.issue.assignees.set"]',
  );
  const metadata = issueMutationTransport();
  // Acknowledged transport success is insufficient when a fresh read lacks its postcondition.
  metadata.updateIssue.mockResolvedValue({ data: {} });
  const worker = readonlyWorkerResult("final");
  ports.runDsh.mockResolvedValueOnce({
    ...worker,
    output: {
      ...worker.output,
      state: "needs_tool",
      toolRequest: { id: "github.issue.labels.set", input: { labels: ["triaged"] } },
    },
  });
  ports.runDsh.mockResolvedValueOnce({
    ...worker,
    output: {
      ...worker.output,
      state: "needs_tool",
      toolRequest: { id: "github.issue.assignees.set", input: { assignees: ["alice"] } },
    },
  });
  ports.runDsh.mockResolvedValueOnce(worker);

  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    writeStatus: "partial-success",
    error: { phase: "write" },
    agent: {
      turns: 3,
      toolCalls: 2,
      toolReceipts: [
        { id: "github.issue.labels.set", ok: true, effect: "updated", attempts: 1 },
        {
          id: "github.issue.assignees.set",
          ok: false,
          effect: "scheduled",
          attempts: 1,
          externalEffect: "confirmed",
          error: true,
        },
      ],
    },
  });
  expect(metadata.labels()).toEqual(["triaged"]);
  expect(metadata.setLabels).toHaveBeenCalledOnce();
  expect(metadata.updateIssue).toHaveBeenCalledOnce();
  expect(published.comment).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("returns a blocked task without validation, repository writes or saving a Session", async () => {
  const save = vi.fn(() => Promise.resolve());
  ports.session.mockReturnValue(checkpointSession(save));
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("blocked"));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "neutral",
    summary: "Cannot safely proceed",
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(save).not.toHaveBeenCalled();
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["controlled", "native"] as const)(
  "completes a readonly %s task through the real lifecycle",
  async (mode) => {
    vi.stubEnv("INPUT_TASK-ACCESS", "read");
    vi.stubEnv("INPUT_ALLOW-WRITE", "false");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    ports.runDsh.mockResolvedValue(readonlyWorkerResult("final", mode));
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "success",
      summary: "Task answered",
      validation: { status: "not-applicable", commandCount: 0 },
    });
    if (mode === "native")
      expect(outcome.toolPolicy).toEqual({
        schemaVersion: 1,
        policyOwner: "dsh",
        observedTools: ["grep", "read"],
      });
    expect(ports.process).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("does not run validation for unused metadata tools when a no-change task loses authority", async () => {
  await selectEntity("task", "issue");
  vi.stubEnv("INPUT_ALLOWED-TOOLS", '["workspace.edit","github.comment.create"]');
  ports.runDsh.mockImplementation(() => {
    permission = "read";
    return Promise.resolve(readonlyWorkerResult("final"));
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    validation: { status: "not-applicable", commandCount: 0, integrity: { status: "clean" } },
    error: { code: "POLICY_DENIED", phase: "publication" },
  });
  expect(ports.process).not.toHaveBeenCalled();
  expect(published.comment).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("keeps failed native worker evidence and known usage without publishing a write", async () => {
  vi.stubEnv("INPUT_DSH-MODE", "native");
  const report = readonlyWorkerResult("final", "native");
  const usage = {
    source: "headless-worker" as const,
    completeness: "partial" as const,
    reportedSteps: 1,
    observedSteps: 2,
    tokens: { inputTokens: 100, outputTokens: 20 },
  };
  ports.runDsh.mockRejectedValue(
    new DshProcessError(1, null, "Worker crashed").attachTelemetry({
      durationMs: 20,
      isolationReport: report.isolationReport,
      usage,
      observedTools: ["read", "grep"],
    }),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({ conclusion: "failure", agent: { durationMs: 20, usage } });
  expect(outcome.toolPolicy).toEqual({
    schemaVersion: 1,
    policyOwner: "dsh",
    observedTools: ["grep", "read"],
  });
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("denies an actor revoked during the model turn before any persistent GitHub effect", async () => {
  const run = ports.runDsh.getMockImplementation();
  ports.runDsh.mockImplementation(async (...args) => {
    if (run === undefined) throw new Error("Missing model adapter");
    const result = await run(...args);
    permission = "read";
    return result;
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    validation: { status: "passed", commandCount: 1 },
    error: { code: "POLICY_DENIED" },
  });
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it.each(["controlled", "native"] as const)(
  "keeps unexecuted validation not applicable when a %s no-change task loses publication authority",
  async (mode) => {
    vi.stubEnv("INPUT_DSH-MODE", mode);
    ports.runDsh.mockImplementation(() => {
      permission = "read";
      return Promise.resolve(readonlyWorkerResult("final", mode));
    });
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "failure",
      validation: { status: "not-applicable", commandCount: 0, integrity: { status: "clean" } },
      error: { code: "POLICY_DENIED", phase: "publication" },
    });
    expect(ports.process).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("keeps passed validation and confirmed PR evidence when checkpoint upload fails", async () => {
  ports.session.mockReturnValue(
    checkpointSession(() =>
      Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
    ),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    validation: { status: "passed", commandCount: 1 },
    writeStatus: "partial-success",
    pullRequestNumber: 123,
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(created.blob).toHaveBeenCalledOnce();
  expect(created.commit).toHaveBeenCalledOnce();
  expect(created.branch).toHaveBeenCalledOnce();
  expect(created.pull).toHaveBeenCalledOnce();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it.each([
  ["task", "pr-create"],
  ["task", "base-advanced"],
  ["implement", "pr-create"],
  ["implement", "base-advanced"],
] as const)(
  "retains a confirmed %s branch when %s fails before PR completion",
  async (operation, failure) => {
    if (operation === "implement") {
      await selectEntity("implement", "issue");
      const run = ports.runDsh.getMockImplementation();
      ports.runDsh.mockImplementation(async (...args) => {
        if (run === undefined) throw new Error("Missing model adapter");
        const result = await run(...args);
        return { ...result, output: { ...result.output, operation: "implement" } };
      });
    }
    const client = githubClientFixture(fixture);
    if (failure === "pr-create") {
      created.pull.mockRejectedValue(
        Object.assign(new Error("PR endpoint unavailable"), { status: 503 }),
      );
    } else {
      const getRef = client.rest.git.getRef;
      vi.spyOn(client.rest.git, "getRef").mockImplementation(async (parameters) => {
        const response = await getRef(parameters);
        if (created.branch.mock.calls.length > 0 && parameters?.ref === "heads/main") {
          return {
            ...response,
            data: { ...response.data, object: { ...response.data.object, sha: "e".repeat(40) } },
          };
        }
        return response;
      });
    }
    ports.client.mockReturnValue(client);
    const outcome = await runAction();
    expect(created.branch).toHaveBeenCalledOnce();
    const ref = created.branch.mock.calls[0]?.[0].ref;
    expect(ref).toBeTypeOf("string");
    expect(outcome).toMatchObject({
      conclusion: "failure",
      writeStatus: "partial-success",
      commitSha: commit,
      branchName: ref?.replace(/^refs\/heads\//u, ""),
      validation: { status: "passed", commandCount: 1 },
      error: { code: failure === "pr-create" ? "ACTION_RUNTIME_FAILED" : "ENTITY_BINDING_CHANGED" },
    });
    expect(outcome.pullRequestNumber).toBeUndefined();
    expect(created.pull).toHaveBeenCalledTimes(failure === "pr-create" ? 1 : 0);
    expect(ports.runDsh).toHaveBeenCalledOnce();
    await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
  },
);

it("does not report a branch when its creation and reconciliation cannot confirm it", async () => {
  created.branch.mockRejectedValue(
    Object.assign(new Error("Branch endpoint unavailable"), { status: 503 }),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    error: { code: "ACTION_RUNTIME_FAILED" },
  });
  expect(outcome.writeStatus).toBeUndefined();
  expect(outcome.branchName).toBeUndefined();
  expect(outcome.commitSha).toBeUndefined();
  expect(created.branch).toHaveBeenCalledOnce();
  expect(created.pull).not.toHaveBeenCalled();
  expect(ports.runDsh).toHaveBeenCalledOnce();
});

it("retains the confirmed PR when final progress publication fails without a Session", async () => {
  vi.stubEnv("GITHUB_EVENT_NAME", "issues");
  vi.stubEnv("INPUT_PROGRESS-COMMENT", "true");
  await writeFile(
    join(fixtureRoot, "event.json"),
    JSON.stringify({
      action: "opened",
      issue: { number: 7 },
      sender: { login: "alice" },
      repository: {
        id: 1,
        name: "repo",
        full_name: "octo/repo",
        default_branch: "main",
        owner: { login: "octo" },
      },
    }),
  );
  const comment = vi.fn(() => Promise.reject(new Error("Comment transport failed")));
  ports.client.mockReturnValue(
    githubClientFixture({
      ...fixture,
      rest: {
        ...fixture.rest,
        issues: {
          get: () =>
            Promise.resolve({
              data: {
                id: 301,
                number: 7,
                title: "Create hello.txt",
                body: "Implement the change",
                user: { id: 101, login: "alice" },
                state: "open",
                updated_at: "2026-10-10T00:00:00Z",
              },
            }),
          listComments: () => Promise.resolve({ data: [], headers: {} }),
          createComment: comment,
        },
      },
      paginate: () => Promise.resolve([]),
    }),
  );
  const outcome = await runAction();
  expect(outcome.error).toBeUndefined();
  expect(outcome).toMatchObject({
    conclusion: "success",
    writeStatus: "success",
    pullRequestNumber: 123,
    validation: { status: "passed" },
  });
  expect(created.pull).toHaveBeenCalledOnce();
  expect(comment).toHaveBeenCalled();
});

it("publishes a current-head review and projects selected inline and summary-only findings", async () => {
  await selectEntity("review", "pull_request");
  ports.runDsh.mockResolvedValue(reviewWorkerResult());
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "review",
    findingsCount: 2,
    publication: { selected: 2, inlinePublished: 1, summaryOnly: 1, failures: [] },
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(published.inline).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      pull_number: 7,
      commit_id: base,
      path: "src/value.ts",
      line: 2,
      side: "RIGHT",
    }),
  );
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  const summaryBody = record(published.comment.mock.calls[0]?.[0]).body;
  expect(summaryBody).toContain("Related source needs attention");
  expect(summaryBody).not.toContain("Uncertain observation");
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("publishes a bounded CI diagnosis from failed checks through the real read lifecycle", async () => {
  await selectEntity("diagnose", "pull_request");
  const result = readonlyWorkerResult("final");
  ports.runDsh.mockResolvedValue({
    ...result,
    output: {
      ...result.output,
      operation: "diagnose",
      summary: "CI diagnosis completed",
      diagnosis: "The required check failed because the new branch skipped validation.",
      findings: reviewFindings.slice(0, 1),
    },
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "diagnose",
    findingsCount: 1,
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(ports.runDsh.mock.calls[0]?.[0].prompt).toContain("FAILED_CHECK_MARKER");
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  expect(record(published.comment.mock.calls[0]?.[0]).body).toContain(
    "DeepSeek Harness CI diagnosis",
  );
  expect(published.inline).not.toHaveBeenCalled();
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["controlled", "native"] as const)(
  "completes a %s write task with no repository changes and preserves its public output",
  async (mode) => {
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv(
      "INPUT_TASK-OUTPUT-SCHEMA",
      '{"type":"object","properties":{"needsChange":{"type":"boolean"}},"required":["needsChange"],"additionalProperties":false}',
    );
    const result = readonlyWorkerResult("final", mode);
    ports.runDsh.mockResolvedValue({
      ...result,
      output: { ...result.output, taskOutput: { needsChange: false } },
    });
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "success",
      operation: "task",
      writeStatus: "no-changes",
      changedPaths: [],
      taskOutput: { needsChange: false },
      validation: { status: "not-applicable", commandCount: 0, integrity: { status: "clean" } },
      authority: {
        schemaVersion: 1,
        scope: "action-known-sources",
        knownSources: [
          {
            kind: "controller-credential",
            service: "github",
            holder: "controller",
            credentialExposure: "not-exposed-to-worker",
          },
          {
            kind: "controller-credential",
            service: "deepseek",
            holder: "controller",
            credentialExposure: "not-exposed-to-worker",
            mediation: "run-scoped-proxy",
          },
        ],
      },
    });
    if (mode === "native") {
      expect(outcome.dsh).toEqual({ mode: "native", composition: "dsh-native-headless" });
      expect(outcome.permission?.network).toBe("bridge");
      expect(outcome.toolPolicy).toEqual({
        schemaVersion: 1,
        policyOwner: "dsh",
        observedTools: ["grep", "read"],
      });
    } else {
      expect(outcome.toolPolicy).toMatchObject({
        schemaVersion: 1,
        policyOwner: "controller",
        requestedTools: [
          "native.web-fetch",
          "native.web-search",
          "workspace.edit",
          "workspace.read",
          "workspace.search",
        ],
        effectiveTools: [
          "native.web-fetch",
          "native.web-search",
          "workspace.edit",
          "workspace.read",
          "workspace.search",
        ],
        deniedTools: [],
      });
    }
    const outputs = buildActionOutputs(outcome);
    for (const surface of [
      JSON.stringify(outcome),
      String(outputs["result-json"]),
      formatStepSummary(outcome),
    ]) {
      for (const secret of [controllerDeepSeekKey, controllerGitHubToken]) {
        expect(surface).not.toContain(secret);
        expect(surface).not.toContain(createHash("sha256").update(secret).digest("hex"));
      }
    }
    expect(ports.process).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("answers an Issue write task with no changes using a tracked comment instead of a PR", async () => {
  await selectEntity("task", "issue");
  vi.stubEnv("INPUT_PROGRESS-COMMENT", "true");
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("final"));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    writeStatus: "no-changes",
    changedPaths: [],
    commentId: 901,
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  expect(record(published.comment.mock.calls[0]?.[0]).body).toContain(
    "<!-- dsh-action:v1 kind=task -->",
  );
  expect(ports.process).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("retains confirmed review publication when a later checkpoint upload fails", async () => {
  await selectEntity("review", "pull_request");
  ports.runDsh.mockResolvedValue(reviewWorkerResult());
  const save = vi.fn(() =>
    Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
  );
  ports.session.mockReturnValue(checkpointSession(save));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    publication: { selected: 2, inlinePublished: 1, summaryOnly: 1, failures: [] },
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(published.inline).toHaveBeenCalledOnce();
  expect(published.comment).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["summary-503", "head-advanced"] as const)(
  "retains confirmed inline review publication after %s",
  async (failure) => {
    await selectEntity("review", "pull_request");
    ports.runDsh.mockResolvedValue(reviewWorkerResult());
    const client = githubClientFixture(fixture);
    if (failure === "summary-503") {
      published.comment.mockRejectedValue(
        Object.assign(new Error("Summary endpoint unavailable"), { status: 503 }),
      );
    } else {
      const getPull = client.rest.pulls.get;
      vi.spyOn(client.rest.pulls, "get").mockImplementation(async (parameters) => {
        const response = await getPull(parameters);
        if (published.inline.mock.calls.length > 0) {
          return {
            ...response,
            data: { ...response.data, head: { ...response.data.head, sha: "e".repeat(40) } },
          };
        }
        return response;
      });
    }
    ports.client.mockReturnValue(client);
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "failure",
      operation: "review",
      publication: { selected: 2, inlinePublished: 1, inlineUpdated: 0 },
      error: { phase: "publication", code: "ACTION_RUNTIME_FAILED" },
    });
    expect(published.inline).toHaveBeenCalledOnce();
    expect(published.comment).toHaveBeenCalledTimes(failure === "summary-503" ? 1 : 0);
    expect(ports.runDsh).toHaveBeenCalledOnce();
  },
);

it("retains an already published no-change answer when its Session checkpoint fails", async () => {
  await selectEntity("task", "issue");
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("final"));
  ports.session.mockReturnValue(
    checkpointSession(() =>
      Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
    ),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    operation: "task",
    commentId: 901,
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(published.comment).toHaveBeenCalledOnce();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("implements an Issue through validation and projects its newly created PR", async () => {
  await selectEntity("implement", "issue");
  const run = ports.runDsh.getMockImplementation();
  ports.runDsh.mockImplementation(async (...args) => {
    if (run === undefined) throw new Error("Missing model adapter");
    const result = await run(...args);
    return { ...result, output: { ...result.output, operation: "implement" } };
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "implement",
    writeStatus: "success",
    pullRequestNumber: 123,
    pullRequestUrl: "https://github.com/octo/repo/pull/123",
    validation: { status: "passed", commandCount: 1 },
  });
  expect(created.blob).toHaveBeenCalledOnce();
  expect(created.commit).toHaveBeenCalledOnce();
  expect(created.branch).toHaveBeenCalledOnce();
  expect(created.pull).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ base: "main" }));
  expect(record(created.pull.mock.calls[0]?.[0]).body).toContain("#7");
  expect(created.updateBranch).not.toHaveBeenCalled();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it.each([false, true])(
  "projects a confirmed PR-head fix when final comment failure=%s",
  async (commentFails) => {
    await selectEntity("fix", "pull_request");
    const run = ports.runDsh.getMockImplementation();
    ports.runDsh.mockImplementation(async (...args) => {
      if (run === undefined) throw new Error("Missing model adapter");
      const result = await run(...args);
      return { ...result, output: { ...result.output, operation: "fix" } };
    });
    if (commentFails)
      published.comment.mockRejectedValue(new Error("Final status comment unavailable"));
    const outcome = await runAction();
    expect(outcome.error).toBeUndefined();
    expect(outcome).toMatchObject({
      conclusion: "success",
      operation: "fix",
      writeStatus: commentFails ? "partial-success" : "success",
      commitSha: commit,
      changedPaths: ["hello.txt"],
      validation: { status: "passed", commandCount: 1 },
    });
    expect(created.updateBranch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ref: "heads/feature", sha: commit, force: false }),
    );
    expect(created.commit).toHaveBeenCalledOnce();
    expect(created.branch).not.toHaveBeenCalled();
    expect(created.pull).not.toHaveBeenCalled();
    expect(published.comment).toHaveBeenCalledOnce();
    await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
  },
);

it("retains a published diagnosis when its Session checkpoint fails", async () => {
  await selectEntity("diagnose", "pull_request");
  const worker = readonlyWorkerResult("final");
  ports.runDsh.mockResolvedValue({
    ...worker,
    output: { ...worker.output, operation: "diagnose", diagnosis: "The check failed." },
  });
  ports.session.mockReturnValue(
    checkpointSession(() =>
      Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
    ),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    operation: "diagnose",
    commentId: 901,
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(published.comment).toHaveBeenCalledOnce();
  expect(ports.process).not.toHaveBeenCalled();
});

it("carries a custom Profile protection from Action input to the final GitHub write gate", async () => {
  vi.stubEnv("INPUT_DSH-PROFILE", "config/harness");
  vi.stubEnv("INPUT_ALLOWED-TOOLS", "");
  const profileFiles = [
    {
      path: "package.json",
      sha: "f".repeat(40),
      content: JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    },
    { path: "cordis.patch.yml", sha: "1".repeat(40), content: "[]" },
  ];
  ports.client.mockReturnValue(
    githubClientFixture({
      ...fixture,
      rest: {
        ...fixture.rest,
        git: {
          ...fixture.rest?.git,
          getTree: ({ tree_sha, recursive }: { tree_sha: string; recursive?: string }) =>
            Promise.resolve({
              data: {
                sha: tree_sha,
                truncated: false,
                tree:
                  recursive !== undefined
                    ? profileFiles.map((file) => ({
                        path: "config/harness/" + file.path,
                        sha: file.sha,
                        type: "blob",
                        mode: "100644",
                        size: Buffer.byteLength(file.content),
                      }))
                    : tree_sha === tree
                      ? [{ path: "config", sha: "d".repeat(40), type: "tree", mode: "040000" }]
                      : tree_sha === "d".repeat(40)
                        ? [{ path: "harness", sha: "e".repeat(40), type: "tree", mode: "040000" }]
                        : profileFiles.map((file) => ({
                            path: file.path,
                            sha: file.sha,
                            type: "blob",
                            mode: "100644",
                            size: Buffer.byteLength(file.content),
                          })),
              },
            }),
          getBlob: ({ file_sha }: { file_sha: string }) => {
            const file = profileFiles.find((file) => file.sha === file_sha);
            if (file === undefined) throw new Error("Unexpected blob");
            return Promise.resolve({
              data: {
                sha: file.sha,
                encoding: "base64",
                size: Buffer.byteLength(file.content),
                content: Buffer.from(file.content).toString("base64"),
              },
            });
          },
        },
      },
    }),
  );
  ports.runDsh.mockImplementation(async (request) => {
    if (request.workspacePath === undefined) throw new Error("Missing worker workspace");
    await writeFile(join(request.workspacePath, "config/harness/cordis.patch.yml"), "[]\n");
    return readonlyWorkerResult("final");
  });
  const outcome = await runAction();
  expect(outcome.conclusion).toBe("failure");
  expect(outcome.error?.message).toContain("Protected path");
  expect(ports.runDsh).toHaveBeenCalledOnce();
  expect(created.blob).not.toHaveBeenCalled();
  expect(created.commit).not.toHaveBeenCalled();
});
