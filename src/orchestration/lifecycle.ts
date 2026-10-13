import * as core from "@actions/core";
import { AgentDeadlineError } from "../agent/loop-errors.js";
import { DshAbortedError } from "../dsh/errors.js";
import type { StickyProgressReporter } from "../github/progress.js";
import { PHASE_TIMEOUTS, settleWithin } from "../lifecycle/deadline.js";
import { describeActionFailure, type ActionFailure, type ActionPhase } from "../result.js";

interface ProgressState {
  phase: ActionPhase;
  progress?: StickyProgressReporter;
  progressFailure?: ProgressFailureFinalization;
}

/** Own progress and cancellation finalization, without owning domain results. */
export class RunLifecycle {
  private readonly state: ProgressState = { phase: "configuration" };
  public get phase(): ActionPhase {
    return this.state.phase;
  }
  public get reporter(): StickyProgressReporter | undefined {
    return this.state.progress;
  }
  public get commentId(): number | undefined {
    return this.state.progress?.commentId;
  }
  public enter(phase: ActionPhase): void {
    this.state.phase = phase;
  }
  public setReporter(reporter: StickyProgressReporter): void {
    this.state.progress ??= reporter;
  }
  public async update(...args: Parameters<StickyProgressReporter["update"]>): Promise<void> {
    await this.state.progress?.update(...args);
  }
  public startFailure(error: unknown, override?: ActionFailure): void {
    startProgressFailure(this.state, error, override);
  }
  public async finishFailure(error: unknown, override?: ActionFailure): Promise<void> {
    await finishProgressFailure(this.state, error, override);
  }
}

interface ProgressFailureFinalization {
  readonly failure: ActionFailure;
  readonly deadlineMs: number;
  status: "pending" | "succeeded" | "failed";
  promise: Promise<void>;
}

export interface RunDeadline {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createRunDeadline(
  startedAt: number,
  timeoutMinutes: number,
  parentSignal?: AbortSignal,
): RunDeadline {
  const deadlineMs = startedAt + timeoutMinutes * 60_000;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new AgentDeadlineError());
  const remainingMs = deadlineMs - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) abort();
  else {
    timer = setTimeout(abort, remainingMs);
    timer.unref();
  }
  return {
    deadlineMs,
    signal:
      parentSignal === undefined
        ? controller.signal
        : AbortSignal.any([parentSignal, controller.signal]),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function failureFromSignal(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted !== true || !(signal.reason instanceof Error)) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current === signal.reason || current.name === "AbortError") return signal.reason;
    current = current.cause;
  }
  return error;
}

export function isCancellationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (
      current instanceof DshAbortedError ||
      current.message === "DSH execution was aborted" ||
      ("code" in current && current.code === "DSH_ABORTED")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function progressFailureStatus(
  attempt: ProgressFailureFinalization,
): ProgressFailureFinalization["status"] {
  // Promise callbacks mutate this field asynchronously. Keep the read behind a
  // function so TypeScript does not narrow the earlier pending observation.
  return attempt.status;
}

function startProgressFailure(
  state: ProgressState,
  error: unknown,
  failureOverride?: ActionFailure,
): ProgressFailureFinalization | undefined {
  const progress = state.progress;
  if (progress === undefined) return undefined;
  const failure = failureOverride ?? describeActionFailure(error, state.phase);
  const existing = state.progressFailure;
  if (
    existing !== undefined &&
    (existing.failure.code !== "DSH_ABORTED" || failure.code === "DSH_ABORTED")
  ) {
    return existing;
  }
  const attempt: ProgressFailureFinalization = {
    failure,
    deadlineMs: Date.now() + PHASE_TIMEOUTS.cancellationFinalizationMs,
    status: "pending",
    promise: Promise.resolve(),
  };
  attempt.promise = Promise.resolve()
    .then(async () => progress.fail(attempt.failure))
    .then(
      () => {
        attempt.status = "succeeded";
      },
      () => {
        attempt.status = "failed";
      },
    );
  state.progressFailure = attempt;
  return attempt;
}

async function finishProgressFailure(
  state: ProgressState,
  error: unknown,
  failureOverride?: ActionFailure,
): Promise<void> {
  const attempt = state.progressFailure ?? startProgressFailure(state, error, failureOverride);
  if (attempt === undefined || attempt.status === "succeeded") return;
  if (attempt.status === "failed") {
    core.warning(
      "The best-effort progress comment finalization failed; the primary action result was preserved.",
    );
    return;
  }
  const remainingMs = Math.max(0, attempt.deadlineMs - Date.now());
  if (remainingMs > 0) {
    const result = await settleWithin(attempt.promise, remainingMs);
    if (result.settled && progressFailureStatus(attempt) === "succeeded") return;
    if (result.settled && progressFailureStatus(attempt) === "failed") {
      core.warning(
        "The best-effort progress comment finalization failed; the primary action result was preserved.",
      );
      return;
    }
  }
  core.warning(
    "The best-effort progress comment finalization timed out; the primary action result was preserved.",
  );
}
