import { record } from "../security/record.js";
import { DefaultArtifactClient } from "@actions/artifact";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PolicyDeniedError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import {
  MAX_SESSION_ARCHIVE_BYTES,
  MAX_SESSION_MANIFEST_BYTES,
  SESSION_MANIFEST_FILE,
  SESSION_PAYLOAD_FILE,
  parseSessionManifest,
  sessionArtifactName,
  sessionArtifactPrefix,
  sessionClaimName,
  validateSessionManifestBinding,
  type SessionBinding,
  type SessionCheckpoint,
  type SessionRunIdentity,
} from "./contracts.js";
import { decodeSessionArchive } from "./archive.js";
import { verifySessionWorkflowRun, type VerifiedSessionWorkflowRun } from "./workflow-policy.js";

export { decodeSessionArchive } from "./archive.js";

function denied(message: string): never {
  throw new PolicyDeniedError(message);
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ArtifactMetadata {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
  readonly expired: boolean;
  readonly created_at: string | null;
  readonly expires_at: string | null;
  readonly digest?: string | null;
  readonly workflow_run?: {
    readonly id?: number;
    readonly repository_id?: number;
    readonly head_repository_id?: number;
    readonly head_sha?: string;
  } | null;
}
const UPLOAD_CONFIRMATION_ATTEMPTS = 5;
const UPLOAD_CONFIRMATION_INTERVAL_MS = 1_000;
const UPLOAD_CONFIRMATION_TIMEOUT_MS = 5_000;
export interface SessionArtifactUploader {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
    options: { retentionDays: number; compressionLevel: number },
  ): Promise<{ id?: number; size?: number; digest?: string }>;
}
export interface SessionUploadReceipt {
  readonly kind: "claim" | "checkpoint";
  readonly id: number;
  readonly name: string;
  readonly sha256?: string;
}
export interface PrepareSessionArtifactsOptions {
  readonly client: GitHubClient;
  readonly binding: SessionBinding;
  readonly mode: "auto" | "save" | "resume";
  readonly currentRun: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly workflowSha: string;
    readonly actorLogin: string;
  };
  readonly sourceRunId?: number;
  readonly retentionDays: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly authorizeCurrent: () => Promise<void>;
  readonly onUploadReceipt?: (receipt: SessionUploadReceipt) => void;
  readonly uploader?: SessionArtifactUploader;
  readonly fetchArchive?: typeof fetch;
}
export interface PreparedSessionArtifacts {
  readonly binding: SessionBinding;
  readonly current: SessionRunIdentity;
  readonly source?: SessionRunIdentity;
  readonly checkpoint?: SessionCheckpoint;
  readonly generation: number;
  readonly selection: "created" | "resumed";
  readonly claimArtifactId: number;
  readonly options: PrepareSessionArtifactsOptions;
}

function budget(options: {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}): AbortSignal {
  const remaining = options.deadlineMs - Date.now();
  if (remaining <= 0) denied("Session artifact task budget is exhausted");
  return AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(30_000, remaining))]);
}
function args(binding: SessionBinding, signal: AbortSignal) {
  return { owner: binding.repository.owner, repo: binding.repository.repo, request: { signal } };
}

async function runArtifacts(
  client: GitHubClient,
  binding: SessionBinding,
  runId: number,
  signal: AbortSignal,
): Promise<ArtifactMetadata[]> {
  const found: ArtifactMetadata[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const response = await client.rest.actions.listWorkflowRunArtifacts({
      ...args(binding, signal),
      run_id: runId,
      per_page: 100,
      page,
    });
    if (response.data.total_count > 1000)
      denied("Session run artifacts exceed the verification bound");
    for (const artifact of response.data.artifacts) {
      if (seen.has(artifact.id)) denied("Session run artifact listing was unstable or duplicated");
      seen.add(artifact.id);
      found.push(artifact);
    }
    if (found.length === response.data.total_count) return found;
  }
  return denied("Session run artifact listing was incomplete");
}

