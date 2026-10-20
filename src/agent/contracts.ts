import type { Operation, RequestedAccess } from "../commands/parse.js";

export const AGENT_PROTOCOL_VERSION = 2 as const;

export interface AgentToolManifest {
  readonly id: string;
  readonly description: string;
  readonly provider: "builtin" | "command" | "github" | "mcp" | "plugin";
  readonly permissions: readonly (
    "read" | "write" | "execute" | "network" | "github-read" | "github-write"
  )[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AgentToolCall {
  /** Controller-generated idempotency key; model output never chooses it. */
  readonly callId: string;
  readonly id: string;
  readonly input: unknown;
}

export interface AgentToolResult {
  readonly callId: string;
  readonly id: string;
  readonly ok: boolean;
  readonly output: unknown;
}

export interface AgentTurnRequest {
  readonly schemaVersion: 2;
  readonly operation: Operation;
  readonly requestedAccess: RequestedAccess;
  readonly instructions: string;
  readonly context: unknown;
  readonly tools: readonly AgentToolManifest[];
  readonly workspacePath: string;
  /** Immutable controller-wide deadline; setup and turns may not extend it. */
  readonly deadlineMs: number;
  /** Per-turn Agent execution cap, started only after runtime setup completes. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Turn execution and shutdown share one run-scoped engine owner. */
export interface AgentEngine<TResult> {
  readonly id: string;
  readonly version: string;
  runTurn(request: AgentTurnRequest): Promise<TResult>;
  /** Shut down active turns, including on failure; borrowed resource owners may retain late activity leases. */
  dispose?(): Promise<void>;
}

export interface ToolInvocationContext {
  readonly workspacePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ToolProvider {
  readonly id: string;
  manifest(): readonly AgentToolManifest[];
  invoke(call: AgentToolCall, context: ToolInvocationContext): Promise<AgentToolResult>;
  dispose?(): Promise<void>;
}
