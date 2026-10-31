import { afterEach, expect, it } from "vitest";
import { runDsh } from "../src/dsh/runner.js";
import {
  createDshFixtureManager,
  request,
  fakeProxy,
  networkInspectResult,
} from "./helpers/dsh-runner-fixtures.js";
const manager = createDshFixtureManager();
afterEach(manager.dispose);
it.each([true, false])(
  "uses the explicit Worker network switch %s independently of extensions",
  async (workerNetwork) => {
    const fixture = await manager.fixtures();
    const networks: string[][] = [];
    await runDsh(
      request({
        isolation: "docker",
        workspacePath: fixture.workspace,
        workerNetwork,
        nativeTools: [],
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: async () => fakeProxy(),
        executeProcess: async (spec) => {
          if (spec.args[0] === "network" && spec.args[1] === "create")
            networks.push([...spec.args]);
          return (
            networkInspectResult(spec) ?? {
              stdout: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "done",
                findings: [],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            }
          );
        },
      },
    );
    expect(networks).toHaveLength(1);
    expect(networks[0]?.includes("--internal")).toBe(!workerNetwork);
  },
);
it("allows a twelve-minute Worker within a twenty-minute overall deadline", async () => {
  const fixture = await manager.fixtures();
  let clock = 1000;
  const result = await runDsh(
    request({
      isolation: "docker",
      workspacePath: fixture.workspace,
      timeoutMs: 1200000,
      deadlineMs: 1201000,
      nativeTools: [],
    }),
    {
      now: () => clock,
      assetsDirectory: fixture.assets,
      temporaryDirectory: fixture.root,
      startProxy: async () => fakeProxy(),
      executeProcess: async (spec, limits) => {
        if (spec.args.some((arg) => arg.endsWith("action-launcher.mjs"))) {
          expect(limits.timeoutMs).toBeGreaterThan(720000);
          clock += 720000;
        }
        return (
          networkInspectResult(spec) ?? {
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "review",
              state: "final",
              summary: "long task completed",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }
        );
      },
    },
  );
  expect(result.output.summary).toBe("long task completed");
});
