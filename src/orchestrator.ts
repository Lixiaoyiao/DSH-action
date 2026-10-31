import { join } from "node:path";
import { loadRepositoryProfile, assertProfileInputCompatibility } from "./dsh/project-profile.js";
import { getBranchHead } from "./write/github.js";
import { selectedWorkerEnvironment, assertNoSecretOutput } from "./security/env.js";
import { RunDiagnostics } from "./dsh/diagnostics.js";
/*
 * Lifecycle adapted from anthropics/claude-code-action/src/entrypoints/run.ts.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import * as core from "@actions/core";
import { assertStartupConfiguration } from "./configuration-check.js";
import { DshAbortedError } from "./dsh/errors.js";
import { selectDshComposition } from "./dsh/select-composition.js";
import { loadInputs, type ResolvedActionInputs } from "./inputs.js";
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
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let preparation: RunPreparation | undefined;
  let execution: ExecutionPreparation | undefined;
  let agent: AgentPhase | undefined;
  let runtime: Pick<RunOutcome, "dsh" | "authority" | "configuration"> = {};
  const observations = () => ({
    schemaVersion: 1 as const,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...runtime,
    ...(lifecycle.diagnostics === undefined || lifecycle.diagnostics.level === "off"
      ? {}
      : { diagnostics: lifecycle.diagnostics.snapshot() }),
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
    let inputs: ResolvedActionInputs = loadInputs();
    lifecycle.diagnostics = new RunDiagnostics(
      inputs.diagnostics,
      (message) => {
        core.info(message);
        lifecycle.reportRuntimeProgress(message);
      },
      [inputs.githubToken, inputs.deepseekApiKey],
    );
    heartbeat = setInterval(() => lifecycle.diagnostics?.heartbeat(), 30_000);
    heartbeat.unref();
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
    preparation = new RunPreparation({ lifecycle, deadlineMs, inputs, signal });
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
      const profileBranch =
        authorized.context.repository.defaultBranch ??
        authorized.baseBranch ??
        (authorized.snapshot?.kind === "pull_request" ? authorized.snapshot.baseRef : undefined);
      if (profileBranch === undefined)
        throw new Error("Cannot resolve trusted Profile source branch");
      const profileDirectory = join(workspace.tempRoot, "trusted-profile");
      const sourceSha =
        authorized.snapshot?.kind === "pull_request"
          ? authorized.snapshot.baseSha
          : await getBranchHead(
              authorized.client,
              authorized.context.repository.owner,
              authorized.context.repository.repo,
              profileBranch,
            );
      const profile = await lifecycle.diagnostics.phase("profile.load", () =>
        loadRepositoryProfile({
          client: authorized.client,
          owner: authorized.context.repository.owner,
          repo: authorized.context.repository.repo,
          sourceSha,
          selection: inputs.dshProfile,
          knownSecrets: [inputs.deepseekApiKey, inputs.githubToken],
          directory: profileDirectory,
        }),
      );
      if (profile !== undefined) {
        assertProfileInputCompatibility(inputs);
        for (const content of Object.values(profile.files))
          assertNoSecretOutput("environment", Buffer.from(content, "base64").toString("utf8"), [
            inputs.deepseekApiKey,
            inputs.githubToken,
          ]);
        runtime = {
          ...runtime,
          configuration: {
            ...profile.audit,
            ...(authorized.policy.trust === "untrusted" ? { withheld: true } : {}),
          },
        };
        if (authorized.policy.trust !== "untrusted") {
          if (inputs.isolation !== "docker")
            throw new Error("Project Profiles require the isolated Docker runtime");
          inputs = {
            ...inputs,
            projectProfile: profile,
            permissionProfile:
              inputs.dshMode === "controlled" ? "custom" : inputs.permissionProfile,
            allowedTools: [
              ...inputs.allowedTools,
              ...(inputs.dshMode === "controlled" ? profile.policy.allowedTools : []),
            ],
            disallowedTools: [
              ...inputs.disallowedTools,
              ...(inputs.dshMode === "controlled" ? profile.policy.deniedTools : []),
            ],
          };
        } else lifecycle.diagnostics.event("profile.withheld-untrusted");
      }
      const workerEnvironment = selectedWorkerEnvironment(
        inputs.dshEnv,
        process.env,
        [inputs.githubToken, inputs.deepseekApiKey],
        authorized.policy.trust !== "untrusted",
      );
      Object.values(workerEnvironment).forEach(core.setSecret);
      lifecycle.diagnostics.addSecrets(Object.values(workerEnvironment));
      inputs = { ...inputs, workerEnvironment };
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
    if (heartbeat !== undefined) clearInterval(heartbeat);
    deadline?.dispose();
    options.signal?.removeEventListener("abort", beginCancellationFinalization);
  }
}

export function reportFailure(error: unknown): string {
  return describeActionFailure(error, "agent").message;
}
