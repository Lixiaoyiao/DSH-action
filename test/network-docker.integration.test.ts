import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NativeComposition } from "../src/dsh/native-composition.js";
import { executeBoundedDshProcess, runDsh, type DshProcessSpec } from "../src/dsh/runner.js";
import { DSH_VERSION } from "../src/release.js";
import { messageToolResults, sendMessagesSse } from "./fixtures/messages-sse.mjs";

const readme =
  "https://raw.githubusercontent.com/Lixiaoyiao/DSH-action/721f8bbca2e122949fbe9c867ac59963b2cb2a59/README.md";
const image =
  "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const requestSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  messages: z.array(z.looseObject({ content: z.unknown().optional() })),
});

// The model fixture only asks the official DSH tool to fetch. Docker and the
// public README request are real; a model's final claim cannot satisfy this gate.
describe.skipIf(process.env.DSH_E2E_NETWORK_DOCKER !== "1")("production Worker egress", () => {
  it.each([
    { mode: "controlled", online: true, trust: "trusted-read" },
    { mode: "controlled", online: false, trust: "trusted-read" },
    { mode: "native", online: true, trust: "trusted-read" },
    { mode: "native", online: false, trust: "trusted-read" },
    { mode: "controlled", online: true, trust: "untrusted" },
  ] as const)(
    "$mode / network=$online / $trust",
    async ({ mode, online, trust }) => {
      const fetchEnabled = online && trust !== "untrusted";
      expect(process.platform).toBe("linux");
      const root = await mkdtemp(join(tmpdir(), "dsh-network-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const errors: unknown[] = [];
      const requests: z.infer<typeof requestSchema>[] = [];
      let worker: DshProcessSpec | undefined;
      let physicalProbe: string | undefined;
      const output = {
        protocolVersion: 1,
        operation: "task",
        state: "final",
        summary: "Network fixture complete",
        findings: [],
      };
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || !request.url?.endsWith("/messages"))
            throw new Error("Unexpected upstream route");
          expect(request.headers["x-api-key"]).toBe("controller-network-fixture-key");
          const chunks: Buffer[] = [];
          for await (const chunk of request)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          requests.push(body);
          if (physicalProbe === undefined) {
            if (worker === undefined) throw new Error("Worker specification missing");
            const name = worker.args[worker.args.indexOf("--name") + 1];
            if (name === undefined) throw new Error("Worker container identity missing");
            const script =
              "try { const r=await fetch(" +
              JSON.stringify(readme) +
              ",{signal:AbortSignal.timeout(7000)}); const text=await r.text(); console.log(r.ok && text.includes('create-dsh-action') ? 'reachable' : 'unexpected'); } catch { console.log('blocked'); }";
            const probe = await executeBoundedDshProcess(
              {
                command: "docker",
                args: ["exec", name, "node", "--input-type=module", "-e", script],
                cwd: workspace,
                env: { PATH: process.env.PATH ?? "" },
              },
              {
                timeoutMs: 10000,
                maxStdoutBytes: 4096,
                maxStderrBytes: 4096,
                maxCombinedBytes: 8192,
              },
            );
            expect(probe.exitCode).toBe(0);
            physicalProbe = probe.stdout.trim();
            expect(physicalProbe).toBe(online ? "reachable" : "blocked");
          }
          if (fetchEnabled && messageToolResults(body).length === 0) {
            expect(body.tools.map((tool) => tool.name)).toContain("web_fetch");
            sendMessagesSse(
              response,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "actual-web-fetch",
                    type: "function",
                    function: { name: "web_fetch", arguments: JSON.stringify({ url: readme }) },
                  },
                ],
              },
              "tool_calls",
            );
          } else {
            if (fetchEnabled) {
              const results = z
                .array(z.looseObject({ is_error: z.boolean().optional(), content: z.unknown() }))
                .parse(messageToolResults(body));
              expect(results[0]?.is_error).not.toBe(true);
              expect(JSON.stringify(results[0]?.content)).toContain("create-dsh-action");
            } else expect(body.tools.map((tool) => tool.name)).not.toContain("web_fetch");
            sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
          }
        })().catch((error: unknown) => {
          errors.push(error);
          response.writeHead(500).end("Network fixture failed");
        });
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing fixture port");
        const baseUrl = "http://127.0.0.1:" + String(address.port);
        const result = await runDsh(
          {
            operation: "task",
            prompt: "Fetch the public README with web_fetch, then return the required JSON.",
            workspacePath: workspace,
            trust,
            isolation: "docker",
            ...(online ? {} : { workerNetwork: false }),
            timeoutMs: 480000,
            maxOutputBytes: 4 * 1024 * 1024,
            apiKey: "controller-network-fixture-key",
            baseUrl,
            webSearchBaseUrl: baseUrl,
            dshVersion: DSH_VERSION,
            containerImage: image,
            nativeTools: ["native.web-fetch"],
          },
          {
            environment: { PATH: process.env.PATH },
            ...(mode === "native" ? { composition: new NativeComposition() } : {}),
            executeProcess: (spec, limits) => {
              if (
                spec.args.some(
                  (arg) =>
                    arg.endsWith("/action-launcher.mjs") || arg.endsWith("/native-launcher.mjs"),
                )
              )
                worker = spec;
              return executeBoundedDshProcess(spec, limits);
            },
          },
        );
        expect(errors).toEqual([]);
        expect(physicalProbe).toBe(online ? "reachable" : "blocked");
        expect(result.output).toEqual(output);
        expect(result.isolationReport.networkIsolated).toBe(!online);
        expect(requests.length).toBe(fetchEnabled ? 2 : 1);
        if (fetchEnabled && mode === "controlled")
          expect(result.toolReceipts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "native.web-fetch", completed: true, ok: true }),
            ]),
          );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    570000,
  );
});
