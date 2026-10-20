import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDsh } from "../src/dsh/runner.js";
import type { ToolProvider } from "../src/agent/contracts.js";
import { sendMessagesSse } from "./fixtures/messages-sse.mjs";
import { mcpPublicToolName } from "../src/extensions/plan.js";
import { PolicyDeniedError } from "../src/errors.js";
import { dshFailureTelemetry } from "../src/dsh/errors.js";
import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runtime.js";
import { NativeComposition, writeNativeProfile } from "../src/dsh/native-composition.js";
import { emptyNativeExtensionPlan } from "../src/extensions/plan.js";
import { readDshManifest } from "../src/dsh/composition-files.js";
import { startDeepSeekProxy } from "../src/dsh/proxy.js";
import { buildDshWorkerEnvironment } from "../src/security/env.js";
import { decodeHeadlessResult } from "../src/dsh/headless-output.js";
import { parseDshOutput } from "../src/dsh/schema.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";
import { parseControllerBootstrap } from "../assets/dsh/action-controller.mjs";
import { DEFAULT_CONTAINER_IMAGE } from "../src/action-contract.js";
import { DSH_VERSION } from "../src/release.js";

/** Exercise the native carrier locally without replacing the official launcher. */
async function runNativeCarrier(provider: ToolProvider, workspace: string, baseUrl: string) {
  const runtime = await createDshRuntime(workspace);
  const proxy = await startDeepSeekProxy({
    apiKey: "model-fixture-secret",
    baseUrl,
    controllerTools: provider,
    workspacePath: workspace,
    deadlineMs: Date.now() + 45_000,
  });
  try {
    const bridge = proxy.controllerBridge;
    if (bridge === undefined) throw new Error("native fixture has no Controller bridge");
    await writeNativeProfile({
      profileRoot: runtime.packageRoot,
      manifestBase: await readDshManifest("package.json"),
      plan: emptyNativeExtensionPlan(),
    });
    // Adapt only the Linux attachment mount path for this local carrier test.
    await writeFile(
      join(runtime.packageRoot, "cordis.patch.yml"),
      JSON.stringify([
        { id: "attachment-local", config: { dshHome: join(runtime.dshHome, "attachments") } },
      ]),
    );
    const environment = buildDshWorkerEnvironment({
      dshHome: runtime.dshHome,
      permissionMode: "read-only",
      proxyBaseUrl: proxy.workerBaseUrl,
      proxyToken: proxy.workerToken,
      realDeepSeekApiKey: "model-fixture-secret",
    });
    environment.DSH_ACTION_CONTROLLER_INPUT = "1";
    const input = JSON.stringify({
      url: bridge.url,
      token: bridge.token,
      tools: bridge.toolNames,
      timeoutMs: bridge.timeoutMs,
    });
    const result = await executeBoundedDshProcess(
      {
        command: process.execPath,
        args: [
          "--expose-internals",
          join(process.cwd(), "assets/dsh/native-launcher.mjs"),
          "Call the Controller check tool and return protocolVersion 2 final task JSON.",
        ],
        cwd: workspace,
        env: environment,
        input,
      },
      {
        timeoutMs: 45_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024,
        maxCombinedBytes: 2 * 1024 * 1024,
      },
    );
    bridge.throwIfFailed();
    expect(result.stdout).not.toContain(bridge.token);
    expect(result.stdout).not.toContain(bridge.url);
    return {
      output: parseDshOutput(
        decodeHeadlessResult(result.stdout, [bridge.token, bridge.url, proxy.workerToken]).text,
        "task",
      ),
    };
  } finally {
    await proxy.close();
    await disposeDshRuntime(runtime);
  }
}

interface CarrierCase {
  readonly mode: "controlled" | "native";
  readonly fatal: boolean;
  readonly isolation: "none" | "docker";
}

