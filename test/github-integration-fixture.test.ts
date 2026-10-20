import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  controllerToolName,
  controllerToolReply,
} from "../.github/e2e/controller-tool-fixture.mjs";
import { mcpPublicToolName } from "../src/extensions/plan.js";
import { githubToolSchema } from "../src/tools/schema.js";

const fixtureKey = "dsh-github-fixture-test-key";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-github-fixture-"));
  const audit = join(root, "audit.jsonl");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../.github/e2e/github-integration-llm.mjs", import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        DSH_E2E_GITHUB_AUDIT: audit,
        DSH_E2E_FIXTURE_KEY: fixtureKey,
        DSH_E2E_ISSUE_LABEL: "fixture-label",
        DSH_E2E_ISSUE_ASSIGNEE: "fixture-assignee",
        DSH_E2E_PULL_TITLE: "fixture pull title",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = async () => {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 20_000);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          resolve(output.split("\n")[0] ?? "");
        }
      });
      child.once("error", reject);
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Fixture exited before its endpoint was available"));
      });
    });
    return { ...z.looseObject({ origin: z.string() }).parse(JSON.parse(endpoint)), audit, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("trusted GitHub integration provider fixture", () => {
  it.each(["chat/completions", "v1/messages"])(
    "preserves typed routes and the title-call boundary with %s",
    async (endpoint) => {
      const server = await fixture();
      const messagesProtocol = endpoint === "v1/messages";
      try {
        const histories = new Map<string, Record<string, unknown>[]>();
        const request = async (route: string, title = false) => {
          const history = title ? [] : (histories.get(route) ?? []);
          const response = await fetch(`${server.origin}/${route}/${endpoint}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${fixtureKey}`,
              "content-type": "application/json",
              ...(messagesProtocol ? { "x-api-key": fixtureKey } : {}),
            },
            body: JSON.stringify({
              system: [{ type: "text", text: "Trusted fixture system marker" }],
              messages: [
                {
                  role: "user",
                  content: title
                    ? "Generate the session title"
                    : [{ type: "text", text: "Bound fixture task" }],
                },
                ...history,
              ],
              tools: githubToolSchema.options.map((id) =>
                messagesProtocol
                  ? {
                      name: controllerToolName(id),
                      description: id,
                      input_schema: { type: "object" },
                    }
                  : {
                      type: "function",
                      function: {
                        name: controllerToolName(id),
                        description: id,
                        parameters: { type: "object" },
                      },
                    },
              ),
              stream: true,
            }),
          });
          expect(response.status).toBe(200);
          const frames = (await response.text()).trim().split("\n\n");
          let content: string | undefined;
          let call: { id: string; name: string; arguments: string } | undefined;
          if (!messagesProtocol) {
            expect(frames).toHaveLength(3);
            expect(frames[2]).toBe("data: [DONE]");
            const first = z
              .looseObject({
                choices: z.array(
                  z.looseObject({
                    delta: z.looseObject({
                      content: z.string().optional(),
                      tool_calls: z
                        .array(
                          z.object({
                            id: z.string(),
                            function: z.object({ name: z.string(), arguments: z.string() }),
                          }),
                        )
                        .optional(),
                    }),
                  }),
                ),
              })
              .parse(JSON.parse(frames[0]?.slice("data: ".length) ?? "null"));
            const delta = first.choices[0]?.delta;
            content = delta?.content;
            const tool = delta?.tool_calls?.[0];
            if (tool !== undefined) call = { id: tool.id, ...tool.function };
          } else {
            const events = frames.map((frame) => {
              const [name, data] = frame.split("\n");
              const event = z
                .looseObject({
                  type: z.string(),
                  delta: z
                    .looseObject({
                      text: z.string().optional(),
                      partial_json: z.string().optional(),
                      stop_reason: z.string().optional(),
                    })
                    .optional(),
                  content_block: z
                    .looseObject({ id: z.string().optional(), name: z.string().optional() })
                    .optional(),
                })
                .parse(JSON.parse(data?.slice("data: ".length) ?? "null"));
              expect(name).toBe(`event: ${event.type}`);
              return event;
            });
            expect(events.map((event) => event.type)).toEqual([
              "message_start",
              "content_block_start",
              "content_block_delta",
              "content_block_stop",
              "message_delta",
              "message_stop",
            ]);
            content = events[2]?.delta?.text;
            const block = events[1]?.content_block;
            if (block?.id !== undefined && block.name !== undefined)
              call = {
                id: block.id,
                name: block.name,
                arguments: events[2]?.delta?.partial_json ?? "{}",
              };
            expect(events[4]?.delta?.stop_reason).toBe(
              call === undefined ? "end_turn" : "tool_use",
            );
          }
          if (call !== undefined) {
            const invocation = call;
            const input = z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments));
            const id = githubToolSchema.options.find(
              (id) => controllerToolName(id) === invocation.name,
            );
            if (id === undefined)
              throw new Error("Fixture requested an unregistered Controller tool");
            const value = JSON.stringify({
              callId: `controller-${call.id}`,
              id,
              ok: true,
              output: { effect: id === "github.checks.read" ? "read" : "scheduled" },
            });
            history.push(
              messagesProtocol
                ? {
                    role: "assistant",
                    content: [
                      {
                        type: "tool_use",
                        id: call.id,
                        name: call.name,
                        input,
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      },
                    ],
                  },
            );
            history.push(
              messagesProtocol
                ? {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: call.id,
                        content: [{ type: "text", text: value }],
                      },
                    ],
                  }
                : { role: "tool", tool_call_id: call.id, content: value },
            );
            histories.set(route, history);
            return { call: { name: call.name, input } };
          }
          return z
            .union([z.string(), z.record(z.string(), z.unknown())])
            .parse(JSON.parse(content ?? "null"));
        };
        for (const route of ["label", "assignee"]) {
          expect(await request(route)).toMatchObject({
            protocolVersion: 2,
            operation: "task",
            state: "final",
            taskOutput: { route, accepted: true },
          });
        }
        for (const id of [
          "github.issue.labels.set",
          "github.issue.assignees.set",
          "github.comment.create",
          "github.issue.state.update",
        ]) {
          expect(await request("github")).toMatchObject({
            call: { name: controllerToolName(id) },
          });
        }
        expect(await request("github")).toMatchObject({ state: "final" });
        expect(await request("metadata")).toMatchObject({
          call: {
            name: controllerToolName("github.pull.metadata.update"),
            input: { title: "fixture pull title" },
          },
        });
        expect(await request("metadata")).toMatchObject({ state: "final" });
        expect(await request("native-checks", true)).toBe("Native qualification");
        for (const route of ["checks", "native-checks"]) {
          expect(await request(route)).toMatchObject({
            call: { name: controllerToolName("github.checks.read") },
          });
          expect(await request(route)).toMatchObject({ operation: "diagnose", state: "final" });
        }
        expect(await request("native-write")).toMatchObject({ operation: "task", state: "final" });
        const audit = (await readFile(server.audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) =>
            z
              .looseObject({
                authorizationMatches: z.boolean(),
                prompt: z.string(),
                route: z.string(),
                kind: z.string(),
                index: z.number(),
              })
              .parse(JSON.parse(line)),
          );
        expect(audit).toHaveLength(15);
        expect(audit.every((entry) => entry.authorizationMatches)).toBe(true);
        expect(audit.every((entry) => entry.prompt.includes("Trusted fixture system marker"))).toBe(
          true,
        );
        expect(audit.some((entry) => entry.prompt.includes(fixtureKey))).toBe(false);
        expect(
          audit
            .filter((entry) => entry.route === "native-checks")
            .map((entry) => [entry.kind, entry.index]),
        ).toEqual([
          ["title", 0],
          ["agent", 1],
          ["agent", 2],
        ]);
      } finally {
        await server.close();
      }
    },
  );
  it("uses the pinned MCP name mapping and refuses missing schemas or missing results", () => {
    for (const id of githubToolSchema.options)
      expect(controllerToolName(id)).toBe(mcpPublicToolName("action-controller", id));
    const plan = [{ id: "github.checks.read", input: {} }];
    expect(() => controllerToolReply({ messages: [] }, "checks", 1, plan)).toThrow(
      /real admitted MCP tool schema/u,
    );
    expect(() => controllerToolReply({ messages: [] }, "checks", 2, plan)).toThrow(
      /complete single-loop tool history/u,
    );
  });
});
