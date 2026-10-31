import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import { DshMalformedOutputError } from "./errors.js";
import { assertNoSecretOutput } from "../security/env.js";
import { stepModelUsage, mergeModelUsage, type ModelUsage } from "./usage.js";

const truncated = { truncated: z.literal(true).optional() };
const count = z.number().int().nonnegative();
const eventSchema = z.union([
  z.strictObject({
    type: z.literal("session"),
    sessionId: z.string().min(1),
    cwd: z.string(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("status"),
    phase: z.enum(["turn_start", "step_start", "step_end", "turn_end"]),
    turn: count,
    step: count.optional(),
    reason: z.json().optional(),
    usage: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({ type: z.enum(["thinking", "text"]), text: z.string(), ...truncated }),
  z.strictObject({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    input: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    callId: z.string(),
    status: z.enum(["error", "completed"]),
    result: z.string(),
    ...truncated,
  }),
  // The official projection may discard every field except type/truncated
  // when its per-event budget is exceeded. This is telemetry, never authority.
  z.strictObject({
    type: z.enum(["session", "status", "thinking", "text", "tool_call", "tool_result"]),
    truncated: z.literal(true),
  }),
  z.strictObject({ type: z.literal("final"), text: z.string() }),
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type HeadlessEvent = z.infer<typeof eventSchema>;

/** Decode each NDJSON row once. Diagnostics observe the same checked events as usage and final validation. */
export class HeadlessOutputDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private raw = "";
  private pending = "";
  private ended = false;
  private projected = false;
  private rows = 0;
  private blank = false;
  private protocolError: string | undefined;
  private safetyError: Error | undefined;
  private finalText: string | undefined;
  private usage: ModelUsage | undefined;
  private incomplete = false;
  private readonly steps = new Set<string>();
  private readonly secrets: readonly string[];
  private readonly observer: ((event: HeadlessEvent) => void) | undefined;
  public constructor(secrets: readonly string[] = [], observer?: (event: HeadlessEvent) => void) {
    this.secrets = secrets;
    this.observer = observer;
  }
  public write(chunk: Buffer): void {
    if (this.ended)
      throw new DshMalformedOutputError("DSH output arrived after process completion");
    this.append(this.decoder.write(chunk));
  }
  private append(text: string): void {
    this.raw += text;
    this.pending += text;
    let index = this.pending.indexOf("\n");
    while (index >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/u, "");
      this.pending = this.pending.slice(index + 1);
      this.line(line);
      index = this.pending.indexOf("\n");
    }
  }
  private line(line: string): void {
    if (line.trim() === "") {
      if (this.rows > 0) this.blank = true;
      return;
    }
    if (this.blank) {
      this.protocolError ??= "DSH headless stream contains an invalid or error event";
      this.incomplete = true;
      this.blank = false;
    }
    let value: unknown;
    try {
      assertNoSecretOutput("stdout", line, this.secrets);
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        /* Plain legacy output is admitted only if no event envelope appears. */
      }
      if (value !== undefined) assertNoSecretOutput("stdout", JSON.stringify(value), this.secrets);
    } catch (error) {
      this.safetyError ??=
        error instanceof Error
          ? error
          : new DshMalformedOutputError("DSH output safety validation failed");
      return;
    }
    const index = this.rows++;
    if (object(value) && Object.hasOwn(value, "type")) this.projected = true;
    let observed: HeadlessEvent | undefined;
    try {
      const parsed = eventSchema.safeParse(value);
      if (!parsed.success) {
        this.protocolError ??= "DSH headless stream contains an invalid or error event";
        this.incomplete = true;
        return;
      }
      const event = parsed.data;
      observed = event;
      if (index === 0 && event.type !== "session")
        this.protocolError ??= "DSH headless stream must begin with one session event";
      if (index > 0 && event.type === "session")
        this.protocolError ??= "DSH headless stream contains multiple sessions";
      if (this.finalText !== undefined)
        this.protocolError ??= "DSH headless stream contains data after its final event";
      if (event.type === "final") this.finalText = event.text;
      if (event.type === "status") {
        if (event.truncated === true || !("phase" in event)) this.incomplete = true;
        if ("phase" in event && event.phase === "step_end") {
          if (event.step === undefined) this.incomplete = true;
          const key = String(event.turn) + ":" + String(event.step);
          if (this.steps.has(key)) this.incomplete = true;
          else {
            this.steps.add(key);
            const sample = stepModelUsage(event.usage);
            this.usage = this.usage === undefined ? sample : mergeModelUsage(this.usage, sample);
          }
        }
      }
    } catch {
      this.protocolError ??= "DSH headless event could not be validated";
      this.incomplete = true;
      return;
    }
    try {
      this.observer?.(observed);
    } catch {
      /* An observation cannot change protocol or authority. */
    }
  }
  public end(expectedStdout?: string): void {
    if (this.ended) return;
    if (this.raw === "" && expectedStdout !== undefined) this.write(Buffer.from(expectedStdout));
    this.append(this.decoder.end());
    if (this.pending !== "") this.line(this.pending);
    this.pending = "";
    this.ended = true;
    if (expectedStdout !== undefined && this.raw !== expectedStdout)
      this.safetyError ??= new DshMalformedOutputError(
        "DSH process output observation was incomplete",
      );
    try {
      assertNoSecretOutput("stdout", this.raw, this.secrets);
    } catch (error) {
      this.safetyError ??=
        error instanceof Error
          ? error
          : new DshMalformedOutputError("DSH output safety validation failed");
    }
  }
  public assertSafe(): void {
    if (this.safetyError !== undefined) throw this.safetyError;
  }
  public partialUsage(): ModelUsage | undefined {
    return this.usage === undefined ? undefined : { ...this.usage, completeness: "partial" };
  }
  public result(): { readonly text: string; readonly usage?: ModelUsage } {
    this.end();
    this.assertSafe();
    if (!this.projected) return { text: this.raw };
    if (this.protocolError !== undefined) throw new DshMalformedOutputError(this.protocolError);
    if (this.finalText === undefined)
      throw new DshMalformedOutputError("DSH headless stream has no final event");
    return {
      text: this.finalText,
      ...(this.usage === undefined
        ? {}
        : {
            usage: this.incomplete
              ? { ...this.usage, completeness: "partial" as const }
              : this.usage,
          }),
    };
  }
}

/** Preserve completed samples without admitting a failed business result. */
export function headlessModelUsage(
  stdout: string,
  secrets: readonly string[] = [],
): ModelUsage | undefined {
  const decoder = new HeadlessOutputDecoder(secrets);
  decoder.write(Buffer.from(stdout));
  decoder.end();
  decoder.assertSafe();
  return decoder.partialUsage();
}
export function decodeHeadlessResult(
  stdout: string,
  secrets: readonly string[] = [],
): { readonly text: string; readonly usage?: ModelUsage } {
  const decoder = new HeadlessOutputDecoder(secrets);
  decoder.write(Buffer.from(stdout));
  return decoder.result();
}
export function headlessResultText(stdout: string, secrets: readonly string[] = []): string {
  return decodeHeadlessResult(stdout, secrets).text;
}
