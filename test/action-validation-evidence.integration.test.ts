import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type * as DshModule from "../src/dsh/runner.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as ProcessModule from "../src/security/argv.js";
import { DshAbortedError } from "../src/dsh/errors.js";
import { runAction } from "../src/orchestrator.js";
import { loadInputs } from "../src/inputs.js";
import { WorkspaceValidation } from "../src/write/workspace-validation.js";
import { createWorkspaceSnapshot } from "../src/write/workspace.js";
import { actionLifecycleGitHub } from "./helpers/action-lifecycle-github.js";
import { githubClientFixture } from "./helpers/github-client.js";

// Only external GitHub, worker and process transport. Validation and lifecycle stay real.
const ports = vi.hoisted(() => ({
  client: vi.fn(),
  worker: vi.fn<typeof DshModule.runDsh>(),
  process: vi.fn<typeof ProcessModule.runCommand>(),
}));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof GitHubClientModule>()),
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
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["controlled", "native"] as const)(
  "keeps %s no-change validation unexecuted when cancellation reaches the pre-command integrity phase",
  async (mode) => {
    const { github } = await configuredAction(
      Object.fromEntries(
        Array.from(
          { length: 64 },
          (_, index) => [`file-${String(index)}.txt`, "unchanged\n"] as const,
        ),
      ),
    );
    vi.stubEnv("INPUT_DSH-MODE", mode);
    vi.stubEnv("INPUT_PROMPT", "Confirm the files require no change");
    vi.stubEnv("INPUT_TEST-COMMANDS", '[["node","--version"]]');
    const controller = new AbortController();
    ports.worker.mockImplementationOnce(() => {
      // An external cancellation arrives while the real finalizer inspects unchanged files.
      setTimeout(() => controller.abort(new DshAbortedError()), 0);
      return Promise.resolve({
        output: {
          protocolVersion: 1,
          operation: "task",
          state: "final",
          summary: "No change needed",
          findings: [],
        },
        durationMs: 1,
        isolationReport: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: true,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-write",
          extensionProfile: mode === "native" ? "headless-native" : "github-action",
          limitations: [],
        },
        ...(mode === "native" ? { observedTools: ["read", "grep"] } : {}),
      });
    });
    const outcome = await runAction({ signal: controller.signal });
    expect(ports.worker).toHaveBeenCalledOnce();
    expect(ports.process).not.toHaveBeenCalled();
    expect(
      outcome,
      JSON.stringify({
        executedCommands: ports.process.mock.calls.length,
        validation: outcome.validation,
      }),
    ).toMatchObject({
      conclusion: "failure",
      error: { code: "DSH_ABORTED", phase: "validation" },
      validation: { status: "not-applicable", commandCount: 0 },
    });
    for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
    expect(github.published.comment).not.toHaveBeenCalled();
  },
);

async function configuredAction(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "dsh-validation-evidence-"));
  roots.push(root);
  const eventPath = join(root, "event.json");
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
    GITHUB_WORKSPACE: root,
    "INPUT_DEEPSEEK-API-KEY": "synthetic-controller-key",
    "INPUT_GITHUB-TOKEN": "synthetic-github-token",
    INPUT_COMMAND: "task",
    INPUT_PROMPT: "Implement the change",
    "INPUT_TASK-ACCESS": "write",
    "INPUT_ALLOW-WRITE": "true",
    "INPUT_PROGRESS-COMMENT": "false",
    "INPUT_TEST-COMMANDS": '[["npm","test"]]',
    "INPUT_ALLOWED-TOOLS": '["workspace.read","workspace.edit"]',
    "INPUT_MAX-TURNS": "1",
  }))
    vi.stubEnv(name, value);
  const base = "a".repeat(40),
    tree = "b".repeat(40);
  const entries = Object.entries(files).map(([path, content], index) => ({
    path,
    content,
    sha: String(index + 1).padStart(40, "0"),
  }));
  const github = actionLifecycleGitHub({
    base,
    tree,
    commit: "d".repeat(40),
    permission: () => "write",
  });
  ports.client.mockReturnValue(
    githubClientFixture({
      ...github.transport,
      rest: {
        ...github.transport.rest,
        git: {
          ...github.transport.rest.git,
          getTree: () =>
            Promise.resolve({
              data: {
                sha: tree,
                truncated: false,
                tree: entries.map(({ path, content, sha }) => ({
                  path,
                  sha,
                  type: "blob",
                  mode: "100644",
                  size: Buffer.byteLength(content),
                })),
              },
            }),
          getBlob: ({ file_sha }: { file_sha: string }) => {
            const file = entries.find(({ sha }) => sha === file_sha);
            if (file === undefined) throw new Error("Unknown synthetic blob");
            return Promise.resolve({
              data: {
                sha: file.sha,
                encoding: "base64",
                content: Buffer.from(file.content).toString("base64"),
              },
            });
          },
        },
      },
    }),
  );
  return { root, github };
}

