/*
 * Lifecycle adapted from anthropics/claude-code-action/src/entrypoints/run.ts.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import * as core from "@actions/core";
import { assertStartupConfiguration } from "./configuration-check.js";
import { DshAbortedError } from "./dsh/errors.js";
import { selectDshComposition } from "./dsh/select-composition.js";
import { loadInputs } from "./inputs.js";
import { throwIfCancelled } from "./lifecycle/cancellation.js";
import {
  describeActionFailure,
  describeCancellationFailure,
  type RunOutcome,
  type ValidationSummary,
} from "./result.js";
import { buildAuthorityAudit } from "./security/authority.js";
import { ValidationIntegrityError } from "./write/validation-integrity.js";
import { AgentPhase } from "./orchestration/agent-phase.js";
import { ExecutionPreparation } from "./orchestration/execution.js";
import {
  createRunDeadline,
  failureFromSignal,
  isCancellationError,
  RunLifecycle,
  type RunDeadline,
} from "./orchestration/lifecycle.js";
import { RunPreparation } from "./orchestration/prepare.js";
import {
  disposeWorkspace,
  prepareWorkspace,
  type PreparedWorkspace,
} from "./orchestration/workspace.js";

export {
  assertOperationContext,
  boundedText,
  deferProgressUntilWriteValidation,
} from "./orchestration/context.js";

export interface RunActionOptions {
  readonly signal?: AbortSignal;
}

/** Domain owners retain their own facts; orchestration only orders their lifecycles. */
export async function runAction(options: RunActionOptions = {}): Promise<RunOutcome> {
  const startedAt = Date.now();
  const lifecycle = new RunLifecycle();
  let deadline: RunDeadline | undefined;
  let preparation: RunPreparation | undefined;
  let execution: ExecutionPreparation | undefined;
  let agent: AgentPhase | undefined;
  let runtime: Pick<RunOutcome, "dsh" | "authority"> = {};
  const observations = () => ({
    schemaVersion: 1 as const,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...runtime,
    ...preparation?.snapshot(),
    ...execution?.snapshot(),
    ...(lifecycle.commentId === undefined ? {} : { commentId: lifecycle.commentId }),
    ...agent?.snapshot(),
  });
  const beginCancellationFinalization = (): void => {
    if (
      lifecycle.reporter === undefined ||
      lifecycle.phase === "publication" ||
      lifecycle.phase === "write"
    )
      return;
    lifecycle.startFailure(new DshAbortedError(), describeCancellationFailure(lifecycle.phase));
  };
  options.signal?.addEventListener("abort", beginCancellationFinalization, { once: true });
  if (options.signal?.aborted === true) beginCancellationFinalization();
  try {
    throwIfCancelled(options.signal);
    const inputs = loadInputs();
    assertStartupConfiguration(inputs);
    const selection = selectDshComposition(inputs.dshMode);
    const composition = selection.create();
    runtime = {
      dsh: { mode: selection.mode, composition: composition.id },
      authority: buildAuthorityAudit(),
    };
    core.info(`DSH mode ${selection.mode}; composition ${composition.id}`);
    deadline = createRunDeadline(startedAt, inputs.timeoutMinutes, options.signal);
    const { signal, deadlineMs } = deadline;
    preparation = new RunPreparation({ lifecycle, startedAt, inputs, signal });
    const prepared = await preparation.run();
    if (prepared.kind === "complete") return { ...observations(), ...prepared.outcome };

    lifecycle.enter("context");
    let workspace: PreparedWorkspace | undefined;
    const startFailure = (error: unknown): void =>
      lifecycle.startFailure(
        error,
        isCancellationError(error) ? describeCancellationFailure(lifecycle.phase) : undefined,
      );
    try {
      const authorized = prepared.run;
      workspace = await prepareWorkspace({
        client: authorized.client,
        context: authorized.context,
        ...(authorized.snapshot === undefined ? {} : { snapshot: authorized.snapshot }),
        ...(authorized.baseBranch === undefined ? {} : { baseBranch: authorized.baseBranch }),
        inputs,
        policy: authorized.policy,
        signal,
        onFailureBeforeCleanup: startFailure,
      });
      execution = new ExecutionPreparation({
        lifecycle,
        composition,
        authorized,
        workspace,
        inputs,
        deadlineMs,
        signal,
      });
      const capabilities = await execution.run();
      agent = new AgentPhase({
        lifecycle,
        authorized,
        workspace,
        execution: capabilities,
        inputs,
        signal,
        deadlineMs,
      });
      const outcome = await agent.run();
      return { ...observations(), ...outcome };
    } catch (error: unknown) {
      // Begin terminal reporting before bounded workspace cleanup.
      startFailure(error);
      throw error;
    } finally {
      if (workspace !== undefined) await disposeWorkspace(workspace);
    }
  } catch (error: unknown) {
    const effectiveError = failureFromSignal(error, deadline?.signal);
    const failure = isCancellationError(effectiveError)
      ? describeCancellationFailure(lifecycle.phase)
      : describeActionFailure(effectiveError, lifecycle.phase);
    await lifecycle.finishFailure(effectiveError, failure);
    const accepted = execution?.validation?.snapshot();
    const integrity = error instanceof ValidationIntegrityError ? error.audit : accepted?.integrity;
    const validation: ValidationSummary | undefined =
      failure.phase === "validation" || integrity !== undefined
        ? {
            status:
              integrity?.status === "blocked" ? "failed" : (accepted?.status ?? "not-applicable"),
            commandCount: accepted?.status === "not-applicable" ? 0 : (accepted?.commandCount ?? 0),
            ...(integrity === undefined ? {} : { integrity }),
          }
        : undefined;
    const observed = observations();
    delete observed.validation;
    return {
      ...observed,
      conclusion: "failure",
      summary: failure.title,
      findingsCount: 0,
      ...(validation === undefined ? {} : { validation }),
      error: failure,
    };
  } finally {
    deadline?.dispose();
    options.signal?.removeEventListener("abort", beginCancellationFinalization);
  }
}

export function reportFailure(error: unknown): string {
  return describeActionFailure(error, "agent").message;
}
