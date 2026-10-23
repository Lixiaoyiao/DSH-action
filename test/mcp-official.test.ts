import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { apply as applyOfficialMcpClient } from "@deepseek-ai/dsh-mcp-client";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpPublicToolName } from "../src/extensions/plan.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

describe("official @deepseek-ai/dsh-mcp-client rc.2", () => {
  let context: Context;

  beforeAll(async () => {
    context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await applyOfficialMcpClient(context, {
      transport: "stdio",
      serverName: "fixture",
      command: process.execPath,
      args: [fixture],
      env: {},
      cwd: process.cwd(),
      toolCallTimeoutMs: 200,
      failOnStartupError: true,
      reconnect: { enabled: false },
    });
  }, 20_000);

  afterAll(async () => {
    await context.fiber.dispose();
  });

  it("discovers and invokes a real stdio MCP tool through the official client", async () => {
    expect(context.tools.schemas().map(({ name }) => name)).toContain("mcp__fixture__add");
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>("action-mcp-add"),
      name: "mcp__fixture__add",
      arguments: { left: 19, right: 23 },
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "42" }],
    });
  });

  it("locks the Action mapping to rc.2 public-name normalization", () => {
    const expected = mcpPublicToolName("fixture", "admin.reset");
    expect(expected).toMatch(/^mcp__fixture__admin_reset_[0-9a-f]{12}$/u);
    expect(context.tools.schemas().map(({ name }) => name)).toContain(expected);
    const utf16Expected = mcpPublicToolName("fixture", "emoji.💥");
    expect(context.tools.schemas().map(({ name }) => name)).toContain(utf16Expected);
  });

  it("enforces the official MCP tool-call timeout", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>("action-mcp-timeout"),
      name: "mcp__fixture__slow",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/timed?\s*out|timeout/iu);
  });

  it("returns controlled failures after a server crashes with reconnect disabled", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>("action-mcp-crash"),
      name: "mcp__fixture__crash",
      arguments: {},
    });
    expect(result.isError).toBe(false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const afterCrash = await context.tools.execute({
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>("action-mcp-after-crash"),
      name: "mcp__fixture__add",
      arguments: { left: 1, right: 1 },
    });
    expect(afterCrash.isError).toBe(true);
  });
});

// Adapted from the official rc.2 dsh-mcp-client stateless HTTP fixture.
describe("official streamable-http transport", () => {
  let context: Context;
  let server: Server;
  let url: string;
  const authorization: (string | undefined)[] = [];
  const customHeaders: (string | string[] | undefined)[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    authorization.push(request.headers.authorization);
    customHeaders.push(request.headers["x-mcp-key"]);
    const mcp = new McpServer(
      { name: "dsh-action-http-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "shout",
      { description: "Upper-case text", inputSchema: { message: z.string() } },
      ({ message }) =>
        Promise.resolve({ content: [{ type: "text", text: message.toUpperCase() }] }),
    );
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK declares a string|undefined sessionId getter against its own exact-optional Transport interface.
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response);
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const redirect = /^\/redirect-(307|308)$/u.exec(request.url ?? "");
      if (redirect !== null) {
        request.resume();
        response.writeHead(Number(redirect[1]), { location: "/mcp" }).end();
        return;
      }
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    url = `http://127.0.0.1:${String(address.port)}/mcp`;
    context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await applyOfficialMcpClient(context, {
      transport: "streamable-http",
      serverName: "httpfixture",
      url,
      headers: {
        Authorization: "Bearer controlled-test-token",
        "X-MCP-Key": "same-origin-fixture-key",
      },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    });
  }, 20_000);

  afterAll(async () => {
    await context.fiber.dispose();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("invokes tools and forwards only configured headers", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>("action-http-shout"),
      name: "mcp__httpfixture__shout",
      arguments: { message: "controlled" },
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "CONTROLLED" }],
    });
    expect(authorization.length).toBeGreaterThan(0);
    expect(new Set(authorization)).toEqual(new Set(["Bearer controlled-test-token"]));
    expect(new Set(customHeaders)).toEqual(new Set(["same-origin-fixture-key"]));
  });

  it.each([307, 308])("preserves tool calls through same-origin %i redirects", async (status) => {
    const redirected = new Context();
    try {
      await redirected.plugin(SystemPrompt);
      await redirected.plugin(ToolRuntime);
      await applyOfficialMcpClient(redirected, {
        transport: "streamable-http",
        serverName: "redirectfixture",
        url: new URL(`/redirect-${String(status)}`, url).href,
        headers: {
          Authorization: "Bearer controlled-test-token",
          "X-MCP-Key": "same-origin-fixture-key",
        },
        toolCallTimeoutMs: 5_000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      });
      const result = await redirected.tools.execute({
        signal: new AbortController().signal,
        callId: brandString<ToolCallId>(`same-origin-${String(status)}`),
        name: "mcp__redirectfixture__shout",
        arguments: { message: "same origin" },
      });
      expect(result).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "SAME ORIGIN" }],
      });
      expect(new Set(customHeaders)).toEqual(new Set(["same-origin-fixture-key"]));
    } finally {
      await redirected.fiber.dispose();
    }
  });
});

describe("official MCP HTTP redirect confidentiality", () => {
  it.each([307, 308])(
    "sends no credentials or body to a cross-origin %i target",
    async (status) => {
      let originalRequests = 0;
      let targetRequests = 0;
      const originalCredentials: (string | string[] | undefined)[] = [];
      const target = createServer((request, response) => {
        targetRequests += 1;
        request.resume();
        response.writeHead(500).end("The untrusted redirect target must never receive a request");
      });
      await new Promise<void>((resolvePromise) => target.listen(0, "127.0.0.1", resolvePromise));
      const targetAddress = target.address();
      if (targetAddress === null || typeof targetAddress === "string")
        throw new Error("Expected TCP address");
      const original = createServer((request, response) => {
        originalRequests += 1;
        originalCredentials.push(request.headers["x-mcp-key"]);
        request.resume();
        response
          .writeHead(status, { location: `http://127.0.0.1:${String(targetAddress.port)}/mcp` })
          .end();
      });
      await new Promise<void>((resolvePromise) => original.listen(0, "127.0.0.1", resolvePromise));
      const originalAddress = original.address();
      if (originalAddress === null || typeof originalAddress === "string")
        throw new Error("Expected TCP address");
      const rejected = new Context();
      try {
        await rejected.plugin(SystemPrompt);
        await rejected.plugin(ToolRuntime);
        await expect(
          applyOfficialMcpClient(rejected, {
            transport: "streamable-http",
            serverName: "confidentialityfixture",
            url: `http://127.0.0.1:${String(originalAddress.port)}/mcp`,
            headers: { "X-MCP-Key": "synthetic-mcp-credential" },
            toolCallTimeoutMs: 5_000,
            failOnStartupError: true,
            reconnect: { enabled: false },
          }),
        ).rejects.toThrow("initial connection or tool synchronization failed");
        expect(originalRequests).toBeGreaterThan(0);
        expect(new Set(originalCredentials)).toEqual(new Set(["synthetic-mcp-credential"]));
        // No second-origin request means neither custom headers nor POST data can escape.
        expect(targetRequests).toBe(0);
      } finally {
        await rejected.fiber.dispose();
        await Promise.all(
          [original, target].map(
            (httpServer) =>
              new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise())),
          ),
        );
      }
    },
  );
});
