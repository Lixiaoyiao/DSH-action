import * as core from "@actions/core";
import { PolicyDeniedError } from "../errors.js";
import type { ValidationSummary } from "../result/types.js";
import {
  enforceValidationIntegrity,
  buildCommandDependencyGraph,
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
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from "./workspace.js";
import type { CommandDependencyGraph } from "../validation/validation-command-graph.js";

export interface WorkspaceValidationConfiguration {
  readonly runTests: boolean;
  readonly commands: readonly (readonly string[])[];
  readonly containerImage: string;
}

/** Execute a suite against one immutable workspace revision, for either write path. */
async function validateWorkspaceRevision(
  workspace: WorkspaceSnapshot,
  configuration: WorkspaceValidationConfiguration,
  budget: ValidationDeadline,
  expectedFingerprint: string,
  onCommandCount?: ValidationCommandCountObserver,
): Promise<CurrentWorkspaceValidation> {
  assertWriteValidationConfigured(configuration.runTests, configuration.commands);
  const before = await withinValidationDeadline(
    () => fingerprintWorkspace(workspace.workerRoot),
    budget,
  );
  if (before !== expectedFingerprint)
    throw new PolicyDeniedError(
      "Workspace changed after validation integrity analysis; refusing write",
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
  private warningKey: string | undefined;
  private analysis:
    | {
        readonly fingerprint: string;
        readonly commandGraph: CommandDependencyGraph;
        readonly integrity: ValidationIntegritySummary;
      }
    | undefined;

  public constructor(
    private readonly options: {
      readonly workspace: WorkspaceSnapshot;
      readonly configuration: WorkspaceValidationConfiguration;
      readonly integrityMode: ValidationIntegrityMode;
    },
  ) {}

  public snapshot(): ValidationSummary {
    return { ...this.evidence };
  }

  /** Inspection alone does not claim that configured validation commands ran. */
  public async inspect(changes: WorkspaceChanges, budget: ValidationDeadline): Promise<string> {
    this.evidence = {
      status: changes.all.length > 0 ? "failed" : "not-applicable",
      commandCount: 0,
    };
    const fingerprint = await withinValidationDeadline(
      () => fingerprintWorkspace(this.options.workspace.workerRoot),
      budget,
    );
    const commandGraph =
      this.analysis?.fingerprint === fingerprint
        ? this.analysis.commandGraph
        : await withinValidationDeadline(
            () =>
              buildCommandDependencyGraph(
                this.options.workspace,
                this.options.configuration.commands,
                changes.added,
              ),
            budget,
          );
    const integrity =
      this.analysis?.fingerprint === fingerprint
        ? this.analysis.integrity
        : await withinValidationDeadline(
            () =>
              inspectValidationIntegrity({
                snapshot: this.options.workspace,
                changes,
                commands: this.options.configuration.commands,
                mode: this.options.integrityMode,
                commandGraph,
              }),
            budget,
          );
    if (
      (await withinValidationDeadline(
        () => fingerprintWorkspace(this.options.workspace.workerRoot),
        budget,
      )) !== fingerprint
    )
      throw new PolicyDeniedError(
        "Workspace changed during validation integrity analysis; refusing write",
      );
    this.analysis = { fingerprint, commandGraph, integrity };
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
    return fingerprint;
  }

  private async enforceIntegrity(budget: ValidationDeadline): Promise<void> {
    const audit = this.evidence.integrity;
    if (audit === undefined) return;
    try {
      const integrity = await withinValidationDeadline(
        () =>
          enforceValidationIntegrity({
            snapshot: this.options.workspace,
            commands: this.options.configuration.commands,
            audit,
            ...(this.analysis === undefined ? {} : { analysis: this.analysis }),
            baselineReplay: {
              containerImage: this.options.configuration.containerImage,
              timeoutMs: remainingValidationMs(budget),
              ...(budget.signal === undefined ? {} : { signal: budget.signal }),
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
    this.evidence = {
      ...this.evidence,
      status: "passed",
      commandCount: 0,
      provenance: "completed-operation",
    };
  }

  /** Enforce candidate policy before looking up a historical write or running its suite. */
  public async prepareWrite(
    changes: WorkspaceChanges,
    budget: ValidationDeadline,
  ): Promise<() => Promise<CurrentWorkspaceValidation>> {
    const fingerprint = await this.inspect(changes, budget);
    await this.enforceIntegrity(budget);
    return () => this.runSuite(budget, fingerprint);
  }

  private async runSuite(
    budget: ValidationDeadline,
    fingerprint: string,
  ): Promise<CurrentWorkspaceValidation> {
    this.evidence = {
      status: "failed",
      commandCount: 0,
      ...(this.evidence.integrity === undefined ? {} : { integrity: this.evidence.integrity }),
    };
    const receipt = await validateWorkspaceRevision(
      this.options.workspace,
      this.options.configuration,
      budget,
      fingerprint,
      (commandCount) => {
        this.evidence = { ...this.evidence, commandCount };
      },
    );
    this.evidence = {
      ...this.evidence,
      status: "passed",
      commandCount: receipt.commandCount,
      provenance: "current-workspace",
    };
    return receipt;
  }
}
