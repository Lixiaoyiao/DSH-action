import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import { buildImplementationOperation } from "../write/implementation.js";
import type { BoundIssueIdentity } from "../write/issue.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { stripTrackingMarkers } from "../review/tracking.js";
import { type RepositoryWriteContext } from "../write/transaction.js";

export interface FinishImplementationInput extends RepositoryWriteContext {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueIdentity: BoundIssueIdentity;
  readonly baseBranch: string;
  readonly boundHeadSha: string;
  readonly operationKey: string;
  readonly result: DshRunResult;
  readonly inputs: Pick<ActionInputs, "branchPrefix" | "branchNameTemplate">;
}

export async function finishImplementation(
  input: FinishImplementationInput,
): Promise<{ branch: string; pullNumber: number; url: string }> {
  const operation = buildImplementationOperation({
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    issueState: input.issueIdentity.state,
    issueContentFingerprint: input.issueIdentity.contentFingerprint,
    baseSha: input.boundHeadSha,
    runIdentity: input.operationKey,
    branchPrefix: input.inputs.branchPrefix,
    branchNameTemplate: input.inputs.branchNameTemplate,
  });

  const body = [
    operation.pullRequestMarker,
    sanitizeUntrustedText(stripTrackingMarkers(input.result.output.summary)).slice(0, 40_000),
    "",
    "Validation: configured commands passed.",
    "",
    `Closes #${String(input.issueNumber)}`,
    "",
    "Created by dsh-action.",
  ].join("\n");
  return await input.writer.write(
    {
      kind: "new-pr",
      operationKind: "implement",
      target: {
        branch: input.baseBranch,
        sha: input.boundHeadSha,
        issue: { number: input.issueNumber, identity: input.issueIdentity },
      },
      operation,
      publication: {
        title:
          `Implement #${String(input.issueNumber)}: ${sanitizeUntrustedText(input.issueTitle).replace(/[\r\n]+/gu, " ")}`.slice(
            0,
            250,
          ),
        body,
      },
    },
    input.budget,
  );
}
