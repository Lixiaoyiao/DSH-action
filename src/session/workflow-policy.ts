import { isRecord } from "../security/record.js";
import { parseDocument } from "yaml";

import { PolicyDeniedError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import {
  SESSION_CONCURRENCY_GROUP,
  sessionKeyHash,
  type SessionRepository,
  type SessionRunIdentity,
} from "./contracts.js";

const MAX_WORKFLOW_BYTES = 256 * 1024;
const OBJECT_SHA = /^[a-f0-9]{40}$/u;
const GITHUB_STATES = new Set([
  "queued",
  "requested",
  "waiting",
  "pending",
  "in_progress",
  "completed",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "startup_failure",
]);

/** Report only public state labels, never unexpected response payloads. */
function observedState(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return typeof value === "string" && GITHUB_STATES.has(value) ? value : "unrecognized";
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PolicyDeniedError("Session workflow must contain ordinary YAML mappings");
  }
  return value;
}

export interface SessionWorkflowPolicy {
  readonly jobId: string;
  readonly jobName: string;
  readonly stepIndex: number;
  readonly singlePendingSlot: boolean;
}

/** Whole immutable maintainer-selected workflow is the trust boundary, not artifact job attestation. */
export function assertSessionWorkflowPolicy(
  source: string,
  expectedJobId: string,
  automaticKeyHash?: string,
): SessionWorkflowPolicy {
  if (Buffer.byteLength(source) > MAX_WORKFLOW_BYTES)
    throw new PolicyDeniedError("Session workflow exceeds 256 KiB");
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new PolicyDeniedError("Session workflow YAML is invalid");
  let workflow: Record<string, unknown>;
  try {
    workflow = object(document.toJS({ maxAliasCount: 0 }));
  } catch {
    throw new PolicyDeniedError("Session workflow aliases or mappings are not supported");
  }
  const jobs = object(workflow.jobs);
  const producers: {
    jobId: string;
    job: Record<string, unknown>;
    stepIndex: number;
    inputs: Record<string, unknown>;
  }[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = object(rawJob);
    if (!Array.isArray(job.steps)) continue;
    for (let stepIndex = 0; stepIndex < job.steps.length; stepIndex++) {
      const step = object(job.steps[stepIndex]);
      if (step.with === undefined) continue;
      const inputs = object(step.with);
      if (!Object.hasOwn(inputs, "session-mode") || inputs["session-mode"] === "off") continue;
      if (typeof step.uses !== "string" || step.uses === "" || step.run !== undefined) {
        throw new PolicyDeniedError("Session must be enabled explicitly on a direct Action step");
      }
      producers.push({ jobId, job, stepIndex, inputs });
    }
  }
  if (producers.length !== 1 || producers[0]?.jobId !== expectedJobId) {
    throw new PolicyDeniedError(
      "Trusted workflow must contain exactly one Session-producing job and Action step",
    );
  }
  const producer = producers[0];
  const concurrency = object(workflow.concurrency);
  if (concurrency["cancel-in-progress"] !== false)
    throw new PolicyDeniedError("Session requires workflow-level cancel-in-progress: false");
  if (automaticKeyHash === undefined) {
    if (concurrency.group !== SESSION_CONCURRENCY_GROUP)
      throw new PolicyDeniedError(
        "Explicit Session requires workflow-level literal concurrency group dsh-session",
      );
  } else {
    const key = producer.inputs["session-key"];
    if (typeof key !== "string")
      throw new PolicyDeniedError("Automatic Session requires an explicit maintainer-selected key");
    const input = /^\$\{\{ inputs\.([A-Za-z_][A-Za-z0-9_-]*) \}\}$/u.exec(key);
    if (input !== null) {
      const dispatch = object(object(workflow.on).workflow_dispatch);
      const configured = object(object(dispatch.inputs)[input[1] ?? ""]);
      if (
        configured.required !== true ||
        (configured.type !== undefined && configured.type !== "string")
      )
        throw new PolicyDeniedError(
          "Automatic Session key input must be a required workflow_dispatch string",
        );
    } else if (sessionKeyHash(key.toLowerCase()) !== automaticKeyHash) {
      throw new PolicyDeniedError(
        "Automatic Session workflow literal key differs from the current key",
      );
    }
    const scoped = `${SESSION_CONCURRENCY_GROUP}-${key}`;
    if (concurrency.group !== scoped || workflow["run-name"] !== scoped)
      throw new PolicyDeniedError(
        "Automatic Session requires identical key-scoped workflow concurrency and run-name: dsh-session-<session-key>",
      );
  }
  if (
    producer.job.strategy !== undefined &&
    Object.hasOwn(object(producer.job.strategy), "matrix")
  ) {
    throw new PolicyDeniedError("Session-producing matrix jobs are unsupported");
  }
  if (producer.job.uses !== undefined)
    throw new PolicyDeniedError("Reusable Session-producing jobs are unsupported");
  const jobName = producer.job.name ?? producer.jobId;
  if (
    typeof jobName !== "string" ||
    jobName.length === 0 ||
    jobName.length > 128 ||
    jobName.includes("${{")
  ) {
    throw new PolicyDeniedError("Session producer job name must be a static literal");
  }
  return {
    jobId: producer.jobId,
    jobName,
    stepIndex: producer.stepIndex,
    singlePendingSlot: concurrency.queue === undefined || concurrency.queue === "single",
  };
}

