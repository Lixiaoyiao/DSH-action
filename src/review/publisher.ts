import type { GitHubClient } from "../github/client.js";
import { assertPullRequestSnapshotCurrent, type PullRequestSnapshot } from "../github/fetch.js";
import { parseGitHubFilePatches } from "../diff/parse.js";
import { resolveFindingToInline } from "../diff/map.js";
import type { DiffFile, DiffLine, DiffSide, InlineLocation, ParsedDiff } from "../diff/types.js";
import { sanitizeMarkdownPath, sanitizeUntrustedText } from "../security/redaction.js";
import { fingerprintFinding } from "./fingerprint.js";
import { filterHighPrecisionFindings } from "./precision.js";
import type { ReviewFinding, ReviewResult } from "./schema.js";
import { createTrackingMarker, indexTrackingComments, stripTrackingMarkers } from "./tracking.js";
import { upsertTrackingComment } from "../github/comments.js";
import { GitHubQuotaError } from "../github/request-policy.js";

const GITHUB_BODY_LIMIT = 65_000;

export interface PublicationTarget {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly expectedAuthorId: number;
  readonly runUrl: string;
}

export interface PublicationResult {
  readonly selected: number;
  readonly inlinePublished: number;
  readonly inlineUpdated: number;
  readonly duplicatesSkipped: number;
  readonly summaryOnly: number;
  /** Selected findings whose title/location could not fit the summary. */
  readonly summaryOmitted?: number;
  readonly failures: readonly string[];
}

/** Keep confirmed comment effects when quota stops the remaining publication. */
export class ReviewPublicationQuotaError extends GitHubQuotaError {
  public constructor(
    error: GitHubQuotaError,
    public readonly publication: PublicationResult,
  ) {
    super(error.audit, error.status);
    this.cause = error;
  }
}

function safeBody(value: string): string {
  const sanitized = sanitizeUntrustedText(stripTrackingMarkers(value));
  return sanitized.length <= GITHUB_BODY_LIMIT
    ? sanitized
    : `${sanitized.slice(0, GITHUB_BODY_LIMIT - 40)}\n\n[truncated by dsh-action]`;
}

function severityIcon(severity: ReviewFinding["severity"]): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
  }
}

function findingBody(finding: ReviewFinding, fingerprint: string): string {
  const sections = [
    createTrackingMarker({ kind: "finding", fingerprint }),
    `### ${severityIcon(finding.severity)} ${safeBody(finding.title)}`,
    safeBody(finding.body),
    finding.evidence === undefined ? "" : `**Evidence:** ${safeBody(finding.evidence)}`,
    finding.suggestion === undefined
      ? ""
      : `**Suggested change:**\n\n${safeBody(finding.suggestion)}`,
    `<sub>${finding.category} · confidence ${String(Math.round(finding.confidence * 100))}%</sub>`,
  ];
  return sections.filter(Boolean).join("\n\n").slice(0, GITHUB_BODY_LIMIT);
}

function buildDiff(snapshot: PullRequestSnapshot): ParsedDiff {
  return parseGitHubFilePatches(
    snapshot.changedFiles.map((file) => ({
      filename: file.path,
      ...(file.previousPath === undefined ? {} : { previousFilename: file.previousPath }),
      status: file.status,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      truncated: file.patchMissing || file.patchTruncated,
      binary: file.patchMissing && file.changes === 0,
    })),
  );
}

function mapFinding(diff: ParsedDiff, finding: ReviewFinding) {
  return resolveFindingToInline(diff, {
    path: finding.path,
    line: finding.line,
    ...(finding.side === undefined ? {} : { side: finding.side }),
    ...(finding.startLine === undefined ? {} : { startLine: finding.startLine }),
    ...(finding.startSide === undefined ? {} : { startSide: finding.startSide }),
  });
}

function lineNumber(line: DiffLine, side: DiffSide): number | null {
  return side === "RIGHT" ? line.newLine : line.oldLine;
}

function supportsSide(line: DiffLine, side: DiffSide): boolean {
  return side === "RIGHT"
    ? line.kind !== "deletion" && line.newLine !== null
    : line.kind !== "addition" && line.oldLine !== null;
}

function lineAnchor(line: DiffLine): readonly [DiffLine["kind"], string] {
  return [line.kind, line.content];
}

