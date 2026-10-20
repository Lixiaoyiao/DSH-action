import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";

import { prepareControlledProfile } from "../src/dsh/controlled-profile.js";
import { startDeepSeekProxy, type DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import { messageToolResults, sendMessagesSse } from "./fixtures/messages-sse.mjs";

const execFileAsync = promisify(execFile);
const fixtureNames = ["solid.png", "solid.jpg", "solid.webp", "solid.gif"] as const;
const requestSchema = z.looseObject({
  model: z.string(),
  messages: z.array(z.looseObject({ content: z.unknown().optional() })),
  tools: z.array(z.looseObject({ name: z.string() })),
});
const imageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
});
const resultSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string() })),
});

async function runImages(textOnly: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dsh-controlled-images-"));
  const dshHome = join(root, "home");
  const workspace = join(root, "workspace");
  const names = textOnly ? fixtureNames.slice(0, 1) : fixtureNames;
  const originals = new Map<string, Buffer>();
  const requests: z.infer<typeof requestSchema>[] = [];
  const serverErrors: unknown[] = [];
  let filesRequests = 0;
  let proxy: DeepSeekProxyHandle | undefined;
  const task = "Read the repository image fixtures using the official read_image tool.";
  const output = {
    protocolVersion: 2,
    operation: "task",
    state: "final",
    summary: textOnly ? "image route refused" : "images read",
    findings: [],
  };
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/files") {
      // The production proxy must deny this route before reaching the upstream.
      filesRequests++;
      request.resume();
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.method !== "POST" || request.url !== "/anthropic/v1/messages") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push(body);
      const count = messageToolResults(body).length;
      const name = names[count];
      if (name !== undefined) {
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: `image-${String(count)}`,
                type: "function",
                function: {
                  name: "read_image",
                  arguments: JSON.stringify({ file_path: join(workspace, name) }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
    })().catch((error: unknown) => {
      serverErrors.push(error);
      response.writeHead(500).end("controlled image fixture failed");
    });
  });
  try {
    await mkdir(workspace);
    for (const name of names) {
      const bytes = await readFile(join(process.cwd(), "test/fixtures/images", name));
      originals.set(name, bytes);
      await writeFile(join(workspace, name), bytes);
    }
    const plan = resolveExtensionPlan({
      allowedTools: [],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "controlled image integration",
        capabilities: {
          readRepository: true,
          readCi: false,
          publishComments: false,
          executeRepositoryCode: false,
          loadExtensions: false,
          accessNetwork: false,
          modifyWorkspace: false,
          commit: false,
          push: false,
          createPullRequest: false,
          manageIssueLabels: false,
          manageIssueAssignees: false,
          updateIssueState: false,
          updatePullRequestMetadata: false,
        },
      },
    });
    const profile = await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools: ["workspace.read"],
      workspaceWrite: false,
      expectedOperation: "task",
      task,
      workerWorkspacePath: workspace,
      policyPluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-policy.mjs")).href,
      workspacePluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-workspace.mjs"))
        .href,
      workerStatePath: join(dshHome, "action-state", "counts.json"),
      workerAttachmentHome: join(dshHome, "attachments"),
      workerAuditPath: join(dshHome, "action-state", "receipts.jsonl"),
      manifestBase: z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile("package.json", "utf8"))),
    });
    if (textOnly) {
      const patch = z
        .array(z.unknown())
        .parse(JSON.parse(await readFile(profile.patchPath, "utf8")));
      patch.push({
        id: "llm-deepseek",
        config: { models: [{ id: "deepseek-flash", inputModalities: ["text"] }] },
      });
      await writeFile(profile.patchPath, JSON.stringify(patch));
    }
    // The positive case uses the unmodified official default deepseek-flash
    // catalog, which explicitly declares text and image input in 0.2.1-rc.2.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    proxy = await startDeepSeekProxy({
      apiKey: "controller-image-fixture-key",
      baseUrl: "https://api.deepseek.com",
      fetchImplementation: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.origin).toBe("https://api.deepseek.com");
        expect(new Headers(init?.headers).get("x-api-key")).toBe("controller-image-fixture-key");
        return await fetch(`http://127.0.0.1:${String(address.port)}${url.pathname}`, init);
      },
    });
    const result = await execFileAsync(
      process.execPath,
      ["--expose-internals", join(process.cwd(), "assets/dsh/action-launcher.mjs"), task],
      {
        cwd: workspace,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: dshHome,
          DSH_HOME: dshHome,
          DSH_PERMISSION_MODE: "read-only",
          DSH_TOOLS_MODE: "native",
          DSH_TELEMETRY_DISABLED: "1",
          NARB_DISABLE_NATIVE_CACHE: "1",
          DEEPSEEK_API_KEY: proxy.workerToken,
          DEEPSEEK_BASE_URL: proxy.workerBaseUrl,
        },
      },
    );
    expect(serverErrors).toEqual([]);
    expect(result.stderr).toBe("");
    expect(requests).toHaveLength(names.length + 1);
    for (const request of requests) {
      expect(request.model).toBe("deepseek-flash");
      expect(request.tools.map(({ name }) => name).sort()).toEqual(["read", "read_image"]);
    }
    const toolResults = z.array(resultSchema).parse(messageToolResults(requests.at(-1) ?? {}));
    expect(toolResults).toHaveLength(names.length);
    if (textOnly) {
      expect(toolResults[0]?.is_error).toBe(true);
      expect(JSON.stringify(toolResults[0])).toContain(
        "does not declare image input; switch to an image-capable model",
      );
      expect(filesRequests).toBe(0);
      expect(
        toolResults.flatMap(({ content }) => content.filter(({ type }) => type === "image")),
      ).toEqual([]);
    } else {
      expect(filesRequests).toBe(0);
      const storedRoot = join(dshHome, "attachments", "attachments", "v1");
      const storedFiles = await readdir(storedRoot, { recursive: true, withFileTypes: true });
      const storedBytes = await Promise.all(
        storedFiles
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(join(entry.parentPath, entry.name))),
      );
      for (const [index, toolResult] of toolResults.entries()) {
        expect(toolResult.tool_use_id).toBe(`image-${String(index)}`);
        expect(toolResult.is_error).not.toBe(true);
        const blocks = toolResult.content.filter(({ type }) => type === "image");
        expect(blocks).toHaveLength(1);
        const image = imageBlockSchema.parse(blocks[0]);
        const bytes = Buffer.from(image.source.data, "base64");
        expect(image.source.data).toBe(bytes.toString("base64"));
        expect(bytes.length).toBeGreaterThan(20);
        expect(storedBytes.some((stored) => stored.equals(bytes))).toBe(true);
        const hash = createHash("sha256").update(bytes).digest("hex");
        expect(JSON.stringify(toolResult)).toContain(`sha256:${hash}`);
        const name = names[index];
        expect(name).toBeDefined();
        if (name !== undefined && name !== "solid.gif")
          expect(bytes.equals(originals.get(name) ?? Buffer.alloc(0))).toBe(true);
        // GIF may be normalized by DSH; the wire must contain actual raster
        // bytes from its durable AttachmentStore, never a path-only summary.
        expect(["image/png", "image/jpeg", "image/webp", "image/gif"]).toContain(
          image.source.media_type,
        );
      }
    }
    const receipts = (await readFile(join(dshHome, "action-state", "receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .looseObject({
            phase: z.string(),
            id: z.string(),
            runtimeName: z.string(),
            ok: z.boolean(),
          })
          .parse(JSON.parse(line)),
      );
    const completed = receipts.filter(({ phase }) => phase === "completed");
    expect(completed).toHaveLength(names.length);
    for (const receipt of completed)
      expect(receipt).toMatchObject({
        id: "workspace.read",
        runtimeName: "read_image",
        ok: !textOnly,
      });
    const final = result.stdout
      .trim()
      .split("\n")
      .map((line) =>
        z.looseObject({ type: z.string(), text: z.string().optional() }).parse(JSON.parse(line)),
      )
      .at(-1);
    expect(final).toEqual({ type: "final", text: JSON.stringify(output) });
  } finally {
    await proxy?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

it(
  "sends PNG, JPEG, WebP and GIF through the real Controlled read_image, AttachmentStore and default Messages route",
  () => runImages(false),
  70_000,
);
it(
  "reports the official image-capability error without reading or uploading an image on a text-only route",
  () => runImages(true),
  70_000,
);
