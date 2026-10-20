import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

import { sendMessages } from "./messages-fixture.mjs";
import { businessReply } from "./business-fixture.mjs";
import { controllerToolReply } from "./controller-tool-fixture.mjs";

const auditPath = process.env.DSH_E2E_GITHUB_AUDIT;
const expectedKey = process.env.DSH_E2E_FIXTURE_KEY;
const issueLabel = process.env.DSH_E2E_ISSUE_LABEL;
const issueAssignee = process.env.DSH_E2E_ISSUE_ASSIGNEE;
const pullTitle = process.env.DSH_E2E_PULL_TITLE;
if (!auditPath) throw new Error("DSH_E2E_GITHUB_AUDIT is required");
if (!expectedKey) throw new Error("DSH_E2E_FIXTURE_KEY is required");
if (!issueLabel) throw new Error("DSH_E2E_ISSUE_LABEL is required");
if (!issueAssignee) throw new Error("DSH_E2E_ISSUE_ASSIGNEE is required");
if (!pullTitle) throw new Error("DSH_E2E_PULL_TITLE is required");

const calls = new Map();

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("fixture request exceeded 2 MiB");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

function messageText(body) {
  return [{ content: body.system }, ...(body.messages ?? [])]
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((block) =>
        block && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
      );
    })
    .join("\n");
}

function finalTask(route) {
  return {
    protocolVersion: 2,
    operation: "task",
    state: "final",
    summary: `Deterministic ${route} route completed.`,
    findings: [],
    taskOutput: { route, accepted: true },
  };
}

function fixtureMessage(route, index, body) {
  if (["github", "metadata", "checks", "native-checks"].includes(route)) {
    const requests =
      route === "github"
        ? [
            {
              id: "github.issue.labels.set",
              input: { labels: [issueLabel] },
              reason: "Exercise the Controller-owned exact label replacement path.",
            },
            {
              id: "github.issue.assignees.set",
              input: { assignees: [issueAssignee] },
              reason: "Exercise the Controller-owned exact assignee replacement path.",
            },
            {
              id: "github.comment.create",
              input: { body: "DSH E2E typed GitHub tool completed for @maintainers." },
              reason: "Exercise the Controller-owned reconciled comment path.",
            },
            {
              id: "github.issue.state.update",
              input: { state: "closed", stateReason: "completed" },
              reason: "Exercise the Controller-owned bounded Issue state path last.",
            },
          ]
        : route === "metadata"
          ? [{ id: "github.pull.metadata.update", input: { title: pullTitle } }]
          : [{ id: "github.checks.read", input: {} }];
    const call = controllerToolReply(body, route, index, requests);
    if (call !== undefined) return call;
  }
  if (route === "label" || route === "assignee" || route === "github") {
    return { role: "assistant", content: JSON.stringify(finalTask(route)) };
  }
  if (route === "native-write") {
    return {
      role: "assistant",
      content: JSON.stringify({
        protocolVersion: 2,
        operation: "task",
        state: "final",
        summary: "Native trusted-write workspace qualification completed without changes.",
        findings: [],
      }),
    };
  }
  if (route === "checks" || route === "native-checks") {
    return {
      role: "assistant",
      content: JSON.stringify({
        protocolVersion: 2,
        operation: "diagnose",
        state: "final",
        summary: "Deterministic check/status read completed.",
        findings: [],
        diagnosis: "The typed Controller check/status response was available as bounded data.",
      }),
    };
  }
  if (route === "metadata") {
    return {
      role: "assistant",
      content: JSON.stringify({
        protocolVersion: 2,
        operation: "task",
        state: "final",
        summary: "Deterministic pull request metadata update completed.",
        findings: [],
      }),
    };
  }
  throw new Error(`unexpected fixture route: ${route}`);
}

function sendSse(response, message, messagesProtocol) {
  const content = message.content;
  const toolCalls = message.tool_calls;
  const finishReason = toolCalls ? "tool_calls" : "stop";
  if (messagesProtocol) {
    sendMessages(
      response,
      toolCalls
        ? toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: JSON.parse(call.function.arguments),
          }))
        : [{ type: "text", text: content }],
      true,
    );
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: toolCalls ? { tool_calls: toolCalls } : { content }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  const match =
    /^\/(label|assignee|github|metadata|checks|native-write|native-checks|review|fix|implement)\/(?:(?:v1\/)?chat\/completions|v1\/messages)$/u.exec(
      request.url ?? "",
    );
  if (request.method !== "POST" || match === null) {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  const route = match[1];
  const messagesProtocol = request.url.endsWith("/v1/messages");
  const authorizationMatches =
    request.headers.authorization === `Bearer ${expectedKey}` &&
    (messagesProtocol
      ? request.headers["x-api-key"] === expectedKey
      : request.headers["x-api-key"] === undefined);
  readJson(request)
    .then(async (body) => {
      const prompt = messageText(body);
      const titleRequest =
        route.startsWith("native-") && prompt.includes("Generate the session title");
      const index = titleRequest ? 0 : (calls.get(route) ?? 0) + 1;
      const business = ["review", "fix", "implement"].includes(route)
        ? businessReply(route, index, body, {
            fixturePath: process.env.DSH_E2E_FIXTURE_PATH,
            implementationPath: process.env.DSH_E2E_IMPLEMENTATION_PATH,
            suffix: process.env.DSH_E2E_RUN_SUFFIX,
          })
        : undefined;
      if (!titleRequest) calls.set(route, index);
      await appendFile(
        auditPath,
        `${JSON.stringify({
          route,
          index,
          kind: titleRequest ? "title" : "agent",
          authorizationMatches,
          ...(business ? { phase: business.phase } : {}),
          prompt,
        })}\n`,
        "utf8",
      );
      sendSse(
        response,
        business?.message ??
          (titleRequest
            ? { role: "assistant", content: JSON.stringify("Native qualification") }
            : fixtureMessage(route, index, body)),
        messagesProtocol,
      );
    })
    .catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  process.stdout.write(`${JSON.stringify({ origin, healthUrl: `${origin}/health` })}\n`);
});

function close() {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
