import type { RunReport } from "./types.js";

/** Serialize the already bounded, canonical report without another result projection. */
export function buildActionOutputs(report: RunReport): Readonly<Record<string, string>> {
  return {
    conclusion: report.termination.conclusion,
    summary: report.termination.summary,
    "result-json": JSON.stringify(report),
  };
}