async function verifyRun(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  runId: number,
  successful: boolean,
  signal: AbortSignal,
): Promise<VerifiedSessionWorkflowRun> {
  return verifySessionWorkflowRun({
    client: options.client,
    repository: binding.repository,
    workflowPath: binding.workflow.path,
    jobId: binding.workflow.jobId,
    runId,
    successful,
    signal,
    ...(options.mode === "auto" ? { automaticKeyHash: binding.keyHash } : {}),
    ...(!successful
      ? {
          runAttempt: options.currentRun.runAttempt,
          workflowSha: options.currentRun.workflowSha,
          expectedActorLogin: options.currentRun.actorLogin,
        }
      : {}),
  });
}

/** Run names retain evidence of a logical key when its short-lived artifacts expire. */
async function automaticHistorySource(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  current: VerifiedSessionWorkflowRun,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (current.sessionTitle === undefined || !Number.isFinite(Date.parse(current.runCreatedAt)))
    denied("Automatic Session history has unknown current run identity");
  const seen = new Set<number>();
  let complete = false;
  let currentFound = false;
  let previous:
    { id: number; updated: number; status: string | null; conclusion: string | null } | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await options.client.rest.actions.listWorkflowRuns({
      ...args(binding, signal),
      workflow_id: binding.workflow.path,
      per_page: 100,
      page,
    });
    if (response.data.total_count > 1000)
      denied(
        "Automatic Session history is unknown: workflow runs exceed the complete-history bound",
      );
    for (const run of response.data.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id < 1 || typeof run.display_title !== "string")
        denied("Automatic Session history is unknown: run identity or title is missing");
      if (seen.has(run.id))
        denied("Automatic Session history is unknown: unstable or duplicate run listing");
      seen.add(run.id);
      if (run.id === current.runId) {
        currentFound = run.display_title.toLowerCase() === current.sessionTitle;
        continue;
      }
      if (
        run.id < current.runId &&
        !/^dsh-session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(run.display_title)
      )
        denied(
          "Automatic Session history is unknown: an earlier workflow run has no verifiable key; adopt a new workflow path and new key",
        );
      if (run.display_title.toLowerCase() !== current.sessionTitle) continue;
      if (run.id > current.runId) {
        if (!["queued", "waiting", "pending", "requested"].includes(run.status ?? ""))
          denied(
            "Automatic Session history has a stale or concurrent same-key conflict: a newer request already started or finished",
          );
        continue;
      }
      const updated = Date.parse(run.updated_at);
      if (!Number.isFinite(updated) || run.path !== binding.workflow.path)
        denied("Automatic Session history has unknown or inconsistent run provenance");
      if (
        previous === undefined ||
        updated > previous.updated ||
        (updated === previous.updated && run.id > previous.id)
      )
        previous = { id: run.id, updated, status: run.status, conclusion: run.conclusion };
    }
    if (seen.size === response.data.total_count) {
      complete = true;
      break;
    }
  }
  if (!complete || !currentFound)
    denied(
      "Automatic Session history is unknown: complete workflow run listing could not be verified",
    );
  if (previous === undefined) return undefined;
  if (previous.status !== "completed" || previous.conclusion === null)
    denied(
      "Automatic Session history is unknown: a previous same-key run is unfinished or uncertain; inspect effects and choose a new key",
    );
  if (previous.conclusion !== "success")
    denied(
      "Automatic Session history failed: the latest same-key run did not succeed; inspect effects and choose a new key",
    );
  return previous.id;
}

/** Other Session keys may publish between pages; discard one shifted scan in full. */
async function repositoryArtifacts(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  signal: AbortSignal,
): Promise<readonly ArtifactMetadata[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const artifacts: ArtifactMetadata[] = [];
    const seen = new Set<number>();
    let total: number | undefined;
    let shifted = false;
    for (let page = 1; page <= 10; page++) {
      const response = await options.client.rest.actions.listArtifactsForRepo({
        ...args(binding, signal),
        per_page: 100,
        page,
      });
      if (response.data.total_count > 1000)
        denied(
          "Repository artifacts exceed the bound needed to prove the latest Session generation",
        );
      if (total !== undefined && total !== response.data.total_count) {
        shifted = true;
        break;
      }
      total = response.data.total_count;
      for (const artifact of response.data.artifacts) {
        if (seen.has(artifact.id)) {
          shifted = true;
          break;
        }
        seen.add(artifact.id);
        artifacts.push(artifact);
      }
      if (shifted) break;
      if (seen.size === total) return artifacts;
    }
    if (!shifted)
      denied("Repository artifact listing could not prove the latest Session generation");
  }
  return denied("Repository artifact listing was unstable or duplicated");
}

