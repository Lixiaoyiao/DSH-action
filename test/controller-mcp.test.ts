import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startDeepSeekProxy, type DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import type { ToolProvider } from "../src/agent/contracts.js";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as controller from "../assets/dsh/action-controller.mjs";

const handles: DeepSeekProxyHandle[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("Controller MCP tools", () => {
  it("deduplicates one MCP request without replaying the Controller effect", async () => {
    const invoke = vi
      .fn<ToolProvider["invoke"]>()
      .mockImplementation((call) =>
        Promise.resolve({ ...call, ok: true, output: { effect: "scheduled" } }),
      );
    const handle = await startDeepSeekProxy({
      apiKey: "controller-key",
      baseUrl: "https://api.deepseek.com",
      controllerTools: {
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
      },
    });
    handles.push(handle);
    const bridge = handle.controllerBridge;
    if (bridge === undefined) throw new Error("missing bridge");
    const invokeOnce = async () => {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: { name: "command.check", arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      return value;
    };
    const first = await invokeOnce();
    expect(await invokeOnce()).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("revokes a worker lease and drains an admitted call without disposing its borrowed provider", async () => {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const dispose = vi.fn(() => Promise.resolve());
    let aborted = false;
    const handle = await startDeepSeekProxy({
      apiKey: "controller-key",
      baseUrl: "https://api.deepseek.com",
      controllerTools: {
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
        dispose,
        invoke: async (call, context) => {
          context.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          started.resolve(undefined);
          await release.promise;
          return { ...call, ok: true, output: {} };
        },
      },
    });
    handles.push(handle);
    const bridge = handle.controllerBridge;
    if (bridge === undefined) throw new Error("missing bridge");
    const client = new Client({ name: "drain-contract", version: "1" });
    clients.push(client);
    await client.connect(
      // @ts-expect-error SDK transport's own optional accessor is incompatible with its Transport declaration under exactOptionalPropertyTypes.
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { authorization: `Bearer ${bridge.token}` } },
      }),
    );
    const calling = client.callTool({ name: "command.check", arguments: {} });
    await started.promise;
    let drained = false;
    const closing = bridge.close().then(() => {
      drained = true;
    });
    expect(aborted).toBe(true);
    expect(drained).toBe(false);
    release.resolve(undefined);
    await closing;
    expect((await calling).isError).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(() => bridge.throwIfFailed()).toThrow(/aborted/u);
    expect(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: { authorization: `Bearer ${bridge.token}` },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });

  it("registers real DSH tools and hides them from child Agents", async () => {
    const invoke = vi.fn<ToolProvider["invoke"]>().mockImplementation((call) =>
      Promise.resolve({
        ...call,
        ok: false,
        output: { exitCode: 1, stderr: "repairable" },
      }),
    );
    const handle = await startDeepSeekProxy({
      apiKey: "controller-key",
      baseUrl: "https://api.deepseek.com",
      controllerTools: {
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
      },
    });
    handles.push(handle);
    const bridge = handle.controllerBridge;
    if (bridge === undefined) throw new Error("missing bridge");
    const bootstrap = controller.parseControllerBootstrap(
      JSON.stringify({
        url: bridge.url,
        token: bridge.token,
        tools: bridge.toolNames,
        timeoutMs: 10_000,
      }),
    );
    const context = new Context();
    try {
      await context.plugin(SystemPrompt);
      await context.plugin(ToolRuntime);
      await context.plugin(AgentRegistry);
      controller.installControllerBootstrap(context, bootstrap, McpClient);
      await context.plugin(controller);
      let parent: Context | undefined;
      await context.inject(["tools"], (injected) => {
        parent = injected;
      });
      const makeAgent = async (child: boolean) => {
        const id = brandString<SessionId>(child ? "child" : "root");
        const identity = { id };
        if (parent === undefined) throw new Error("tools injection did not activate");
        const scope = createScope(parent, identity);
        Object.assign(identity, {
          ctx: scope.ctx,
          session: { id, header: { ...(child ? { origin: "subagent" } : {}) } },
        });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- External Agent registration fixture; no agent loop is driven here.
        const agent = identity as Agent;
        await context.agents.register(agent);
        return agent;
      };
      const root = await makeAgent(false);
      const child = await makeAgent(true);
      const tool = bridge.toolNames[0];
      if (tool === undefined) throw new Error("missing runtime tool");
      expect(context.tools.schemas(root).map(({ name }) => name)).toContain(tool);
      expect(context.tools.schemas(child).map(({ name }) => name)).not.toContain(tool);
      const result = await context.tools.execute({
        callId: brandString<ToolCallId>("real-call"),
        name: tool,
        arguments: {},
        agent: root,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("repairable");
      expect(invoke).toHaveBeenCalledTimes(1);
      bridge.throwIfFailed();
    } finally {
      await context.fiber.dispose();
    }
  });

  it("executes an admitted tool through the official MCP transport with separate authority", async () => {
    const invoke = vi.fn<ToolProvider["invoke"]>().mockImplementation((call) =>
      Promise.resolve({
        ...call,
        ok: true,
        output: { effect: "scheduled", target: "repository:42/issue:3" },
      }),
    );
    const provider: ToolProvider = {
      id: "github",
      manifest: () => [
        {
          id: "github.labels.add",
          description: "Add labels",
          provider: "github",
          permissions: ["github-write"],
          inputSchema: {
            type: "object",
            properties: { labels: { type: "array", items: { type: "string" } } },
            required: ["labels"],
            additionalProperties: false,
          },
        },
      ],
      invoke,
    };
    const handle = await startDeepSeekProxy({
      apiKey: "real-api-key",
      baseUrl: "https://api.deepseek.com",
      controllerTools: provider,
      workspacePath: process.cwd(),
      deadlineMs: Date.now() + 10_000,
    });
    handles.push(handle);
    const bridge = handle.controllerBridge;
    if (bridge === undefined) throw new Error("Controller MCP bridge is missing");
    expect(bridge.token).not.toBe(handle.workerToken);
    const denied = await fetch(bridge.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.workerToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    const client = new Client({ name: "controller-contract", version: "1" });
    clients.push(client);
    await client.connect(
      // @ts-expect-error SDK transport's own optional accessor is incompatible with its Transport declaration under exactOptionalPropertyTypes.
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { authorization: `Bearer ${bridge.token}` } },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "github.labels.add",
    ]);
    const result = await client.callTool({
      name: "github.labels.add",
      arguments: { labels: ["reviewed"] },
    });
    expect(result.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      id: "github.labels.add",
      input: { labels: ["reviewed"] },
    });
    expect(invoke.mock.calls[0]?.[0].callId).toMatch(/^call-/u);
    bridge.throwIfFailed();
  });
});