async function assertControllerCarrier({ mode, fatal, isolation }: CarrierCase) {
  if (isolation === "docker")
    expect(process.platform, "The explicit Docker regression requires Linux").toBe("linux");
  const workspace = await mkdtemp(
    join(
      process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir(),
      "controller-mcp-loop-",
    ),
  );
  const name = mcpPublicToolName("action-controller", "command.check");
  let requests = 0;
  let bootstrapCount = 0;
  const privateBootstrap: string[] = [];
  const failures: unknown[] = [];
  const controllerFailure = new PolicyDeniedError("Current authority was revoked");
  const invoke = vi.fn<ToolProvider["invoke"]>().mockImplementation((call) => {
    if (fatal) return Promise.reject(controllerFailure);
    return Promise.resolve({ ...call, ok: true, output: { stdout: "CONTROLLER_CHECK_DONE" } });
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const text = Buffer.concat(chunks).toString("utf8");
      for (const secret of privateBootstrap) expect(text).not.toContain(secret);
      if (text.includes("Generate the session title from this JSON array of human messages")) {
        sendMessagesSse(response, { content: "Controller check" }, "stop");
        return;
      }
      requests += 1;
      if (invoke.mock.calls.length === 0) {
        expect(text).toContain(name);
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "controller-tool",
                type: "function",
                function: { name, arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        if (!fatal) expect(text).toContain("CONTROLLER_CHECK_DONE");
        sendMessagesSse(
          response,
          {
            content: JSON.stringify({
              protocolVersion: 2,
              operation: "task",
              state: "final",
              summary: "Controller check complete",
              findings: [],
            }),
          },
          "stop",
        );
      }
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing model fixture port");
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [
        {
          id: "command.check",
          provider: "command",
          description: "Check",
          permissions: ["execute"],
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      invoke,
    };
    const running =
      mode === "native" && isolation === "none"
        ? runNativeCarrier(provider, workspace, `http://127.0.0.1:${String(address.port)}`)
        : runDsh(
            {
              operation: "task",
              prompt: "{}",
              trustedInstructions:
                "Call the provided Controller check tool, then return the result.",
              trust: "trusted-read",
              isolation,
              workspacePath: workspace,
              timeoutMs: isolation === "docker" ? 480_000 : 45_000,
              maxOutputBytes: 2 * 1024 * 1024,
              apiKey: "model-fixture-secret",
              baseUrl: `http://127.0.0.1:${String(address.port)}`,
              webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
              dshVersion: DSH_VERSION,
              containerImage: DEFAULT_CONTAINER_IMAGE,
              nativeTools: [],
              controllerTools: provider,
            },
            {
              ...(isolation === "docker" ? { environment: { PATH: process.env.PATH } } : {}),
              ...(mode === "native" ? { composition: new NativeComposition() } : {}),
              executeProcess: async (spec, limits) => {
                const grant =
                  spec.input === undefined ? undefined : parseControllerBootstrap(spec.input);
                if (grant !== undefined) {
                  bootstrapCount += 1;
                  privateBootstrap.push(grant.token, grant.url);
                  const exposed = JSON.stringify([spec.args, spec.env]);
                  expect(exposed).not.toContain(grant.token);
                  expect(exposed).not.toContain(grant.url);
                  if (isolation === "docker") {
                    expect(spec.command).toBe("docker");
                    expect(spec.args).toContain("-i");
                    expect(spec.args).toContain("DSH_ACTION_CONTROLLER_INPUT=1");
                  } else expect(spec.env.DSH_ACTION_CONTROLLER_INPUT).toBe("1");
                }
                const result = await executeBoundedDshProcess(spec, limits);
                if (grant !== undefined) {
                  for (const secret of [grant.token, grant.url]) {
                    expect(result.stdout).not.toContain(secret);
                    expect(result.stderr).not.toContain(secret);
                  }
                }
                return result;
              },
            },
          );
    if (fatal) {
      await expect(running).rejects.toBe(controllerFailure);
      expect(dshFailureTelemetry(controllerFailure)?.isolationReport.backend).toBe("none");
      expect(invoke).toHaveBeenCalledTimes(1);
      return;
    }
    const result = await running;
    expect(failures).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(result.output.summary).toBe("Controller check complete");
    if (isolation === "docker") {
      expect(bootstrapCount).toBe(1);
      expect(result).toMatchObject({
        isolationReport: {
          backend: "docker",
          credentialMediated: true,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-only",
        },
      });
      if (mode === "native")
        expect(result).toHaveProperty("observedTools", expect.arrayContaining([name]));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it.each([
  { mode: "controlled", fatal: false, isolation: "none" },
  { mode: "controlled", fatal: true, isolation: "none" },
  { mode: "native", fatal: false, isolation: "none" },
] as const)(
  "runs the real $mode carrier and preserves fatal identity=$fatal",
  assertControllerCarrier,
  60_000,
);

describe.skipIf(process.env.DSH_E2E_IMAGE_DOCKER !== "1")(
  "production Docker Controller MCP",
  () => {
    it.each(["controlled", "native"] as const)(
      "returns the Controller result to the real %s model through the isolated Docker worker",
      async (mode) => assertControllerCarrier({ mode, fatal: false, isolation: "docker" }),
      570_000,
    );
  },
);
