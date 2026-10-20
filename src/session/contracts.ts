import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { PolicyDeniedError } from "../errors.js";

export const SESSION_PAYLOAD_FILE = "session.jsonl";
export const SESSION_MANIFEST_FILE = "manifest.json";
export const MAX_SESSION_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_MANIFEST_BYTES = 16 * 1024;
export const MAX_SESSION_ATTACHMENTS = 20;
export const MAX_SESSION_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_ATTACHMENTS_BYTES = 50 * 1024 * 1024;
export const MAX_SESSION_ARCHIVE_BYTES =
  MAX_SESSION_PAYLOAD_BYTES + MAX_SESSION_ATTACHMENTS_BYTES + 64 * 1024;
export const SESSION_CONCURRENCY_GROUP = "dsh-session";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const timestamp = z.iso.datetime();
const repositorySchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
});
const taskSchema = z.strictObject({
  kind: z.enum(["issue", "pull_request", "automation"]),
  identity: z.string().min(1).max(256),
});
const runtimeSchema = z.strictObject({
  dshVersion: z.literal("0.2.1-rc.2"),
  mode: z.enum(["controlled", "native"]),
  compositionId: z.string().min(1).max(128),
  containerImage: z.string().min(1).max(512),
  extensionDigest: sha256,
});
const workflowIdentitySchema = z.strictObject({
  path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u),
  jobId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u),
  jobName: z.string().min(1).max(128),
});

export const sessionManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  repository: repositorySchema,
  workflow: workflowIdentitySchema.extend({
    sourceSha: commit,
    runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    runAttempt: z.number().int().min(1).max(1000),
  }),
  task: taskSchema,
  runtime: runtimeSchema,
  issuer: z.strictObject({
    actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actorLogin: z.string().min(1).max(100),
    jobRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  session: z.strictObject({
    keyHash: sha256,
    sessionId: identifier,
    generation: z.number().int().min(1).max(1_000_000),
  }),
  createdAt: timestamp,
  expiresAt: timestamp,
  payload: z.strictObject({
    file: z.literal(SESSION_PAYLOAD_FILE),
    bytes: z.number().int().min(1).max(MAX_SESSION_PAYLOAD_BYTES),
    sha256,
  }),
  // Transport metadata only. Official attachment references remain in the unmodified DSH log.
  attachments: z
    .array(
      z.strictObject({
        file: z.string().regex(/^attachment-(?:0|[1-9][0-9]?)\.bin$/u),
        bytes: z.number().int().min(0).max(MAX_SESSION_ATTACHMENT_BYTES),
        sha256,
      }),
    )
    .min(1)
    .max(MAX_SESSION_ATTACHMENTS)
    .optional(),
});

export type SessionManifest = z.infer<typeof sessionManifestSchema>;
export type SessionManifestWithoutPayload = Omit<SessionManifest, "payload" | "attachments">;
export type SessionRepository = SessionManifest["repository"];
export interface SessionBinding {
  readonly repository: SessionRepository;
  readonly workflow: Pick<SessionManifest["workflow"], "path" | "jobId" | "jobName">;
  readonly task: SessionManifest["task"];
  readonly runtime: SessionManifest["runtime"];
  readonly keyHash: string;
}
export interface SessionRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly sourceSha: string;
  readonly actorId: number;
  readonly actorLogin: string;
  readonly jobRunId: number;
}
export interface SessionCheckpoint {
  readonly manifest: SessionManifest;
  readonly payload: Uint8Array;
  readonly attachments?: Readonly<Record<string, Uint8Array>>;
}

function freezeManifest<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) freezeManifest(nested);
    Object.freeze(value);
  }
  return value;
}

const admittedSnapshots = new WeakSet<object>();
function isAdmittedCheckpoint(value: object): value is SessionCheckpoint {
  return admittedSnapshots.has(value);
}

/** Own the admitted bytes. Consumers receive copies, never the bytes whose proof is reused. */
function checkpointSnapshot(checkpoint: SessionCheckpoint): SessionCheckpoint {
  const payload = checkpoint.payload;
  const attachments = checkpoint.attachments ?? {};
  const snapshot = Object.freeze({
    manifest: freezeManifest(checkpoint.manifest),
    get payload() {
      return Buffer.from(payload);
    },
    get attachments() {
      return Object.fromEntries(
        Object.entries(attachments).map(([name, bytes]) => [name, Buffer.from(bytes)]),
      );
    },
  });
  admittedSnapshots.add(snapshot);
  return snapshot;
}

/** Admit a transport envelope once; time remains a fresh check when the same snapshot is used. */
export function admitSessionCheckpointEnvelope(
  checkpoint: {
    readonly manifest: unknown;
    readonly payload: Uint8Array;
    readonly attachments?: Readonly<Record<string, Uint8Array>>;
  },
  now = Date.now(),
): SessionCheckpoint {
  if (isAdmittedCheckpoint(checkpoint)) {
    assertRetention(checkpoint.manifest, now);
    return checkpoint;
  }
  const manifest = parseSessionManifest(checkpoint.manifest, now);
  if (checkpoint.payload.byteLength !== manifest.payload.bytes)
    throw new PolicyDeniedError(
      "Session payload integrity size or SHA256 differs from its manifest",
    );
  const sourceAttachments = Object.entries(checkpoint.attachments ?? {});
  if (
    sourceAttachments.length !== (manifest.attachments?.length ?? 0) ||
    sourceAttachments.some(
      ([name, bytes]) =>
        !manifest.attachments?.some(
          (entry) => entry.file === name && entry.bytes === bytes.byteLength,
        ),
    )
  )
    throw new PolicyDeniedError("Session attachment bytes do not match their manifest");
  const payload = Uint8Array.from(checkpoint.payload);
  const attachments = Object.fromEntries(
    sourceAttachments.map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
  );
  if (
    payload.byteLength !== manifest.payload.bytes ||
    createHash("sha256").update(payload).digest("hex") !== manifest.payload.sha256
  )
    throw new PolicyDeniedError(
      "Session payload integrity size or SHA256 differs from its manifest",
    );
  const admitted = { manifest, payload, attachments };
  sessionAttachmentFiles(admitted);
  return checkpointSnapshot(admitted);
}