export interface VerifiedSessionWorkflowRun extends SessionRunIdentity {
  readonly jobName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionTitle?: string;
  readonly runCreatedAt: string;
  readonly singlePendingSlot: boolean;
}

export interface VerifySessionWorkflowRunOptions {
  readonly client: GitHubClient;
  readonly repository: SessionRepository;
  readonly workflowPath: string;
  readonly jobId: string;
  readonly runId: number;
  readonly runAttempt?: number;
  readonly workflowSha?: string;
  readonly expectedActorLogin?: string;
  readonly successful: boolean;
  readonly automaticKeyHash?: string;
  readonly signal: AbortSignal;
}

/** Follow only the immutable workflow path; unrelated repository entries are not Session state. */
async function readWorkflowSource(
  options: VerifySessionWorkflowRunOptions,
  sourceSha: string,
): Promise<string> {
  const { client, repository, signal, workflowPath } = options;
  if (!/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u.test(workflowPath))
    throw new PolicyDeniedError("Session workflow path must identify one workflow file");
  const parameters = {
    owner: repository.owner,
    repo: repository.repo,
    request: { signal, dshImmutable: true },
  };
  const components = workflowPath.split("/");
  let treeSha = sourceSha;
  for (const [index, component] of components.entries()) {
    signal.throwIfAborted();
    const tree = await client.rest.git.getTree({ ...parameters, tree_sha: treeSha });
    signal.throwIfAborted();
    // GitHub resolves the initial commit SHA to its root tree. Subsequent
    // requests are exact tree SHAs supplied by the preceding parent entry.
    if (
      typeof tree.data.truncated !== "boolean" ||
      tree.data.truncated ||
      !OBJECT_SHA.test(tree.data.sha) ||
      (index > 0 && tree.data.sha !== treeSha) ||
      !Array.isArray(tree.data.tree)
    )
      throw new PolicyDeniedError(
        "Session workflow tree identity or complete listing cannot be verified",
      );
    const matches = tree.data.tree.filter((entry) => entry.path === component);
    const entry = matches[0];
    if (matches.length !== 1 || entry?.sha === undefined || !OBJECT_SHA.test(entry.sha))
      throw new PolicyDeniedError(
        "Session workflow path is missing or has ambiguous object identity",
      );
    if (index < components.length - 1) {
      if (entry.type !== "tree" || entry.mode !== "040000")
        throw new PolicyDeniedError("Session workflow directories must be ordinary Git trees");
      treeSha = entry.sha;
      continue;
    }
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size ?? -1) < 0 ||
      (entry.size ?? MAX_WORKFLOW_BYTES + 1) > MAX_WORKFLOW_BYTES
    )
      throw new PolicyDeniedError(
        "Session workflow must be a bounded regular file in its immutable Git tree",
      );
    const blob = await client.rest.git.getBlob({ ...parameters, file_sha: entry.sha });
    signal.throwIfAborted();
    if (
      blob.data.sha !== entry.sha ||
      blob.data.encoding !== "base64" ||
      blob.data.size !== entry.size ||
      typeof blob.data.content !== "string" ||
      blob.data.content.length > MAX_WORKFLOW_BYTES * 2
    )
      throw new PolicyDeniedError(
        "Session workflow blob identity, size or encoding cannot be verified",
      );
    const bytes = Buffer.from(blob.data.content, "base64");
    if (bytes.length !== blob.data.size || bytes.length > MAX_WORKFLOW_BYTES)
      throw new PolicyDeniedError("Session workflow blob size does not match");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PolicyDeniedError("Session workflow must contain valid UTF-8");
    }
  }
  throw new PolicyDeniedError("Session workflow file could not be verified");
}

