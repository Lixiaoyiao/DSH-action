import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";

import { prepareControlledProfile } from "../src/dsh/controlled-profile.js";
import { buildDshPrompt } from "../src/dsh/prompt.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { sendMessagesSse } from "./fixtures/messages-sse.mjs";

it("waits through a parent acknowledgement and returns the managed child's completed answer", async () => {
  const temporaryBase = process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir();
  const root = await mkdtemp(join(temporaryBase, "dsh-controlled-subagent-"));
  const dshHome = join(root, "home");
  const workspace = join(root, "workspace");
  const requestSchema = z.looseObject({
    messages: z.array(z.looseObject({ content: z.unknown().optional() })),
    tools: z.array(z.looseObject({ name: z.string() })),
  });
  const requests: z.infer<typeof requestSchema>[] = [];
  const errors: unknown[] = [];
  let parentReplies = 0;
  let childResponse: ServerResponse | undefined;
  let waiting = false;
  const waitingText = "Waiting for the subagent.";
  const childAnswer = "CONTROLLED_CHILD_DONE";
  const output = {
    protocolVersion: 2,
    operation: "task",
    state: "final",
    summary: childAnswer,
    findings: [],
  };
  const releaseChild = () => {
    if (waiting && childResponse !== undefined) {
      sendMessagesSse(childResponse, { content: childAnswer }, "stop");
      childResponse = undefined;
    }
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") {
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
      if (JSON.stringify(body.messages[0]).includes(`Return ${childAnswer}`)) {
        childResponse = response;
        releaseChild();
        return;
      }
      parentReplies += 1;
      if (parentReplies === 1) {
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "controlled-child",
                type: "function",
                function: {
                  name: "subagent",
                  arguments: JSON.stringify({
                    description: "Managed child",
                    prompt: `Return ${childAnswer}`,
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else if (parentReplies === 2) {
        expect(JSON.stringify(body.messages)).toContain("started subagent");
        // Hold the child response until the parent has ended its turn. This
        // exercises the actual Headless idle/wake path, not a fast-child race.
        sendMessagesSse(response, { content: waitingText }, "stop");
        waiting = true;
        releaseChild();
      } else {
        const transcript = JSON.stringify(body.messages);
        expect(transcript).toContain(waitingText);
        expect(transcript).toContain("Its closing message:");
        expect(transcript).toContain(childAnswer);
        sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
      }
    })().catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500).end("controlled subagent fixture failed");
    });
  });
  try {
    await mkdir(workspace);
    const plan = resolveExtensionPlan({
      allowedTools: [],
      mcp: { schemaVersion: 1, servers: [] },
      plugins: { schemaVersion: 1, bundles: [], plugins: [] },
      allowPluginInstall: false,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "managed subagent integration",
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
    const task = buildDshPrompt({
      operation: "task",
      trust: "trusted-read",
      nativeTools: ["native.subagent"],
      prompt: "{}",
      trustedInstructions: "Delegate one child and wait for its result, then return task JSON.",
    });
    await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools: ["native.subagent"],
      workspaceWrite: false,
      expectedOperation: "task",
      task,
      workerWorkspacePath: workspace,
      policyPluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-policy.mjs")).href,
      workspacePluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-workspace.mjs"))
        .href,
      workerStatePath: join(dshHome, "action-state", "counts.json"),
      workerAuditPath: join(dshHome, "action-state", "receipts.jsonl"),
      manifestBase: z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile("package.json", "utf8"))),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const result = await promisify(execFile)(
      process.execPath,
      ["--expose-internals", join(process.cwd(), "assets/dsh/action-launcher.mjs"), task],
      {
        cwd: workspace,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: dshHome,
          DSH_HOME: dshHome,
          DSH_PERMISSION_MODE: "read-only",
          DSH_TOOLS_MODE: "native",
          DSH_TELEMETRY_DISABLED: "1",
          NARB_DISABLE_NATIVE_CACHE: "1",
          DEEPSEEK_API_KEY: "subagent-fixture-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
        },
      },
    );
    expect(errors).toEqual([]);
    expect(result.stderr).toBe("");
    expect(parentReplies).toBe(3);
    expect(requests).toHaveLength(4);
    for (const request of requests)
      expect(request.tools.map(({ name }) => name)).toEqual(["subagent"]);
    const final = z
      .looseObject({ type: z.string(), text: z.string() })
      .parse(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""));
    expect(final).toEqual({ type: "final", text: JSON.stringify(output) });
    const receipts = (await readFile(join(dshHome, "action-state", "receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .looseObject({ phase: z.string(), id: z.string(), ok: z.boolean() })
          .parse(JSON.parse(line)),
      );
    expect(receipts.filter(({ phase }) => phase === "completed")).toEqual([
      expect.objectContaining({ id: "native.subagent", ok: true }),
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 70_000);
