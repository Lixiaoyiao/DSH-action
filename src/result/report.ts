import type { RunFacts, RunReport } from "./types.js";
import { actionStatus } from "./status.js";

const MAX_OUTPUT_UTF16_BYTES = 640 * 1024;

/** Combine final read-only owner facts once, including confirmed effects on failure. */
export function finishRunReport(facts: RunFacts): RunReport {
  const publication: NonNullable<RunReport["publication"]> = {
    ...(facts.publication === undefined ? {} : { review: facts.publication }),
    ...(facts.writeStatus === undefined ? {} : { writeStatus: facts.writeStatus }),
    ...(facts.commitSha === undefined ? {} : { commitSha: facts.commitSha }),
    ...(facts.changedPaths === undefined ? {} : { changedPaths: facts.changedPaths }),
    ...(facts.branchName === undefined ? {} : { branchName: facts.branchName }),
    ...(facts.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: facts.pullRequestNumber }),
    ...(facts.pullRequestUrl === undefined ? {} : { pullRequestUrl: facts.pullRequestUrl }),
    ...(facts.commentId === undefined ? {} : { commentId: facts.commentId }),
  };
  const report: RunReport = {
    schemaVersion: 2,
    termination: {
      conclusion: facts.conclusion,
      status: actionStatus(facts),
      summary: facts.summary,
      durationMs: facts.durationMs,
      ...(facts.error === undefined ? {} : { error: facts.error }),
    },
    operation: {
      kind: facts.operation ?? "none",
      findingsCount: facts.findingsCount,
      ...(facts.taskOutput === undefined ? {} : { taskOutput: facts.taskOutput }),
    },
    context: {
      ...(facts.runUrl === undefined ? {} : { runUrl: facts.runUrl }),
      ...(facts.policy === undefined ? {} : { policy: facts.policy }),
      ...(facts.permission === undefined ? {} : { permission: facts.permission }),
      ...(facts.toolPolicy === undefined ? {} : { toolPolicy: facts.toolPolicy }),
      ...(facts.dsh === undefined ? {} : { dsh: facts.dsh }),
      ...(facts.authority === undefined ? {} : { authority: facts.authority }),
      ...(facts.githubRequests === undefined ? {} : { githubRequests: facts.githubRequests }),
      ...(facts.textSources === undefined ? {} : { textSources: facts.textSources }),
    },
    ...(facts.agent === undefined ? {} : { agent: facts.agent }),
    ...(facts.validation === undefined ? {} : { validation: facts.validation }),
    ...(Object.keys(publication).length === 0 ? {} : { publication }),
    ...(facts.session === undefined ? {} : { session: facts.session }),
  };
  const agent = report.agent;
  if (agent === undefined) return report;
  const controller = agent.toolReceipts ?? [];
  const dsh = agent.dshToolReceipts ?? [];
  const entries: (
    | { readonly plane: "controller"; readonly index: number }
    | { readonly plane: "dsh"; readonly index: number }
  )[] = [];
  for (let index = 0; index < Math.max(controller.length, dsh.length); index++) {
    if (index < controller.length) entries.push({ plane: "controller", index });
    if (index < dsh.length) entries.push({ plane: "dsh", index });
  }
  const bounded = (keep: number): RunReport => {
    const kept = entries.slice(0, keep);
    return {
      ...report,
      agent: {
        ...agent,
        toolReceipts: kept
          .filter((entry) => entry.plane === "controller")
          .flatMap((entry) => controller[entry.index] ?? []),
        dshToolReceipts: kept
          .filter((entry) => entry.plane === "dsh")
          .flatMap((entry) => dsh[entry.index] ?? []),
        ...(keep === entries.length ? {} : { receiptsDropped: entries.length - keep }),
      },
    };
  };
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = (JSON.stringify(bounded(middle)).length + report.termination.summary.length) * 2;
    if (bytes <= MAX_OUTPUT_UTF16_BYTES) low = middle;
    else high = middle - 1;
  }
  return bounded(low);
}
