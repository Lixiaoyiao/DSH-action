export interface WorkflowFile {
  readonly path: string;
  readonly source: string;
  readonly hash: string | null;
}
export interface WorkflowChange {
  readonly path: string;
  readonly source: string;
  readonly expectedHash: string | null;
}
export function workflowHash(source: string): string;
export function workflowPath(root: string, name: string): Promise<string>;
export function readWorkflow(root: string, name: string): Promise<WorkflowFile>;
export function listWorkflows(root: string): Promise<
  readonly (
    | WorkflowFile
    | {
        readonly path: string;
        readonly editable: false;
        readonly reason: string;
      }
  )[]
>;
export function saveWorkflowChanges(
  root: string,
  changes: readonly WorkflowChange[],
  options?: {
    readonly beforeWrite?: (path: string) => void | Promise<void>;
    readonly onCleanupWarning?: (path: string) => void;
  },
): Promise<readonly string[]>;
export function workflowDiff(path: string, before: string, after: string): string;
