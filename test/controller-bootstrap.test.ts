import { join } from "node:path";
import { expect, it } from "vitest";
import { executeBoundedDshProcess } from "../src/dsh/process.js";
import { parseControllerBootstrap } from "../assets/dsh/action-controller.mjs";
import { dockerWorkerSpec } from "../src/dsh/docker-policy.js";
import { fakeProxy } from "./helpers/dsh-runner-fixtures.js";

it("consumes and closes one-time bootstrap before a child can inspect its parent", async () => {
  const token = "A".repeat(43);
  const url = "http://127.0.0.1:54321/action/mcp";
  const input = JSON.stringify({
    token,
    url,
    tools: ["mcp__action-controller__command_check"],
    timeoutMs: 10_000,
  });
  const result = await executeBoundedDshProcess(
    {
      command: process.execPath,
      args: [join(process.cwd(), "test/fixtures/controller-bootstrap-worker.mjs")],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      input,
    },
    {
      timeoutMs: 10_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 4096,
      maxCombinedBytes: 68 * 1024,
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    accepted: 1,
    inputClosed: true,
    child: { parentInputClosed: true, environmentClean: true, commandClean: true },
  });
  expect(result.stdout).not.toContain(token);
  expect(result.stdout).not.toContain(url);
});

it("rejects an oversized or malformed bootstrap", () => {
  expect(() => parseControllerBootstrap("x".repeat(65_537))).toThrow(/limit/u);
  expect(() => parseControllerBootstrap("{}")).toThrow(/invalid/u);
});

it("passes Docker bootstrap over stdin with no capability in argv or initial environment", () => {
  const token = "A".repeat(43);
  const url = "http://172.30.0.1:54321/action/mcp";
  const input = JSON.stringify({ token, url, tools: [], timeoutMs: 10_000 });
  const spec = dockerWorkerSpec({
    containerImage: "node:24-bookworm",
    workspace: process.cwd(),
    dshHome: process.cwd(),
    packageRoot: process.cwd(),
    launchPlan: { command: "node", args: ["launcher.mjs"], workdir: "/workspace", mounts: [] },
    networkName: "fixture",
    hostGateway: "172.30.0.1",
    environment: {},
    workerEnvironment: { DSH_ACTION_CONTROLLER_INPUT: "1" },
    workspaceWrite: false,
    input,
    proxy: {
      ...fakeProxy(),
      controllerBridge: {
        token,
        url,
        toolNames: [],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        close: () => Promise.resolve(),
        throwIfFailed: () => undefined,
      },
    },
  });
  expect(spec.input).toBe(input);
  expect(spec.args).toContain("-i");
  expect(spec.args).toContain("DSH_ACTION_CONTROLLER_INPUT=1");
  const exposed = JSON.stringify([spec.args, spec.env, spec.termination]);
  expect(exposed).not.toContain(token);
  expect(exposed).not.toContain(url);
});
