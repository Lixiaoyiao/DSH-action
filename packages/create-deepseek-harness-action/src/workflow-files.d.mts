export interface WorkflowChange {
  readonly path: string;
  readonly source: string;
  readonly expectedHash: string | null;
}
export function saveWorkflowChanges(root: string, changes: readonly WorkflowChange[], options?: {
  readonly beforeWrite?: (path: string) => void | Promise<void>;
  readonly onCleanupWarning?: (path: string) => void;
}): Promise<readonly string[]>;