function finalWriteResponse(): DshModule.DshRunResult {
  return {
    output: {
      protocolVersion: 1,
      operation: "task",
      state: "final",
      summary: "Updated validation script",
      findings: [],
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

it("reports zero candidate commands when strict integrity blocks before execution", async () => {
  vi.stubEnv("INPUT_VALIDATION-INTEGRITY", "strict");
  const { github } = await configuredAction({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
  });
  ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
    if (workspacePath === undefined) throw new Error("Missing worker workspace");
    await writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: "true" } }),
    );
    return finalWriteResponse();
  });
  const outcome = await runAction();
  expect(ports.process).not.toHaveBeenCalled();
  expect(
    outcome,
    JSON.stringify({
      executedCommands: ports.process.mock.calls.length,
      validation: outcome.validation,
    }),
  ).toMatchObject({
    conclusion: "failure",
    error: { code: "VALIDATION_INTEGRITY", phase: "validation" },
    validation: { status: "failed", commandCount: 0, integrity: { status: "blocked" } },
  });
  for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["deadline", "cancelled"] as const)(
  "does not report configured commands when Gateway preparation is %s",
  async (failure) => {
    const { root } = await configuredAction({});
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const workspace = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      join(root, "worker"),
    );
    const controller = new AbortController();
    if (failure === "cancelled") controller.abort(new DshAbortedError());
    const gate = new WorkspaceValidation({
      workspace,
      configuration: {
        runTests: loadInputs().runTests,
        commands: loadInputs().testCommands,
        containerImage: loadInputs().containerImage,
      },
      integrityMode: loadInputs().validationIntegrity,
      onPhase: () => undefined,
      deadlineMs: Date.now() + (failure === "deadline" ? -1 : 30_000),
      signal: controller.signal,
    });
    await expect(gate.validate()).rejects.toMatchObject({
      name: failure === "deadline" ? "AgentDeadlineError" : "DshAbortedError",
    });
    expect(ports.process).not.toHaveBeenCalled();
    expect(gate.snapshot().status).toBe("failed");
    expect(
      gate.snapshot().commandCount,
      "Gateway failed before any candidate process was dispatched",
    ).toBe(0);
  },
);

const passedCommand: ProcessModule.CommandResult = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};

it.each(["passed", "failed", "cancelled"] as const)(
  "reports real candidate invocation count when a three-command suite is %s",
  async (completion) => {
    const { github } = await configuredAction({});
    vi.stubEnv("INPUT_TEST-COMMANDS", '[["node","one"],["node","two"],["node","three"]]');
    ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
      if (workspacePath === undefined) throw new Error("Missing worker workspace");
      await writeFile(join(workspacePath, "hello.txt"), "hello\n");
      return finalWriteResponse();
    });
    let invocations = 0;
    ports.process.mockImplementation(({ args }) => {
      if (args[0] === "rm") return Promise.resolve(passedCommand);
      invocations += 1;
      if (invocations === 2 && completion === "cancelled") throw new DshAbortedError();
      return Promise.resolve(
        invocations === 2 && completion === "failed"
          ? { ...passedCommand, exitCode: 1, stderr: "failed" }
          : passedCommand,
      );
    });
    const outcome = await runAction();
    expect(invocations).toBe(completion === "passed" ? 3 : 2);
    expect(outcome).toMatchObject({
      conclusion: completion === "passed" ? "success" : "failure",
      validation: {
        status: completion === "passed" ? "passed" : "failed",
        commandCount: completion === "passed" ? 3 : 2,
      },
      ...(completion === "passed"
        ? {}
        : {
            error: {
              code: completion === "cancelled" ? "DSH_ABORTED" : "VALIDATION_FAILED",
              phase: "validation",
            },
          }),
    });
    if (completion !== "passed") {
      expect(ports.process.mock.calls.filter(([{ args }]) => args[0] === "rm")).toHaveLength(1);
      for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
    }
  },
);

