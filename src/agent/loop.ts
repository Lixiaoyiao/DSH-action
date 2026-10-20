import { LoopTelemetry } from "./loop-telemetry.js";
import { invokeControllerTool } from "./tool-invocation.js";
import { AGENT_PROTOCOL_VERSION, type AgentEngine, type ToolProvider } from "./contracts.js";
import { createDshRuntime, disposeDshRuntime, type DshRunResult } from "../dsh/runner.js";
import { withDshRuntimeActivity } from "../dsh/runtime.js";
import {
  attachDshFailureTelemetry,
  dshFailureTelemetry,
  DshMalformedOutputError,
} from "../dsh/errors.js";
import { parseDshOutput } from "../dsh/schema.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import { DshAgentEngine } from "../dsh/engine.js";
import { ValidationFailureError } from "../write/validate.js";
import { fingerprintWorkspace } from "../write/workspace.js";
import { AgentDeadlineError, AgentLoopLimitError, AgentNoProgressError } from "./loop-errors.js";
import type {
  AgentTask,
  AgentLoopDependencies,
  AgentLoopHooks,
  AgentLoopResult,
} from "./loop-contracts.js";
import {
  bounded,
  feedbackFingerprint,
  validationFeedback,
  turnContext,
  type LoopFeedback,
  type TaskContextAnchor,
} from "./feedback.js";
import {
  createRuntimeWithinDeadline,
  runLifecycleHookWithinDeadline,
  runEngineTurnWithinDeadline,
  disposeAgentLoop,
} from "./loop-lifecycle.js";
export { AgentDeadlineError, AgentLoopLimitError, AgentNoProgressError } from "./loop-errors.js";
export type {
  AgentLoopDependencies,
  AgentLoopHooks,
  AgentLoopResult,
  AgentLoopStats,
  AgentToolReceipt,
} from "./loop-contracts.js";

/**
 * Controller-owned outer loop. Controlled DSH receives the resolved runtime
 * allowlist; native DSH owns its internal graph. Controller command tools and
 * mandatory validation remain trusted callbacks in both modes.
 */
