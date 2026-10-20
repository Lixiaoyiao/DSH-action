import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ToolProvider } from "../agent/contracts.js";
import { DshAbortedError, DshConfigurationError, DshProxyError } from "./errors.js";
import { mcpPublicToolName } from "../extensions/plan.js";

export const CONTROLLER_MCP_PATH = "/action/mcp";
export const CONTROLLER_MCP_SERVER = "action-controller";

export interface ControllerBridgeHandle {
  readonly url: string;
  readonly token: string;
  readonly signal: AbortSignal;
  readonly toolNames: readonly string[];
  readonly timeoutMs: number;
  /** Preserve Controller failures even when the model ignores an MCP error. */
  throwIfFailed(): void;
  /** Revoke this worker lease and await every invocation it already admitted. */
  close(): Promise<void>;
}

export interface ControllerMcpOptions {
  readonly provider: ToolProvider;
  readonly workspacePath: string;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

/** One worker's MCP carrier. The borrowed provider owns authorization, budgets and receipts. */
export class ControllerMcp {
  public readonly token = randomBytes(32).toString("base64url");
  private readonly cancellation = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly calls = new Map<string, { input: string; result: Promise<CallToolResult> }>();
  private readonly catalog: readonly Tool[];
  private readonly ids: ReadonlySet<string>;
  private closed = false;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;

  public constructor(private readonly options: ControllerMcpOptions) {
    const manifests = options.provider.manifest();
    this.catalog = manifests.map((manifest): Tool => {
      if (manifest.provider !== "command" && manifest.provider !== "github") {
        throw new DshConfigurationError("Controller MCP accepts only command and GitHub tools");
      }
      if (manifest.inputSchema.type !== "object") {
        throw new DshConfigurationError("Controller MCP requires object input schemas");
      }
      return {
        name: manifest.id,
        description: manifest.description,
        inputSchema: { ...manifest.inputSchema, type: "object" },
      };
    });
    this.ids = new Set(this.catalog.map(({ name }) => name));
    if (this.ids.size !== this.catalog.length) {
      throw new DshConfigurationError("Controller MCP contains duplicate tool IDs");
    }
  }

  public handle(url: string): ControllerBridgeHandle {
    return {
      url,
      token: this.token,
      signal: this.cancellation.signal,
      toolNames: this.catalog.map(({ name }) => mcpPublicToolName(CONTROLLER_MCP_SERVER, name)),
      timeoutMs: Math.max(1, this.options.deadlineMs - Date.now()),
      throwIfFailed: () => {
        if (this.failure !== undefined) throw this.failure;
      },
      close: () => this.close(),
    };
  }

  public authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header ?? "");
    return (
      !this.closed &&
      !this.cancellation.signal.aborted &&
      Date.now() < this.options.deadlineMs &&
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  }

  public async request(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const disconnected = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) {
        const error = new DshProxyError("Controller MCP transport disconnected");
        this.failure ??= error;
        this.cancellation.abort(this.failure);
        disconnected.abort(error);
      }
    };
    response.once("close", onClose);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Raw maintainer JSON Schemas use the SDK's low-level request interface without another schema interpreter.
    const server = new Server(
      { name: CONTROLLER_MCP_SERVER, version: "1" },
      {
        capabilities: { tools: {} },
      },
    );
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...this.catalog] }));
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      if (!this.ids.has(call.params.name)) {
        return { isError: true, content: [{ type: "text", text: "Unknown Controller tool" }] };
      }
      const key = String(extra.requestId);
      const input = JSON.stringify(call.params);
      const previous = this.calls.get(key);
      if (previous !== undefined) {
        if (previous.input !== input)
          throw new Error("MCP request ID was reused with different input");
        return previous.result;
      }
      const pending = this.invoke(
        call.params.name,
        call.params.arguments ?? {},
        AbortSignal.any([extra.signal, disconnected.signal]),
      );
      this.calls.set(key, { input, result: pending });
      this.active.add(pending);
      void pending.then(
        () => this.active.delete(pending),
        () => this.active.delete(pending),
      );
      return await pending;
    });
    // @ts-expect-error SDK's optional callback accessors conflict with its own Transport under exactOptionalPropertyTypes.
    await server.connect(transport);
    try {
      await transport.handleRequest(request, response, body);
    } finally {
      response.off("close", onClose);
      await server.close();
    }
  }

  private async invoke(
    id: string,
    input: unknown,
    requestSignal: AbortSignal,
  ): Promise<CallToolResult> {
    const timeoutMs = this.options.deadlineMs - Date.now();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Controller tool deadline expired")),
      Math.max(1, timeoutMs),
    );
    timer.unref();
    const signal = AbortSignal.any([
      this.cancellation.signal,
      requestSignal,
      deadline.signal,
      ...(this.options.signal === undefined ? [] : [this.options.signal]),
    ]);
    try {
      if (this.closed || timeoutMs <= 0) throw new Error("Controller tool lease expired");
      signal.throwIfAborted();
      const result = await this.options.provider.invoke(
        { callId: `call-${randomUUID()}`, id, input },
        {
          workspacePath: this.options.workspacePath,
          timeoutMs,
          signal,
        },
      );
      signal.throwIfAborted();
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > this.options.maxOutputBytes) {
        throw new Error("Controller tool output exceeded its byte limit");
      }
      return { isError: !result.ok, content: [{ type: "text", text }] };
    } catch (error: unknown) {
      this.failure ??= this.options.signal?.aborted
        ? new DshAbortedError()
        : error instanceof Error
          ? error
          : new DshConfigurationError("Controller tool failed with a non-Error value", {
              cause: error,
            });
      this.cancellation.abort(this.failure);
      return {
        isError: true,
        content: [{ type: "text", text: "Controller tool failed; the run has stopped" }],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public close(): Promise<void> {
    this.closed = true;
    this.cancellation.abort(new DshAbortedError());
    return (this.closing ??= Promise.allSettled([...this.active]).then(() => undefined));
  }
}