async function latestGeneration(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  signal: AbortSignal,
): Promise<number> {
  const artifacts = await repositoryArtifacts(options, binding, signal);
  const prefix = sessionArtifactPrefix(binding);
  if (
    options.mode === "auto" &&
    artifacts.some(
      (item) =>
        item.name.startsWith(`dsh-session-${binding.keyHash}-`) &&
        !item.name.endsWith("-claim") &&
        !item.name.startsWith(prefix),
    )
  )
    denied(
      "Automatic Session history is incompatible with the current workflow, task or runtime binding; choose a new key",
    );
  const candidates = artifacts.filter((item) => item.name.startsWith(prefix) && !item.expired);
  if (candidates.length > 20)
    denied("Session checkpoint candidates exceed the provenance verification bound");
  let latest = 0;
  const runs = new Map<number, VerifiedSessionWorkflowRun | null>();
  const generations = new Set<number>();
  for (const artifact of candidates) {
    const match = /^g([1-9][0-9]*)-a([1-9][0-9]*)$/u.exec(
      artifact.name.slice(sessionArtifactPrefix(binding).length),
    );
    if (match === null || artifact.workflow_run?.id === undefined)
      denied("Session checkpoint name or run provenance is invalid");
    const generation = Number(match[1]);
    const attempt = Number(match[2]);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > 1_000_000 ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 1000
    )
      denied("Session artifact generation or attempt is outside its bound");
    const runId = artifact.workflow_run.id;
    let run = runs.get(runId);
    if (run === undefined) {
      const status = await options.client.rest.actions.getWorkflowRun({
        ...args(binding, signal),
        run_id: runId,
      });
      if (status.data.status !== "completed" || status.data.conclusion !== "success") run = null;
      else run = await verifyRun(options, binding, runId, true, signal);
      runs.set(runId, run);
    }
    if (run?.runAttempt === attempt) {
      assertArtifactMetadata(artifact, binding, run);
      if (generations.has(generation))
        denied("Conflicting successful Session checkpoints share one generation");
      generations.add(generation);
      latest = Math.max(latest, generation);
    }
  }
  return latest;
}

function assertArtifactMetadata(
  artifact: ArtifactMetadata,
  binding: SessionBinding,
  source: VerifiedSessionWorkflowRun,
  currentUpload = false,
): void {
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_SESSION_ARCHIVE_BYTES ||
    artifact.workflow_run?.id !== source.runId ||
    artifact.workflow_run.repository_id !== binding.repository.id ||
    artifact.workflow_run.head_repository_id !== binding.repository.id ||
    artifact.workflow_run.head_sha !== source.sourceSha ||
    artifact.created_at === null ||
    !Number.isFinite(Date.parse(artifact.created_at)) ||
    Date.parse(artifact.created_at) < Date.parse(source.createdAt) - 60_000 ||
    Date.parse(artifact.created_at) >
      (currentUpload ? Date.now() : Date.parse(source.updatedAt)) + 60_000 ||
    artifact.expires_at === null ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= Date.now() ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "")
  )
    denied("Session artifact server provenance, retention, digest or size is invalid");
}