it("keeps failed baseline replay evidence separate from zero candidate invocations", async () => {
  const original = JSON.stringify({ scripts: { test: "vitest run" } });
  const { github } = await configuredAction({ "package.json": original });
  vi.stubEnv("INPUT_VALIDATION-INTEGRITY", "strict");
  ports.worker.mockImplementationOnce(async ({ workspacePath }) => {
    if (workspacePath === undefined) throw new Error("Missing worker workspace");
    await writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run --coverage" } }),
    );
    return finalWriteResponse();
  });
  ports.process.mockImplementation(async ({ args, cwd }) => {
    if (args[0] === "rm") return passedCommand;
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))).toEqual(
      JSON.parse(original),
    );
    return { ...passedCommand, exitCode: 1, stderr: "original suite failed" };
  });
  const outcome = await runAction();
  expect(ports.process.mock.calls.filter(([{ args }]) => args[0] === "run")).toHaveLength(1);
  expect(outcome).toMatchObject({
    conclusion: "failure",
    error: { code: "VALIDATION_INTEGRITY" },
    validation: {
      status: "failed",
      commandCount: 0,
      integrity: { status: "blocked", baselineReplay: { status: "failed", commandCount: 1 } },
    },
  });
  for (const effect of Object.values(github.created)) expect(effect).not.toHaveBeenCalled();
});

it("preserves a passed Gateway revision without dispatching the same suite again", async () => {
  const { root } = await configuredAction({});
  const source = join(root, "source");
  await mkdir(source);
  const workspace = await createWorkspaceSnapshot(
    { kind: "materialized-tree", root: source },
    join(root, "worker"),
  );
  const gate = new WorkspaceValidation({
    workspace,
    configuration: {
      runTests: loadInputs().runTests,
      commands: loadInputs().testCommands,
      containerImage: loadInputs().containerImage,
    },
    integrityMode: loadInputs().validationIntegrity,
    onPhase: () => undefined,
    deadlineMs: Date.now() + 30_000,
    signal: new AbortController().signal,
  });
  ports.process.mockResolvedValue(passedCommand);
  await gate.validate();
  await gate.validate();
  expect(ports.process).toHaveBeenCalledOnce();
  expect(gate.snapshot()).toMatchObject({ status: "passed", commandCount: 1 });
});

it("restores passed Gateway evidence when a failed candidate returns to the validated revision", async () => {
  const { root } = await configuredAction({});
  vi.stubEnv("INPUT_TEST-COMMANDS", '[["node","one"],["node","two"]]');
  const source = join(root, "source");
  await mkdir(source);
  const workspace = await createWorkspaceSnapshot(
    { kind: "materialized-tree", root: source },
    join(root, "worker"),
  );
  const gate = new WorkspaceValidation({
    workspace,
    configuration: {
      runTests: loadInputs().runTests,
      commands: loadInputs().testCommands,
      containerImage: loadInputs().containerImage,
    },
    integrityMode: loadInputs().validationIntegrity,
    onPhase: () => undefined,
    deadlineMs: Date.now() + 30_000,
    signal: new AbortController().signal,
  });
  ports.process.mockImplementation(({ args }) =>
    Promise.resolve(
      args[0] === "rm" || ports.process.mock.calls.length <= 2
        ? passedCommand
        : { ...passedCommand, exitCode: 1 },
    ),
  );
  await gate.validate();
  await writeFile(join(workspace.workerRoot, "candidate.txt"), "candidate\n");
  await expect(gate.validate()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(gate.snapshot().status).toBe("failed");
  expect(gate.snapshot().commandCount).toBe(1);
  await rm(join(workspace.workerRoot, "candidate.txt"));
  const processCalls = ports.process.mock.calls.length;
  await gate.validate();
  expect(ports.process).toHaveBeenCalledTimes(processCalls);
  expect(gate.snapshot()).toMatchObject({
    status: "passed",
    commandCount: 2,
    integrity: { status: "clean" },
  });
});
