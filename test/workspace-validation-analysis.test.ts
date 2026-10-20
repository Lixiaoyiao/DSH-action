import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as graph from "../src/validation/validation-command-graph.js";
import type * as processTransport from "../src/security/argv.js";
import { runCommand } from "../src/security/argv.js";
import { createWorkspaceSnapshot, inspectWorkspaceChanges } from "../src/write/workspace.js";
import { WorkspaceValidation } from "../src/write/workspace-validation.js";

vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof processTransport>()),
  runCommand: vi.fn(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    }),
  ),
}));

it("analyzes one revision once across integrity inspection and baseline replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-analysis-"));
  const build = vi.spyOn(graph, "buildValidationCommandGraph");
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ scripts: { test: "node check.js" } }),
    );
    await writeFile(join(source, "check.js"), "process.exit(0);\n");
    const workspace = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      join(root, "worker"),
    );
    await writeFile(
      join(workspace.workerRoot, "package.json"),
      JSON.stringify({ scripts: { test: "node check.js --flag" } }),
    );
    const deadlineMs = Date.now() + 30_000;
    const owner = new WorkspaceValidation({
      workspace,
      configuration: {
        runTests: true,
        commands: [["npm", "test"]],
        containerImage: "docker.io/library/node:24@sha256:" + "a".repeat(64),
      },
      integrityMode: "strict",
    });
    const run = await owner.prepareWrite(await inspectWorkspaceChanges(workspace), { deadlineMs });
    await run();
    expect(owner.snapshot()).toMatchObject({
      status: "passed",
      integrity: { baselineReplay: { status: "passed" } },
    });
    expect(build).toHaveBeenCalledOnce();
    const prepared = await owner.prepareWrite(await inspectWorkspaceChanges(workspace), {
      deadlineMs,
    });
    expect(build).toHaveBeenCalledOnce();
    const processCalls = vi.mocked(runCommand).mock.calls.length;
    await writeFile(join(workspace.workerRoot, "check.js"), "process.exit(1);\n");
    await expect(prepared()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(vi.mocked(runCommand)).toHaveBeenCalledTimes(processCalls);
    const changed = await owner.prepareWrite(await inspectWorkspaceChanges(workspace), {
      deadlineMs,
    });
    await changed();
    expect(build).toHaveBeenCalledTimes(2);
  } finally {
    build.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