async function downloadCheckpoint(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  source: VerifiedSessionWorkflowRun,
  artifact: ArtifactMetadata,
  signal: AbortSignal,
): Promise<SessionCheckpoint> {
  assertArtifactMetadata(artifact, binding, source);
  let location: string | undefined;
  try {
    const response = await options.client.rest.actions.downloadArtifact({
      ...args(binding, signal),
      artifact_id: artifact.id,
      archive_format: "zip",
      request: { signal, redirect: "manual" },
    });
    location = response.headers.location;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("status" in error) ||
      error.status !== 302 ||
      !("response" in error)
    )
      throw error;
    const redirect = record(record(error.response).headers).location;
    location = typeof redirect === "string" ? redirect : undefined;
  }
  if (location === undefined) denied("GitHub did not provide an artifact archive redirect");
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !(
      url.hostname.endsWith(".blob.core.windows.net") ||
      url.hostname.endsWith(".githubusercontent.com") ||
      url.hostname === "githubusercontent.com"
    )
  )
    denied("Artifact archive redirect has an unsupported HTTPS origin");
  // The Controller token is used only by the official REST request, never sent to the signed blob host.
  const response = await (options.fetchArchive ?? fetch)(url, { signal, redirect: "error" });
  if (response.status !== 200 || response.body === null)
    denied("Session archive could not be downloaded");
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_SESSION_ARCHIVE_BYTES)
    denied("Session archive response exceeds its byte bound");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > MAX_SESSION_ARCHIVE_BYTES)
        denied("Session archive stream exceeds its byte bound");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== artifact.size_in_bytes || `sha256:${digest(bytes)}` !== artifact.digest)
    denied("Downloaded Session archive does not match its server size or SHA256");
  const checkpoint = decodeSessionArchive(bytes);
  validateSessionManifestBinding(checkpoint.manifest, binding, source);
  if (
    artifact.created_at === null ||
    Math.abs(Date.parse(artifact.created_at) - Date.parse(checkpoint.manifest.createdAt)) >
      30 * 60 * 1000 ||
    Date.parse(checkpoint.manifest.expiresAt) > Date.parse(artifact.expires_at ?? "") + 60_000
  )
    denied("Session manifest timestamp or retention differs from the server artifact");
  return checkpoint;
}

async function upload(
  options: PrepareSessionArtifactsOptions,
  name: string,
  files: Readonly<Record<string, Uint8Array>>,
  signal: AbortSignal,
  verification: {
    readonly kind: "claim" | "checkpoint";
    readonly binding: SessionBinding;
    readonly current: VerifiedSessionWorkflowRun;
    readonly expiresAt?: string;
  },
): Promise<{ id: number; size: number; digest: string }> {
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "dsh-session-artifact-"));
  let started = false;
  let acknowledged = false;
  try {
    const paths: string[] = [];
    for (const [file, bytes] of Object.entries(files)) {
      const path = join(root, file);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    await options.authorizeCurrent();
    signal.throwIfAborted();
    started = true;
    const pending = (options.uploader ?? new DefaultArtifactClient()).uploadArtifact(
      name,
      paths,
      root,
      { retentionDays: options.retentionDays, compressionLevel: 0 },
    );
    const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = (): void =>
        reject(
          new PolicyDeniedError(
            "Session upload exceeded its budget; artifact outcome is unknown and the run must not replay",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      pending
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort))
        .catch(() => undefined);
      if (signal.aborted) abort();
    });
    if (result.id === undefined || !Number.isSafeInteger(result.id) || result.id < 1)
      denied("Session artifact upload has no valid bounded server receipt");
    acknowledged = true;
    options.onUploadReceipt?.({
      kind: verification.kind,
      id: result.id,
      name,
      ...(result.digest !== undefined && /^[a-f0-9]{64}$/u.test(result.digest)
        ? { sha256: result.digest }
        : {}),
    });
    if (
      result.digest === undefined ||
      !/^[a-f0-9]{64}$/u.test(result.digest) ||
      result.size === undefined ||
      !Number.isSafeInteger(result.size) ||
      result.size < 1 ||
      result.size > MAX_SESSION_ARCHIVE_BYTES
    )
      denied("Confirmed Session upload has an incomplete or invalid size/digest receipt");
    const artifact = await confirmUploadedArtifact(
      options.client,
      verification.binding,
      result.id,
      signal,
    );
    assertArtifactMetadata(artifact, verification.binding, verification.current, true);
    if (
      artifact.id !== result.id ||
      artifact.name !== name ||
      artifact.size_in_bytes !== result.size ||
      artifact.digest !== `sha256:${result.digest}`
    )
      denied("Confirmed Session upload differs from its fresh GitHub artifact receipt");
    const serverExpires = Date.parse(artifact.expires_at ?? "");
    if (
      serverExpires + 60_000 <
        Date.parse(artifact.created_at ?? "") + options.retentionDays * 86400_000 ||
      (verification.expiresAt !== undefined &&
        Date.parse(verification.expiresAt) > serverExpires + 60_000)
    )
      denied(
        "Confirmed Session artifact retention is shorter than requested; use retention within repository limits",
      );
    return { id: result.id, size: result.size, digest: result.digest };
  } catch (error) {
    if (!started || acknowledged) throw error;
    return denied(
      "Session artifact upload failed or is uncertain; duplicate advances and automatic write retries are forbidden",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Confirm a known SDK effect; never repeat its upload or relax receipt validation. */
async function confirmUploadedArtifact(
  client: GitHubClient,
  binding: SessionBinding,
  artifactId: number,
  outerSignal: AbortSignal,
): Promise<ArtifactMetadata> {
  const deadlineMs = Date.now() + UPLOAD_CONFIRMATION_TIMEOUT_MS;
  const signal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(UPLOAD_CONFIRMATION_TIMEOUT_MS),
  ]);
  for (let attempt = 1; attempt <= UPLOAD_CONFIRMATION_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    if (Date.now() >= deadlineMs) break;
    try {
      const response = await client.rest.actions.getArtifact({
        ...args(binding, signal),
        artifact_id: artifactId,
      });
      signal.throwIfAborted();
      if (Date.now() >= deadlineMs) break;
      return response.data;
    } catch (error: unknown) {
      signal.throwIfAborted();
      if (record(error).status !== 404) throw error;
      if (attempt === UPLOAD_CONFIRMATION_ATTEMPTS || Date.now() >= deadlineMs) break;
      await delay(Math.min(UPLOAD_CONFIRMATION_INTERVAL_MS, deadlineMs - Date.now()), undefined, {
        signal,
      });
    }
  }
  return denied(
    "Acknowledged Session artifact metadata is still unavailable after bounded confirmation; inspect the recorded artifact ID before another task",
  );
}

