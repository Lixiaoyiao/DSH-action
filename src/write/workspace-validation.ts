import * as core from "@actions/core";
import { AgentDeadlineError } from "../agent/loop-errors.js";
import { PolicyDeniedError } from "../errors.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import type { ValidationSummary } from "../result/types.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  ValidationIntegrityError,
  type ValidationIntegrityMode,
  type ValidationIntegritySummary,
} from "./validation-integrity.js";
import {
  remainingValidationMs,
  withinValidationDeadline,
  type ValidationDeadline,
} from "./validation-deadline.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
  type CurrentWorkspaceValidation,
  type ValidationCommandCountObserver,
} from "./validate.js";
import {
  fingerprintWorkspace,
  inspectWorkspaceChanges,
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from "./workspace.js";

export interface WorkspaceValidationConfiguration {
  readonly runTests: boolean;
  readonly commands: readonly (readonly string[])[];
  readonly containerImage: string;
}

/** Execute a suite against one immutable workspace revision, for either write path. */
export async function validateWorkspaceRevision(
  workspace: WorkspaceSnapshot,
  configuration: WorkspaceValidationConfiguration,
  budget: ValidationDeadline,
  onCommandCount?: ValidationCommandCountObserver,
): Promise<CurrentWorkspaceValidation> {
  assertWriteValidationConfigured(configuration.runTests, configuration.commands);
  const before = await withinValidationDeadline(
    () => fingerprintWorkspace(workspace.workerRoot),
    budget,
  );
  let commandCount = 0;
  const results = await withinValidationDeadline(
    () =>
      runValidationCommandsInDocker(
        workspace.workerRoot,
        configuration.commands,
        configuration.containerImage,
        remainingValidationMs(budget),
        undefined,
        budget.signal,
        (count) => {
          commandCount = count;
          onCommandCount?.(count);
        },
      ),
    budget,
  );
  assertValidationSucceeded(results);
  const after = await withinValidationDeadline(
    () => fingerprintWorkspace(workspace.workerRoot),
    budget,
  );
  if (after !== before)
    throw new PolicyDeniedError(
      "Workspace changed during Controller write validation; refusing write",
    );
  return { kind: "current-workspace", fingerprint: after, commandCount };
}

/** Run-local owner of validation facts and the revision they can authorize. */
export class WorkspaceValidation {
  private evidence: ValidationSummary = { status: "not-applicable", commandCount: 0 };
  private accepted:
    (CurrentWorkspaceValidation & { readonly integrity?: ValidationIntegritySummary }) | undefined;
  private gateBudget: ValidationDeadline | undefined;
  private warningKey: string | undefined;

  public constructor(
    private readonly options: {
      readonly workspace: WorkspaceSnapshot;
      readonly configuration: WorkspaceValidationConfiguration;
      readonly integrityMode: ValidationIntegrityMode;
      readonly deadlineMs: number;
      readonly signal: AbortSignal;
      readonly onPhase: () => void;
    },
  ) {}

  public snapshot(): ValidationSummary {
    return { ...this.evidence };
  }

  /** Inspection alone does not claim that configured validation commands ran. */
  public async inspect(changes: WorkspaceChanges, budget: ValidationDeadline): Promise<void> {
    if (changes.all.length > 0) {
      this.evidence = { status: "failed", commandCount: 0 };
      this.accepted = undefined;
    }
    const integrity = await withinValidationDeadline(
      () =>
        inspectValidationIntegrity({
          snapshot: this.options.workspace,
          changes,
          commands: this.options.configuration.commands,
          mode: this.options.integrityMode,
        }),
      budget,
    );
    this.evidence = { ...this.evidence, integrity };
    if (integrity.status === "warned") {
      const key = JSON.stringify(integrity.changes.map(({ path, risk }) => [path, risk]));
      if (this.warningKey !== key) {
        this.warningKey = key;
        core.warning(
          `Validation definitions changed in ${String(integrity.changeCount)} path(s); validation-integrity=warn records the changes without blocking them.`,
        );
      }
    }
  }

  public async enforceIntegrity(budget: ValidationDeadline): Promise<void> {
    const audit = this.evidence.integrity;
    if (audit === undefined) return;
    try {
      const integrity = await withinValidationDeadline(
        () =>
          enforceValidationIntegrity({
            snapshot: this.options.workspace,
            commands: this.options.configuration.commands,
            audit,
            baselineReplay: {
              containerImage: this.options.configuration.containerImage,
              timeoutMs: remainingValidationMs(budget),
              signal: this.options.signal,
            },
          }),
        budget,
      );
      this.evidence = { ...this.evidence, integrity };
    } catch (error: unknown) {
      if (error instanceof ValidationIntegrityError)
        this.evidence = { ...this.evidence, status: "failed", integrity: error.audit };
      throw error;
    }
  }

  /** A historical success is reportable, but cannot authorize this workspace. */
  public completedOperation(): void {
    this.evidence = { ...this.evidence, status: "passed" };
  }

  public async validate(budget?: ValidationDeadline): Promise<CurrentWorkspaceValidation> {
    const { workspace, configuration, deadlineMs, signal } = this.options;
    assertWriteValidationConfigured(configuration.runTests, configuration.commands);
    const fingerprint = await fingerprintWorkspace(workspace.workerRoot);
    if (fingerprint === this.accepted?.fingerprint) {
      const { commandCount, integrity } = this.accepted;
      this.evidence = {
        status: "passed",
        commandCount,
        ...(integrity === undefined ? {} : { integrity }),
      };
      return this.accepted;
    }
    this.options.onPhase();
    this.evidence = { status: "failed", commandCount: 0 };
    this.accepted = undefined;
    if (budget === undefined) {
      if (this.gateBudget === undefined) {
        const phaseMs = phaseTimeoutMs(deadlineMs, PHASE_TIMEOUTS.validationMs, Date.now);
        if (phaseMs <= 0) throw new AgentDeadlineError();
        this.gateBudget = { deadlineMs: Date.now() + phaseMs, signal };
      }
      budget = this.gateBudget;
      const changes = await withinValidationDeadline(
        () => inspectWorkspaceChanges(workspace),
        budget,
      );
      await this.inspect(changes, budget);
      await this.enforceIntegrity(budget);
    }
    const receipt = await validateWorkspaceRevision(
      workspace,
      configuration,
      budget,
      (commandCount) => {
        this.evidence = { ...this.evidence, commandCount };
      },
    );
    this.evidence = { ...this.evidence, status: "passed", commandCount: receipt.commandCount };
    this.accepted = {
      ...receipt,
      ...(this.evidence.integrity === undefined ? {} : { integrity: this.evidence.integrity }),
    };
    return receipt;
  }
}
