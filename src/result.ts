/** Public result contract; formatting and failure classification remain independent. */
export type {
  ActionConclusion,
  ActionStatus,
  ActionPhase,
  ActionFailure,
  AgentRunSummary,
  ValidationSummary,
  SessionRunSummary,
  RunFacts,
  RunReport,
} from "./result/types.js";
export { finishRunReport } from "./result/report.js";
export { describeActionFailure, describeCancellationFailure } from "./result/failure.js";
export { actionStatus } from "./result/status.js";
export { buildActionOutputs } from "./result/outputs.js";
export { formatStepSummary } from "./result/summary.js";