export async function prepareSessionArtifacts(
  options: PrepareSessionArtifactsOptions,
): Promise<PreparedSessionArtifacts> {
  if (
    !Number.isInteger(options.retentionDays) ||
    options.retentionDays < 1 ||
    options.retentionDays > 7
  )
    denied("Session retention must be 1-7 days");
  if (options.mode === "auto" && options.sourceRunId !== undefined)
    denied(
      "Automatic Session selects its own source; session-source-run-id is only for explicit resume",
    );
  const signal = budget(options);
  const current = await verifyRun(
    options,
    options.binding,
    options.currentRun.runId,
    false,
    signal,
  );
  const binding = {
    ...options.binding,
    workflow: { ...options.binding.workflow, jobName: current.jobName },
  };
  const artifacts = await runArtifacts(options.client, binding, current.runId, signal);
  if (
    artifacts.some(
      (item) =>
        item.name === sessionClaimName(binding.keyHash, current.runAttempt) ||
        (item.name.startsWith(sessionArtifactPrefix(binding)) &&
          item.name.endsWith(`-a${String(current.runAttempt)}`)),
    )
  )
    denied("This run attempt already claimed or saved the Session; it cannot advance twice");
  const selectedRunId =
    options.mode === "auto"
      ? await automaticHistorySource(options, binding, current, signal)
      : options.sourceRunId;
  const latest = await latestGeneration(options, binding, signal);
  if (latest >= 1_000_000)
    denied("Session generation limit has been reached; choose a new explicit Session key");
  let checkpoint: SessionCheckpoint | undefined;
  let source: VerifiedSessionWorkflowRun | undefined;
  if (options.mode === "resume" || (options.mode === "auto" && selectedRunId !== undefined)) {
    if (selectedRunId === undefined || selectedRunId === current.runId)
      denied("Resume requires an explicit distinct source run ID");
    const producer = await verifyRun(options, binding, selectedRunId, true, signal);
    source = producer;
    if (source.jobName !== binding.workflow.jobName)
      denied("Session producer job name differs from the current trusted workflow");
    const candidates = (await runArtifacts(options.client, binding, source.runId, signal)).filter(
      (item) =>
        item.name.startsWith(sessionArtifactPrefix(binding)) &&
        item.name.endsWith(`-a${String(producer.runAttempt)}`),
    );
    if (options.mode === "auto" && candidates.length === 0)
      denied(
        "Automatic Session history checkpoint is missing; inspect the previous run and choose a new key",
      );
    if (
      options.mode === "auto" &&
      candidates.some((item) => item.expired || Date.parse(item.expires_at ?? "") <= Date.now())
    )
      denied("Automatic Session history checkpoint is expired; choose a new key");
    if (candidates.length !== 1 || candidates[0] === undefined)
      denied("Source run must contain exactly one checkpoint for this Session binding and attempt");
    checkpoint = await downloadCheckpoint(options, binding, source, candidates[0], signal);
    if (
      checkpoint.manifest.session.generation !== latest ||
      candidates[0].name !== sessionArtifactName(binding, source.runAttempt, latest)
    )
      denied("Resume parent is stale or its generation is inconsistent");
  } else if (latest !== 0)
    denied(
      options.mode === "auto"
        ? "Automatic Session history is unknown: checkpoints exist without matching run-name history; choose a new key"
        : "A successful Session checkpoint already exists; select resume with its exact source run instead of starting a fork",
    );
  const generation = latest + 1;
  const claim = {
    schemaVersion: 1,
    repositoryId: binding.repository.id,
    runId: current.runId,
    runAttempt: current.runAttempt,
    keyHash: binding.keyHash,
    generation,
    createdAt: new Date().toISOString(),
  };
  const receipt = await upload(
    options,
    sessionClaimName(binding.keyHash, current.runAttempt),
    { "claim.json": Buffer.from(JSON.stringify(claim)) },
    signal,
    { kind: "claim", binding, current },
  );
  return {
    binding,
    current,
    generation,
    claimArtifactId: receipt.id,
    selection: checkpoint === undefined ? "created" : "resumed",
    options,
    ...(source === undefined ? {} : { source }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export async function saveSessionArtifact(options: {
  readonly prepared: PreparedSessionArtifacts;
  readonly checkpoint: SessionCheckpoint;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}): Promise<{ id: number; name: string; generation: number; size?: number; sha256?: string }> {
  const { prepared, checkpoint } = options;
  const signal = budget(options);
  const current = await verifyRun(
    prepared.options,
    prepared.binding,
    prepared.current.runId,
    false,
    signal,
  );
  validateSessionManifestBinding(
    parseSessionManifest(checkpoint.manifest),
    prepared.binding,
    current,
  );
  if (
    checkpoint.manifest.session.generation !== prepared.generation ||
    checkpoint.payload.length !== checkpoint.manifest.payload.bytes ||
    digest(checkpoint.payload) !== checkpoint.manifest.payload.sha256
  )
    denied("Session checkpoint generation or payload changed before save");
  if (
    prepared.options.mode === "auto" &&
    (await automaticHistorySource(prepared.options, prepared.binding, current, signal)) !==
      prepared.source?.runId
  )
    denied(
      "Automatic Session parent history changed before save; conflicting advances are forbidden",
    );
  if (
    (await latestGeneration(prepared.options, prepared.binding, signal)) !==
    prepared.generation - 1
  )
    denied("Session parent generation changed before save");
  const name = sessionArtifactName(prepared.binding, current.runAttempt, prepared.generation);
  const artifacts = await runArtifacts(
    prepared.options.client,
    prepared.binding,
    current.runId,
    signal,
  );
  const claims = artifacts.filter(
    (item) => item.name === sessionClaimName(prepared.binding.keyHash, current.runAttempt),
  );
  if (
    claims.length !== 1 ||
    claims[0]?.id !== prepared.claimArtifactId ||
    artifacts.some((item) => item.name === name)
  )
    denied("Session claim is missing or checkpoint was already saved");
  const manifest = Buffer.from(JSON.stringify(checkpoint.manifest));
  if (manifest.length > MAX_SESSION_MANIFEST_BYTES)
    denied("Session manifest exceeds its byte bound");
  const receipt = await upload(
    prepared.options,
    name,
    { [SESSION_MANIFEST_FILE]: manifest, [SESSION_PAYLOAD_FILE]: checkpoint.payload },
    signal,
    {
      kind: "checkpoint",
      binding: prepared.binding,
      current,
      expiresAt: checkpoint.manifest.expiresAt,
    },
  );
  return {
    id: receipt.id,
    name,
    generation: prepared.generation,
    size: receipt.size,
    sha256: receipt.digest,
  };
}
