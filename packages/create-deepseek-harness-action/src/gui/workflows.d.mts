export interface GuiStep {
  readonly id: string;
  readonly jobId: string;
  readonly index: number;
  readonly uses: string;
  readonly inputs: Record<string, string>;
  readonly editable: boolean;
  readonly reason?: string;
}
export interface WorkflowInspection {
  readonly editable: boolean;
  readonly sensitive?: boolean;
  readonly reason?: string;
  readonly steps: readonly GuiStep[];
}
export interface GuiDiagnostic {
  readonly status: "passed" | "failed" | "warning" | "not_checked";
  readonly message: string;
}
export type GuiConfigurationCheck = (
  configuration: unknown,
  environment: NodeJS.ProcessEnv,
) => {
  readonly ok: boolean;
  readonly diagnostics: readonly (GuiDiagnostic & { readonly id: string })[];
};
export interface GuiSessionValidators {
  readonly assertSessionWorkflowPolicy: (
    source: string,
    jobId: string,
    automaticKeyHash?: string,
  ) => {
    readonly singlePendingSlot: boolean;
  };
  readonly sessionKeyHash: (key: string) => string;
}
export function inspectWorkflow(source: string): WorkflowInspection;
export function editWorkflow(
  options: {
    readonly source: string;
    readonly stepId: string;
    readonly inputs: Record<string, string>;
    readonly upgradeAction?: boolean;
  },
  releaseSha: string,
): WorkflowInspection & { readonly source: string };
export function presetWorkflow(
  templateDirectory: string,
  kind: string,
  dshMode: string,
): Promise<
  WorkflowInspection & {
    readonly path: string;
    readonly hash: null;
    readonly source: string;
  }
>;
export function validateWorkflow(
  source: string,
  checkConfiguration: GuiConfigurationCheck,
  sessionValidators?: GuiSessionValidators,
): {
  readonly ok: boolean;
  readonly diagnostics: readonly GuiDiagnostic[];
  readonly risks: readonly string[];
};
export function overlappingWorkflowWarnings(
  files: readonly { readonly path: string; readonly source?: string }[],
): readonly GuiDiagnostic[];