export async function runAgentLoop<TFinal>(
  task: AgentTask,
  inputs: ActionInputs,
  hooks: AgentLoopHooks<TFinal>,
  dependencies: AgentLoopDependencies = {},
): Promise<AgentLoopResult<TFinal>> {
  const now = dependencies.now ?? Date.now;
  const createRuntime = dependencies.createRuntime ?? (() => createDshRuntime());
  const disposeRuntime = dependencies.disposeRuntime ?? disposeDshRuntime;
  const workspaceFingerprint = dependencies.workspaceFingerprint ?? fingerprintWorkspace;
  const redact = hooks.redact ?? ((value: string) => value);
  const runtime = await createRuntimeWithinDeadline(createRuntime, disposeRuntime, hooks, now);
  let engine: AgentEngine<DshRunResult> | undefined;
  const feedback: LoopFeedback[] = [];
  const telemetry = new LoopTelemetry();
  let steps = 0;
  const reserveStep = (): void => {
    if (steps >= inputs.maxControllerSteps)
      throw new AgentLoopLimitError(inputs.maxControllerSteps);
    steps += 1;
  };
  const provider = hooks.toolProvider;
  const controllerTools: ToolProvider | undefined =
    provider === undefined
      ? undefined
      : {
          id: provider.id,
          manifest: () => provider.manifest(),
          invoke: async (call, context) => {
            throwIfCancelled(hooks.signal);
            reserveStep();
            return await invokeControllerTool(
              provider,
              call,
              context,
              (receipt) => telemetry.recordTool(receipt),
              now,
            );
          },
        };
  const serializedTaskContext = JSON.stringify(task.contextPacket);
  const taskContextAnchor: TaskContextAnchor = {
    sha256: feedbackFingerprint(task.contextPacket),
    byteLength: Buffer.byteLength(serializedTaskContext, "utf8"),
    jsonPrefix: bounded(serializedTaskContext, 4 * 1024),
  };
  let lastValidationFingerprint: string | undefined;
  let pendingValidationFailure: ValidationFailureError | undefined;
  const stats = (turns: number) => telemetry.stats(turns);
  try {
    const restore = hooks.onRuntimeReady;
    if (restore !== undefined)
      await runLifecycleHookWithinDeadline(
        "Session restoration",
        () => withDshRuntimeActivity(runtime, () => restore(runtime)),
        hooks,
        now,
      );
    engine =
      (await dependencies.createEngine?.(runtime, controllerTools)) ??
      new DshAgentEngine(
        inputs,
        task.policy,
        runtime,
        task.tools.extensions,
        undefined,
        controllerTools,
      );
    for (let turn = 1; ; turn += 1) {
      reserveStep();
      throwIfCancelled(hooks.signal);
      if (hooks.deadlineMs - now() <= 0) throw new AgentDeadlineError();
      const onTurn = hooks.onTurn;
      if (onTurn !== undefined) {
        await runLifecycleHookWithinDeadline(
          "turn progress",
          async () => onTurn(turn, inputs.maxControllerSteps),
          hooks,
          now,
        );
      }
      const remainingBeforeTurn = phaseTimeoutMs(hooks.deadlineMs, PHASE_TIMEOUTS.agentTurnMs, now);
      if (remainingBeforeTurn <= 0) throw new AgentDeadlineError();
      let response;
      try {
        response = await runEngineTurnWithinDeadline(
          engine,
          {
            schemaVersion: AGENT_PROTOCOL_VERSION,
            operation: task.operation,
            requestedAccess: task.requestedAccess,
            instructions: task.instructions,
            context: turnContext(task.contextPacket, taskContextAnchor, turn, feedback),
            tools: task.tools.manifests,
            workspacePath: task.workspacePath,
            deadlineMs: hooks.deadlineMs,
            timeoutMs: remainingBeforeTurn,
            ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
          },
          now,
        );
      } catch (error: unknown) {
        const evidence = dshFailureTelemetry(error);
        if (evidence !== undefined) {
          const aggregateFailure = telemetry.observe(evidence);
          attachDshFailureTelemetry(error, aggregateFailure);
          await hooks.onEngineFailure?.(aggregateFailure, stats(turn));
        }
        if (
          pendingValidationFailure !== undefined &&
          (error instanceof DshMalformedOutputError || error instanceof AgentLoopLimitError)
        ) {
          throw pendingValidationFailure;
        }
        throw error;
      }
      const validatedOutput = parseDshOutput(
        JSON.stringify(response.output),
        task.operation,
        task.operation === "task" ? inputs.taskOutputSchema : undefined,
      );
      const result: DshRunResult = {
        ...response,
        output: validatedOutput,
      };
      const aggregate = telemetry.observe(result);
      await hooks.onState?.(aggregate, stats(turn));
      if (result.output.state === "blocked") {
        throwIfCancelled(hooks.signal);
        if (pendingValidationFailure !== undefined) throw pendingValidationFailure;
        const remainingBeforeBlocked = hooks.deadlineMs - now();
        if (remainingBeforeBlocked <= 0) throw new AgentDeadlineError();
        const finalization = await hooks.blocked(aggregate, remainingBeforeBlocked);
        return {
          agent: aggregate,
          stats: stats(turn),
          finalization,
        };
      }

      const remainingBeforeFinalize = hooks.deadlineMs - now();
      if (remainingBeforeFinalize <= 0) throw new AgentDeadlineError();
      throwIfCancelled(hooks.signal);
      try {
        const finalization = await hooks.finalize(aggregate, remainingBeforeFinalize);
        const completed = {
          agent: aggregate,
          stats: stats(turn),
          finalization,
        };
        await hooks.onRuntimeCompleted?.(runtime, completed);
        return completed;
      } catch (error: unknown) {
        if (!(error instanceof ValidationFailureError)) throw error;
        pendingValidationFailure = error;
        telemetry.recordValidationRetry();
        await hooks.onState?.(aggregate, stats(turn));
        const onValidationRetry = hooks.onValidationRetry;
        if (onValidationRetry !== undefined) {
          await runLifecycleHookWithinDeadline(
            "validation retry progress",
            async () => onValidationRetry(turn, error),
            hooks,
            now,
          );
        }
        const data = validationFeedback(error, redact);
        const fingerprint = feedbackFingerprint({
          argv: error.argv,
          exitCode: error.exitCode,
          timedOut: error.timedOut,
          workspace: await workspaceFingerprint(task.workspacePath),
        });
        if (fingerprint === lastValidationFingerprint) {
          throw new AgentNoProgressError({ cause: error });
        }
        lastValidationFingerprint = fingerprint;
        feedback.push({ kind: "validation", turn, data });
        if (steps >= inputs.maxControllerSteps) throw error;
      }
    }
  } finally {
    await disposeAgentLoop(
      [
        {
          component: "tool-provider",
          dispose: hooks.toolProvider?.dispose?.bind(hooks.toolProvider),
        },
        { component: "engine", dispose: engine?.dispose?.bind(engine) },
        { component: "runtime", dispose: () => disposeRuntime(runtime) },
      ],
      hooks.onCleanupError,
    );
  }
}