/** Build a line-number-free source window that remains stable when a hunk moves. */
function findDiffAnchorContext(file: DiffFile, location: InlineLocation): string | undefined {
  const startLine = location.startLine ?? location.line;
  for (const hunk of file.hunks) {
    const supported = hunk.lines
      .map((line, index) => ({ index, line, number: lineNumber(line, location.side) }))
      .filter(
        (item) =>
          supportsSide(item.line, location.side) &&
          item.number !== null &&
          item.number >= startLine &&
          item.number <= location.line,
      );
    if (
      supported.length === 0 ||
      !supported.some((item) => item.number === startLine) ||
      !supported.some((item) => item.number === location.line)
    ) {
      continue;
    }

    const firstIndex = supported[0]?.index;
    const lastIndex = supported.at(-1)?.index;
    if (firstIndex === undefined || lastIndex === undefined) continue;
    const before = hunk.lines
      .slice(0, firstIndex)
      .findLast((line) => supportsSide(line, location.side));
    const after = hunk.lines.slice(lastIndex + 1).find((line) => supportsSide(line, location.side));

    return JSON.stringify({
      side: location.side,
      heading: hunk.heading,
      before: before === undefined ? null : lineAnchor(before),
      target: supported.map(({ line }) => lineAnchor(line)),
      after: after === undefined ? null : lineAnchor(after),
    });
  }
  return undefined;
}

interface PublicationFinding {
  readonly finding: ReviewFinding;
  readonly location: InlineLocation | null;
  readonly fingerprint: string;
}

function selectPublicationFindings(
  diff: ParsedDiff,
  findings: readonly ReviewFinding[],
  maximum: number,
): PublicationFinding[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100) {
    throw new RangeError("maxFindings must be an integer between 0 and 100");
  }
  const selected: PublicationFinding[] = [];
  const seen = new Set<string>();
  for (const finding of filterHighPrecisionFindings(findings)) {
    if (selected.length === maximum) break;
    const mapped = mapFinding(diff, finding);
    const location = mapped?.location ?? null;
    const anchorContext =
      mapped === null ? undefined : findDiffAnchorContext(mapped.file, mapped.location);
    const fingerprint = fingerprintFinding({
      ...finding,
      // The source window, coordinates and path must describe the same file,
      // including findings reported through an unambiguous old rename alias.
      ...location,
      ...(anchorContext === undefined ? {} : { anchorContext }),
    });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    selected.push({ finding, location, fingerprint });
  }
  return selected;
}

function formatSummary(
  result: ReviewResult,
  findings: readonly PublicationFinding[],
  outcome: PublicationResult,
  target: PublicationTarget,
  maximum = GITHUB_BODY_LIMIT,
): string {
  const lines = [
    createTrackingMarker({ kind: "summary" }),
    "## DeepSeek Harness review",
    "",
    `**High-confidence findings:** ${String(findings.length)}`,
    `**Inline:** ${String(outcome.inlinePublished + outcome.inlineUpdated)} · **Summary-only:** ${String(outcome.summaryOnly)}`,
  ];
  if (outcome.summaryOmitted !== undefined)
    lines.push(`**Omitted from summary:** ${String(outcome.summaryOmitted)}`);
  lines.push("", safeBody(result.summary));
  if (outcome.failures.length > 0) {
    lines.push(
      "",
      "### Publication warnings",
      ...outcome.failures.map((failure) => `- ${safeBody(failure)}`),
    );
  }
  lines.push("", `<sub>[Workflow run](${target.runUrl}) · dsh-action</sub>`);
  const body = lines.join("\n");
  const notice = "\n\n[Summary truncated to fit GitHub's comment limit.]";
  return body.length <= maximum ? body : body.slice(0, maximum - notice.length) + notice;
}

function formatSummaryWithFindings(
  result: ReviewResult,
  findings: readonly PublicationFinding[],
  outcome: PublicationResult,
  target: PublicationTarget,
  fallbackFindings: ReadonlySet<ReviewFinding>,
): { readonly body: string; readonly publication: PublicationResult } {
  const summaryFindings = findings.filter(
    ({ finding, location }) => location === null || fallbackFindings.has(finding),
  );
  if (summaryFindings.length === 0)
    return { body: formatSummary(result, findings, outcome, target), publication: outcome };
  const heading = "\n\n### Findings carried in the summary\n\n";
  const notice = "\n\n[Finding details truncated to fit GitHub's comment limit.]";
  const headers = summaryFindings.map(
    ({ finding }) =>
      `- ${severityIcon(finding.severity)} **${safeBody(finding.title)}** — \`${sanitizeMarkdownPath(finding.path)}:${String(finding.line)}\``,
  );
  // Reserve titles and locations before prose. Exceptionally long paths may
  // exceed even that budget; report those omissions instead of cutting a row.
  const preambleLimit = 16_000;
  const headerBudget = GITHUB_BODY_LIMIT - preambleLimit - heading.length - notice.length;
  let headerLength = 0;
  let included = 0;
  for (const header of headers) {
    if (headerLength + header.length + 4 > headerBudget) break;
    headerLength += header.length + 4;
    included += 1;
  }
  const omitted = summaryFindings.length - included;
  const publication = {
    ...outcome,
    summaryOnly: outcome.summaryOnly - omitted,
    ...(omitted === 0 ? {} : { summaryOmitted: omitted }),
  };
  const base = formatSummary(result, findings, publication, target, preambleLimit);
  const perFinding = Math.floor(
    (GITHUB_BODY_LIMIT - base.length - heading.length - headerLength - notice.length) /
      Math.max(1, included),
  );
  const bodies = summaryFindings.slice(0, included).map(({ finding }) => safeBody(finding.body));
  const truncated = bodies.some((body) => body.length > perFinding);
  const rendered = bodies.map(
    (body, index) => `${headers[index] ?? ""}\n  ${body.slice(0, perFinding)}`,
  );
  return {
    body: `${base}${heading}${rendered.join("\n")}${truncated ? notice : ""}`,
    publication,
  };
}