/** Validate the existing artifact envelope without interpreting DSH attachment identities. */
export function sessionAttachmentFiles(
  checkpoint: SessionCheckpoint,
): Readonly<Record<string, Uint8Array>> {
  if (admittedSnapshots.has(checkpoint)) return checkpoint.attachments ?? {};
  const entries = checkpoint.manifest.attachments ?? [];
  const files = checkpoint.attachments ?? {};
  if (
    Object.keys(files).length !== entries.length ||
    entries.some((entry, index) => {
      const bytes = files[entry.file];
      return (
        entry.file !== `attachment-${String(index)}.bin` ||
        bytes?.byteLength !== entry.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      );
    })
  )
    throw new PolicyDeniedError("Session attachment bytes do not match their manifest");
  return files;
}

export function sessionKeyHash(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key)) {
    throw new PolicyDeniedError(
      "Session key must be 1-64 ASCII letters, digits, dot, underscore or hyphen",
    );
  }
  return createHash("sha256").update(key).digest("hex");
}

export function sessionBindingHash(binding: SessionBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repository: [binding.repository.id, binding.repository.owner, binding.repository.repo],
        workflow: [binding.workflow.path, binding.workflow.jobId, binding.workflow.jobName],
        task: [binding.task.kind, binding.task.identity],
        runtime: [
          binding.runtime.dshVersion,
          binding.runtime.mode,
          binding.runtime.compositionId,
          binding.runtime.containerImage,
          binding.runtime.extensionDigest,
        ],
        keyHash: binding.keyHash,
      }),
    )
    .digest("hex");
}

export function sessionArtifactPrefix(binding: SessionBinding): string {
  return `dsh-session-${binding.keyHash}-${sessionBindingHash(binding)}-`;
}

export function sessionArtifactName(
  binding: SessionBinding,
  runAttempt: number,
  generation: number,
): string {
  if (
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > 1000 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > 1_000_000
  ) {
    throw new PolicyDeniedError("Invalid Session artifact generation or run attempt");
  }
  return `${sessionArtifactPrefix(binding)}g${String(generation)}-a${String(runAttempt)}`;
}

export function sessionClaimName(keyHash: string, runAttempt: number): string {
  if (
    !/^[a-f0-9]{64}$/u.test(keyHash) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > 1000
  ) {
    throw new PolicyDeniedError("Invalid Session claim key or run attempt");
  }
  return `dsh-session-${keyHash}-a${String(runAttempt)}-claim`;
}

export function parseSessionManifest(value: unknown, now = Date.now()): SessionManifest {
  const parsed = sessionManifestSchema.safeParse(value);
  if (!parsed.success) throw new PolicyDeniedError("Session manifest is malformed or incompatible");
  const manifest = parsed.data;
  if (
    (manifest.attachments ?? []).some(
      (entry, index) => entry.file !== `attachment-${String(index)}.bin`,
    ) ||
    (manifest.attachments ?? []).reduce((total, entry) => total + entry.bytes, 0) >
      MAX_SESSION_ATTACHMENTS_BYTES
  ) {
    throw new PolicyDeniedError(
      "Session attachment manifest exceeds its bounds or has incompatible filenames",
    );
  }
  assertRetention(manifest, now);
  return manifest;
}

function assertRetention(manifest: SessionManifest, now: number): void {
  const created = Date.parse(manifest.createdAt);
  const expires = Date.parse(manifest.expiresAt);
  if (
    created > now + 60_000 ||
    expires <= now ||
    expires <= created ||
    expires - created < 24 * 60 * 60 * 1000 ||
    expires - created > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new PolicyDeniedError("Session checkpoint is expired or has an invalid retention window");
  }
}

export function validateSessionManifestBinding(
  manifest: SessionManifest,
  expected: SessionBinding,
  source: SessionRunIdentity,
): void {
  const matches =
    isDeepStrictEqual(manifest.repository, expected.repository) &&
    manifest.workflow.path === expected.workflow.path &&
    manifest.workflow.jobId === expected.workflow.jobId &&
    manifest.workflow.jobName === expected.workflow.jobName &&
    manifest.workflow.runId === source.runId &&
    manifest.workflow.runAttempt === source.runAttempt &&
    manifest.workflow.sourceSha === source.sourceSha &&
    isDeepStrictEqual(manifest.task, expected.task) &&
    isDeepStrictEqual(manifest.runtime, expected.runtime) &&
    manifest.session.keyHash === expected.keyHash &&
    manifest.issuer.actorId === source.actorId &&
    manifest.issuer.actorLogin === source.actorLogin &&
    manifest.issuer.jobRunId === source.jobRunId;
  if (!matches)
    throw new PolicyDeniedError(
      "Session checkpoint provenance or runtime/task binding does not match",
    );
}
