import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NativeComposition } from "../src/dsh/native-composition.js";
import { runDsh } from "../src/dsh/runner.js";
import { DSH_VERSION } from "../src/release.js";
import { messageToolResults, sendMessagesSse } from "./fixtures/messages-sse.mjs";

const imageNames = ["solid.png", "solid.jpg", "solid.webp", "solid.gif"] as const;
const containerImage =
  "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const requestSchema = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({ content: z.unknown().optional() })),
  tools: z.array(z.looseObject({ name: z.string() })),
});
const imageSchema = z.object({
  type: z.literal("image"),
  source: z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
});

// Explicit CI opt-in proves the production read-only root and home mounts.
// Host-only Headless tests cannot detect an attachment backend chmod on a
// read-only /dsh-home parent, which previously failed on actual Actions runners.
describe.skipIf(process.env.DSH_E2E_IMAGE_DOCKER !== "1")("production Docker images", () => {
  it.each(["controlled", "native"] as const)(
    "reads all four raster formats through %s with the real proxy and attachment backend",
    async (mode) => {
      expect(process.platform, "The explicit Docker regression requires Linux").toBe("linux");
      const root = await mkdtemp(join(tmpdir(), "dsh-images-docker-"));
      const workspace = join(root, "workspace");
      const originals = new Map<string, Buffer>();
      const requests: z.infer<typeof requestSchema>[] = [];
      const serverErrors: unknown[] = [];
      const unexpectedRoutes: string[] = [];
      const output = {
        protocolVersion: 1,
        operation: "task",
        state: "final",
        summary: "image bytes observed",
        findings: [],
      };
      const server = createServer((request, response) => {
        if (request.method !== "POST" || !request.url?.endsWith("/messages")) {
          unexpectedRoutes.push(request.url ?? "missing");
          request.resume();
          response.writeHead(404).end();
          return;
        }
        void (async () => {
          expect(request.headers["x-api-key"]).toBe("controller-docker-image-fixture-key");
          const chunks: Buffer[] = [];
          for await (const chunk of request)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          requests.push(body);
          const index = messageToolResults(body).length;
          const name = imageNames[index];
          if (name === undefined)
            sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
          else
            sendMessagesSse(
              response,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `docker-image-${String(index)}`,
                    type: "function",
                    function: {
                      name: "read_image",
                      arguments: JSON.stringify({ file_path: `/workspace/${name}` }),
                    },
                  },
                ],
              },
              "tool_calls",
            );
        })().catch((error: unknown) => {
          serverErrors.push(error);
          response.writeHead(500).end("Docker image fixture failed");
        });
      });
      try {
        await mkdir(workspace);
        for (const name of imageNames) {
          const bytes = await readFile(join(process.cwd(), "test/fixtures/images", name));
          originals.set(name, bytes);
          await writeFile(join(workspace, name), bytes);
        }
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing fixture port");
        const baseUrl = `http://127.0.0.1:${String(address.port)}`;
        const result = await runDsh(
          {
            operation: "task",
            prompt:
              "Read the four image fixtures through read_image, then return the final Action JSON contract.",
            workspacePath: workspace,
            trust: "trusted-read",
            isolation: "docker",
            timeoutMs: 480_000,
            maxOutputBytes: 4 * 1024 * 1024,
            apiKey: "controller-docker-image-fixture-key",
            baseUrl,
            webSearchBaseUrl: baseUrl,
            dshVersion: DSH_VERSION,
            containerImage,
            nativeTools: ["workspace.read"],
          },
          {
            environment: { PATH: process.env.PATH },
            ...(mode === "native" ? { composition: new NativeComposition() } : {}),
          },
        );
        expect(serverErrors).toEqual([]);
        expect(unexpectedRoutes).toEqual([]);
        expect(result.output).toEqual(output);
        expect(result.isolationReport).toMatchObject({
          backend: "docker",
          credentialMediated: true,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-only",
        });
        expect(requests).toHaveLength(imageNames.length + 1);
        expect(requests.every(({ model }) => model === "deepseek-flash")).toBe(true);
        expect(requests[0]?.tools.map(({ name }) => name)).toContain("read_image");
        const results = z
          .array(
            z.looseObject({
              tool_use_id: z.string(),
              is_error: z.boolean().optional(),
              content: z.array(z.looseObject({ type: z.string() })),
            }),
          )
          .parse(messageToolResults(requests.at(-1) ?? {}));
        expect(results).toHaveLength(imageNames.length);
        for (const [index, tool] of results.entries()) {
          expect(tool.tool_use_id).toBe(`docker-image-${String(index)}`);
          expect(tool.is_error, JSON.stringify(tool)).not.toBe(true);
          const blocks = tool.content.filter(({ type }) => type === "image");
          expect(blocks).toHaveLength(1);
          const image = imageSchema.parse(blocks[0]);
          const bytes = Buffer.from(image.source.data, "base64");
          expect(bytes.length).toBeGreaterThan(20);
          const name = imageNames[index];
          if (name !== undefined && name !== "solid.gif")
            expect(bytes.equals(originals.get(name) ?? Buffer.alloc(0))).toBe(true);
          expect(["image/png", "image/jpeg", "image/webp", "image/gif"]).toContain(
            image.source.media_type,
          );
        }
        if (mode === "controlled") {
          expect(result.toolReceipts).toHaveLength(imageNames.length);
          for (const receipt of result.toolReceipts ?? [])
            expect(receipt).toMatchObject({
              id: "workspace.read",
              runtimeName: "read_image",
              counted: true,
              completed: true,
              ok: true,
            });
        } else expect(result.observedTools).toContain("read_image");
        for (const name of imageNames)
          expect(await readFile(join(workspace, name))).toEqual(originals.get(name));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    570_000,
  );
});
