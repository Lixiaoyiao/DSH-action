import type { Operation, RequestedAccess } from "../commands/parse.js";

export const AGENT_PROTOCOL_VERSION = 1 as const;

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
  readonly schemaVersion: 1;
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

export interface AgentTurnResponse<TOutput = unknown, TMetadata = unknown> {
  readonly output: TOutput;
  readonly durationMs: number;
  readonly metadata: TMetadata;
}

/** Provider-neutral seam implemented by the current DSH headless adapter. */
export interface AgentEngine<TOutput = unknown, TMetadata = unknown> {
  readonly id: string;
  readonly version: string;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResponse<TOutput, TMetadata>>;
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