export async function publishPullRequestReview(
  client: GitHubClient,
  target: PublicationTarget,
  snapshot: PullRequestSnapshot,
  result: ReviewResult,
  maxFindings: number,
  onPublication?: (publication: PublicationResult) => void,
): Promise<PublicationResult> {
  if (snapshot.headSha.length !== 40) throw new Error("A full immutable head SHA is required");
  const diff = buildDiff(snapshot);
  const findings = selectPublicationFindings(diff, result.findings, maxFindings);
  let inlinePublished = 0;
  let inlineUpdated = 0;
  let duplicatesSkipped = 0;
  let summaryOnly = 0;
  let summaryOmitted = 0;
  const failures: string[] = [];
  const fallbackFindings = new Set<ReviewFinding>();
  const publicationResult = (): PublicationResult => ({
    selected: findings.length,
    inlinePublished,
    inlineUpdated,
    duplicatesSkipped,
    summaryOnly,
    ...(summaryOmitted === 0 ? {} : { summaryOmitted }),
    failures: [...failures],
  });

  try {
    const existingComments = await client.paginate(client.rest.pulls.listReviewComments, {
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pullNumber,
      per_page: 100,
    });
    const existing = indexTrackingComments(existingComments, target.expectedAuthorId).findings;

    for (const { finding, location, fingerprint } of findings) {
      await assertPullRequestSnapshotCurrent(client, target.owner, target.repo, snapshot);
      if (location === null) {
        summaryOnly += 1;
        continue;
      }
      const body = findingBody(finding, fingerprint);
      const tracked = existing.get(fingerprint);
      // Legacy fingerprints may have folded distinct Unicode paths together.
      // A marker on another Git path cannot own this file's current finding.
      const prior = tracked?.path === location.path ? tracked : undefined;
      const priorMatchesLocation =
        prior?.commit_id === snapshot.headSha &&
        prior.path === location.path &&
        prior.line === location.line &&
        prior.side === location.side;
      try {
        if (priorMatchesLocation) {
          if (prior.body === body) {
            duplicatesSkipped += 1;
          } else {
            await client.rest.pulls.updateReviewComment({
              owner: target.owner,
              repo: target.repo,
              comment_id: prior.id,
              body,
            });
            inlineUpdated += 1;
            existing.set(fingerprint, { ...prior, body });
          }
        } else if (prior !== undefined) {
          // GitHub cannot relocate an existing inline thread to another commit.
          // Keep that thread, suppress a duplicate, and surface the current
          // location/prose in the sticky summary instead.
          duplicatesSkipped += 1;
          summaryOnly += 1;
          fallbackFindings.add(finding);
        } else {
          const response = await client.rest.pulls.createReviewComment({
            owner: target.owner,
            repo: target.repo,
            pull_number: target.pullNumber,
            commit_id: snapshot.headSha,
            body,
            path: location.path,
            line: location.line,
            side: location.side,
            ...(location.startLine === undefined
              ? {}
              : { start_line: location.startLine, start_side: location.startSide }),
          });
          inlinePublished += 1;
          existing.set(fingerprint, response.data);
        }
      } catch (error) {
        failures.push(
          `${sanitizeMarkdownPath(finding.path)}:${String(finding.line)} (${safeBody(finding.title)}): ${error instanceof Error ? safeBody(error.message) : "GitHub API failure"}`,
        );
        if (error instanceof GitHubQuotaError) throw error;
        summaryOnly += 1;
        fallbackFindings.add(finding);
      }
      onPublication?.(publicationResult());
    }

    const summary = formatSummaryWithFindings(
      result,
      findings,
      publicationResult(),
      target,
      fallbackFindings,
    );
    summaryOnly = summary.publication.summaryOnly;
    summaryOmitted = summary.publication.summaryOmitted ?? 0;
    await assertPullRequestSnapshotCurrent(client, target.owner, target.repo, snapshot);
    await upsertTrackingComment(
      client,
      { owner: target.owner, repo: target.repo, issueNumber: target.pullNumber },
      target.expectedAuthorId,
      "summary",
      summary.body,
    );
    return publicationResult();
  } catch (error) {
    if (!(error instanceof GitHubQuotaError)) throw error;
    const message = safeBody(error.message);
    if (!failures.some((failure) => failure.includes(message))) failures.push(message);
    throw new ReviewPublicationQuotaError(error, publicationResult());
  } finally {
    // Preserve counts through every failure without replacing its original
    // classification or replaying a confirmed comment operation.
    onPublication?.(publicationResult());
  }
}
