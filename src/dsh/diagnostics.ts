import { isRecord } from "../security/record.js";
import { createHash } from "node:crypto";
import { redactKnownSecrets } from "../security/env.js";

export type DiagnosticLevel = "off" | "basic" | "detailed";
export interface DiagnosticEvent {
  readonly source: "controller" | "worker";
  readonly phase: string;
  readonly elapsedMs: number;
  readonly name?: string;
  readonly call?: string;
  readonly status?: number;
}
export interface DiagnosticSummary {
  readonly level: DiagnosticLevel;
  readonly events: readonly DiagnosticEvent[];
  readonly dropped: number;
  readonly elapsedMs: number;
  readonly lastActivityMs: number;
  readonly artifactId?: number;
  readonly remainingMs?: number;
}

/** Bounded metadata projection. Never retain model prose, tool arguments or HTTP bodies. */
export class RunDiagnostics {
  private readonly started = Date.now();
  private lastActivity = this.started;
  private readonly events: DiagnosticEvent[] = [];
  private dropped = 0;
  private pendingError = "";
  private readonly secrets: string[];
  public constructor(
    public readonly level: DiagnosticLevel,
    private readonly log: (message: string) => void,
    secrets: readonly string[] = [],
    private readonly deadlineMs?: number,
  ) {
    this.secrets = [...secrets];
  }
  public addSecrets(secrets: readonly string[]): void {
    this.secrets.push(...secrets);
  }
  public event(
    phase: string,
    details: Omit<DiagnosticEvent, "phase" | "elapsedMs" | "source"> = {},
    source: DiagnosticEvent["source"] = "controller",
  ): void {
    if (this.level === "off") return;
    this.lastActivity = Date.now();
    const safe = (value: string) =>
      redactKnownSecrets(value, this.secrets)
        .replace(/[^A-Za-z0-9_.: -]/gu, "_")
        .slice(0, 100);
    const event: DiagnosticEvent = {
      source,
      phase: safe(phase),
      elapsedMs: this.lastActivity - this.started,
      ...(details.name === undefined ? {} : { name: safe(details.name) }),
      ...(details.call === undefined
        ? {}
        : { call: createHash("sha256").update(details.call).digest("hex").slice(0, 16) }),
      ...(details.status === undefined ? {} : { status: details.status }),
    };
    if (this.events.length === 1000) {
      this.events.shift();
      this.dropped++;
    }
    this.events.push(event);
    try {
      this.log(
        `[dsh] ${source} ${event.phase}${event.name ? ` ${event.name}` : ""} +${String(event.elapsedMs)}ms`,
      );
    } catch {
      /* Diagnostics cannot replace business results. */
    }
  }
  public heartbeat(): void {
    if (this.level !== "off")
      this.log(
        `[dsh] waiting at ${this.events.at(-1)?.phase ?? "startup"}; last activity ${String(Date.now() - this.lastActivity)}ms ago; elapsed ${String(Date.now() - this.started)}ms`,
      );
  }
  public async phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.event(`${name}.start`);
    try {
      const result = await run();
      this.event(`${name}.end`);
      return result;
    } catch (error) {
      this.event(`${name}.error`);
      throw error;
    }
  }
  public resetStream(): void {
    this.pendingError = "";
  }
  public stderr(chunk: Buffer): void {
    this.pendingError = (this.pendingError + chunk.toString("utf8")).slice(-65536);
    const lines = this.pendingError.split("\n");
    this.pendingError = lines.pop() ?? "";
    for (const line of lines)
      if (line.startsWith("DSH_DIAGNOSTIC ")) {
        try {
          const row: unknown = JSON.parse(line.slice(15));
          if (
            row &&
            typeof row === "object" &&
            "phase" in row &&
            typeof row.phase === "string" &&
            /^(?:profile|loader)\.[a-z-]+$/.test(row.phase)
          )
            this.event(row.phase, {}, "worker");
        } catch {
          /* Ignore malformed diagnostics. */
        }
      }
  }
  public observeHeadless(value: unknown): void {
    if (!isRecord(value)) return;
    const row = value;
    if (
      row.type === "status" &&
      ["turn_start", "step_start", "step_end", "turn_end"].includes(String(row.phase))
    ) {
      this.event(String(row.phase), {}, "worker");
    } else if (
      row.type === "tool_call" &&
      typeof row.tool === "string" &&
      typeof row.callId === "string"
    )
      this.event("tool.start", { name: row.tool, call: row.callId }, "worker");
    else if (row.type === "tool_result" && typeof row.callId === "string")
      this.event(
        row.status === "error" ? "tool.error" : "tool.end",
        { call: row.callId },
        "worker",
      );
    else if (row.type === "session" || row.type === "final") this.event(row.type, {}, "worker");
    else if (row.type === "text" || row.type === "thinking") this.lastActivity = Date.now();
  }
  public snapshot(): DiagnosticSummary {
    return {
      level: this.level,
      events: [...this.events],
      dropped: this.dropped,
      elapsedMs: Date.now() - this.started,
      lastActivityMs: Date.now() - this.lastActivity,
      ...(this.deadlineMs === undefined
        ? {}
        : { remainingMs: Math.max(0, this.deadlineMs - Date.now()) }),
    };
  }
}
