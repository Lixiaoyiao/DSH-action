import type { GuiStep, WorkflowInspection } from "../workflows.mjs";

export type DraftSection = "overview" | "configuration" | "plugins" | "advanced" | "preview";
export type DraftTab = "inputs" | "yaml";
export interface DraftFile {
  localId: string;
  path: string;
  source?: string;
  baseSource?: string | null;
  expectedHash: string | null;
  steps: readonly GuiStep[];
  pending: Record<string, Record<string, string>>;
  needsInspection: boolean;
  selectedStepId: string;
  editable?: boolean;
  reason?: string;
}
export interface DraftState {
  files: DraftFile[];
  selectedFileId: string;
  section: DraftSection;
  advancedTab: DraftTab;
  [name: string]: unknown;
}
export interface DraftTransport {
  inspect(source: string): Promise<WorkflowInspection>;
  edit(options: {
    source: string;
    stepId: string;
    inputs: Record<string, string>;
    upgradeAction: boolean;
  }): Promise<WorkflowInspection & { readonly source: string }>;
}
export function createState(data: {
  files?: readonly (Partial<WorkflowInspection> & {
    path: string;
    source?: string;
    hash?: string | null;
  })[];
  initialSection?: DraftSection;
  initialDshMode?: string;
  [name: string]: unknown;
}): DraftState;
export function activeFile(state: DraftState): DraftFile | undefined;
export function activeStep(state: DraftState): GuiStep | undefined;
export function stepInputs(
  file: DraftFile | undefined,
  step: GuiStep | undefined,
): Record<string, string>;
export function dirtyFiles(state: DraftState): DraftFile[];
export function setInput(state: DraftState, name: string, value: string, remove?: boolean): void;
export function setSource(state: DraftState, source: string): void;
export function acceptInspection(file: DraftFile, result: WorkflowInspection): void;
export function inspectDraft(file: DraftFile | undefined, transport: DraftTransport): Promise<void>;
export function applyDraft(file: DraftFile | undefined, transport: DraftTransport): Promise<void>;
export function transitionView(
  state: DraftState,
  target: {
    fileId?: string;
    section?: DraftSection;
    advancedTab?: DraftTab;
  },
  transport: DraftTransport,
): Promise<void>;
export function selectedChanges(
  state: DraftState,
): { path: string; source?: string; expectedHash: string | null }[];