export async function verifySessionWorkflowRun(
  options: VerifySessionWorkflowRunOptions,
): Promise<VerifiedSessionWorkflowRun> {
  const { client, repository, signal } = options;
  signal.throwIfAborted();
  const parameters = { owner: repository.owner, repo: repository.repo, request: { signal } };
  const metadata = await client.rest.repos.get(parameters);
  if (
    metadata.data.id !== repository.id ||
    metadata.data.full_name !== `${repository.owner}/${repository.repo}`
  ) {
    throw new PolicyDeniedError("Session repository identity does not match GitHub");
  }
  const response = await client.rest.actions.getWorkflowRun({
    ...parameters,
    run_id: options.runId,
  });
  const run = response.data;
  if (
    run.id !== options.runId ||
    run.repository.id !== repository.id ||
    run.head_repository.id !== repository.id ||
    run.head_branch !== metadata.data.default_branch ||
    run.path !== options.workflowPath ||
    ["pull_request", "pull_request_target"].includes(run.event)
  ) {
    throw new PolicyDeniedError(
      "Session requires a same-repository trusted default-branch workflow run; pull-request workflow provenance is unsupported",
    );
  }
  if (options.runAttempt !== undefined && run.run_attempt !== options.runAttempt)
    throw new PolicyDeniedError("Session run attempt has changed");
  if (options.automaticKeyHash !== undefined && !options.successful && run.run_attempt !== 1)
    throw new PolicyDeniedError(
      "Automatic Session cannot rerun an old run; use a new maintainer workflow dispatch to avoid task replay",
    );
  if (options.workflowSha !== undefined && run.head_sha !== options.workflowSha)
    throw new PolicyDeniedError("Session workflow SHA cannot be verified against the current run");
  if (!/^[a-f0-9]{40}$/u.test(run.head_sha) || run.run_attempt === undefined || run.run_attempt < 1)
    throw new PolicyDeniedError("Session run has incomplete immutable provenance");
  if (
    options.successful
      ? run.status !== "completed" || run.conclusion !== "success"
      : run.status !== "in_progress" && run.status !== "queued"
  )
    throw new PolicyDeniedError(
      "Session producer must finish successfully; current run must be in progress or queued with an active producer" +
        `; role=${options.successful ? "source" : "current"}` +
        `; observedStatus=${observedState(run.status)}` +
        `; observedConclusion=${observedState(run.conclusion)}` +
        `; runIdMatches=${String(run.id === options.runId)}` +
        `; attemptMatches=${String(options.runAttempt === undefined || run.run_attempt === options.runAttempt)}` +
        `; workflowShaMatches=${String(options.workflowSha === undefined || run.head_sha === options.workflowSha)}`,
    );
  const actor = run.triggering_actor ?? run.actor;
  if (actor?.id === undefined)
    throw new PolicyDeniedError("Session run actor provenance is missing");
  if (
    options.expectedActorLogin !== undefined &&
    actor.login.toLowerCase() !== options.expectedActorLogin.toLowerCase()
  )
    throw new PolicyDeniedError(
      "Session current run initiator differs from the actor whose authority was evaluated; use a new maintainer workflow dispatch",
    );

  const source = await readWorkflowSource(options, run.head_sha);
  const policy = assertSessionWorkflowPolicy(source, options.jobId, options.automaticKeyHash);
  let sessionTitle: string | undefined;
  if (options.automaticKeyHash !== undefined) {
    const key = /^dsh-session-([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(run.display_title);
    if (key?.[1] === undefined || sessionKeyHash(key[1].toLowerCase()) !== options.automaticKeyHash)
      throw new PolicyDeniedError(
        "Automatic Session run-name does not match its verified logical key",
      );
    sessionTitle = run.display_title.toLowerCase();
  }
  const jobs = await client.rest.actions.listJobsForWorkflowRunAttempt({
    ...parameters,
    run_id: run.id,
    attempt_number: run.run_attempt,
    per_page: 100,
  });
  if (jobs.data.total_count > 100)
    throw new PolicyDeniedError("Session run jobs exceed the provenance verification bound");
  const matching = jobs.data.jobs.filter((job) => job.name === policy.jobName);
  let job = matching[0];
  if (
    !options.successful &&
    matching.length === 1 &&
    job?.run_id === run.id &&
    job.head_sha === run.head_sha &&
    job.status === "queued" &&
    job.conclusion === null
  ) {
    // The attempt listing can lag the active job. Verify its exact identity;
    // queued or unknown states never authorize a Session task.
    const response = await client.rest.actions.getJobForWorkflowRun({
      ...parameters,
      job_id: job.id,
    });
    const current = response.data;
    if (
      current.id !== job.id ||
      current.run_id !== run.id ||
      current.run_attempt !== run.run_attempt ||
      current.head_sha !== run.head_sha ||
      current.name !== policy.jobName ||
      current.conclusion !== null
    )
      throw new PolicyDeniedError(
        "Session current producer job does not match its verified run and attempt",
      );
    job = current;
  }
  if (
    matching.length !== 1 ||
    job?.run_id !== run.id ||
    job.head_sha !== run.head_sha ||
    (options.successful
      ? job.status !== "completed" || job.conclusion !== "success"
      : job.status !== "in_progress")
  )
    throw new PolicyDeniedError(
      "Session producer job must have one verified state on the exact run attempt" +
        `; role=${options.successful ? "source" : "current"}` +
        `; observedStatus=${observedState(job?.status)}` +
        `; observedConclusion=${observedState(job?.conclusion)}` +
        `; matchCount=${String(matching.length)}` +
        `; runIdMatches=${String(job?.run_id === run.id)}` +
        `; headShaMatches=${String(job?.head_sha === run.head_sha)}`,
    );
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    sourceSha: run.head_sha,
    actorId: actor.id,
    actorLogin: actor.login,
    jobRunId: job.id,
    jobName: policy.jobName,
    createdAt: job.started_at,
    updatedAt: job.completed_at ?? run.updated_at,
    runCreatedAt: run.created_at,
    singlePendingSlot: policy.singlePendingSlot,
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
  };
}
