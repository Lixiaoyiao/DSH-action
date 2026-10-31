/*
 * Comment endpoint selection follows anthropics/claude-code-action.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import type { GitHubClient } from "./client.js";
import {
  createTrackingMarker,
  stripTrackingMarkers,
  indexTrackingComments,
  type TrackingKind,
} from "../review/tracking.js";
import { GitHubQuotaError } from "./request-policy.js";

export interface CommentPublication {
  readonly mode: "append" | "update";
  readonly runId: string;
  readonly attempt: string;
}
interface PublicationState {
  readonly publication?: CommentPublication;
  readonly comments: Map<string, number>;
  readonly uncertain: Map<string, unknown>;
}
const publications = new WeakMap<GitHubClient, PublicationState>();
const sharedPublications = new WeakMap<CommentPublication, PublicationState>();
function publicationState(client: GitHubClient): PublicationState {
  let state = publications.get(client);
  if (state === undefined) {
    state = { comments: new Map(), uncertain: new Map() };
    publications.set(client, state);
  }
  return state;
}
export function configureCommentPublication(
  client: GitHubClient,
  publication: CommentPublication,
): void {
  if (!/^\d+$/.test(publication.runId) || !/^[1-9]\d*$/.test(publication.attempt))
    throw new Error("Invalid comment run identity");
  let state = sharedPublications.get(publication);
  if (state === undefined) {
    state = {
      publication: Object.freeze({ ...publication }),
      comments: new Map(),
      uncertain: new Map(),
    };
    sharedPublications.set(publication, state);
  }
  publications.set(client, state);
}

export interface CommentTarget {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

export interface OwnedComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { id?: number | null } | null;
}

export interface CommentRequestOptions {
  readonly signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Comment request was cancelled");
}

/**
 * Octokit forwards `request.signal` to fetch. Keep a controller-owned race as
 * well so a custom client or test double that ignores the option cannot pin a
 * lifecycle publication forever after cancellation.
 */
async function waitForCommentRequest<T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
) {
  if (signal === undefined) return await request();
  if (signal.aborted) throw abortReason(signal);
  const promise = request();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish =
      (callback: (value: T) => void) =>
      (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback(value);
      };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(
        error instanceof Error ? error : new Error("Comment request failed", { cause: error }),
      );
    };
    const abort = (): void => fail(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(finish(resolve), fail);
  });
}

function requestSignal(
  signal: AbortSignal | undefined,
): { readonly request: { readonly signal: AbortSignal } } | Record<string, never> {
  return signal === undefined ? {} : { request: { signal } };
}

export async function listOwnedTrackingComments(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
  options: CommentRequestOptions = {},
) {
  const comments = await waitForCommentRequest(
    async () =>
      await client.paginate(client.rest.issues.listComments, {
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        per_page: 100,
        ...requestSignal(options.signal),
      }),
    options.signal,
  );
  const publication = publicationState(client).publication;
  const marker =
    publication?.mode === "append"
      ? `<!-- dsh-action:run=${publication.runId} attempt=${publication.attempt} -->`
      : undefined;
  return indexTrackingComments(
    marker === undefined ? comments : comments.filter((comment) => comment.body?.includes(marker)),
    expectedAuthorId,
  );
}

export async function upsertTrackingComment(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
  kind: Exclude<TrackingKind, "finding">,
  body: string,
  options: CommentRequestOptions = {},
): Promise<number> {
  const publication = publicationState(client).publication;
  if (publication?.mode === "append") {
    body = [
      createTrackingMarker({ kind }),
      `<!-- dsh-action:run=${publication.runId} attempt=${publication.attempt} -->`,
      stripTrackingMarkers(body),
    ].join("\n");
  }
  const state = publicationState(client);
  const key = JSON.stringify([
    target.owner,
    target.repo,
    target.issueNumber,
    expectedAuthorId,
    kind,
  ]);
  const find = async (): Promise<number | undefined> => {
    const index = await listOwnedTrackingComments(client, target, expectedAuthorId, options);
    return (
      kind === "summary"
        ? index.summaries
        : kind === "diagnosis"
          ? index.diagnoses
          : kind === "task"
            ? index.tasks
            : index.writes
    ).at(-1)?.id;
  };
  const update = async (id: number): Promise<number> => {
    const response = await waitForCommentRequest(
      async () =>
        await client.rest.issues.updateComment({
          owner: target.owner,
          repo: target.repo,
          comment_id: id,
          body,
          ...requestSignal(options.signal),
        }),
      options.signal,
    );
    state.comments.set(key, response.data.id);
    return response.data.id;
  };
  const known = state.comments.get(key);
  if (known !== undefined) {
    try {
      return await update(known);
    } catch (error) {
      // Only a conclusive deletion invalidates the server-returned identity.
      if (
        typeof error !== "object" ||
        error === null ||
        !("status" in error) ||
        (error.status !== 404 && error.status !== 410)
      )
        throw error;
      state.comments.delete(key);
    }
  }
  // Initial recovery handles a restarted publisher or a lost create response.
  // append mode searches only this run/attempt, never a previous task's reply.
  const existing = await find();
  if (existing !== undefined) {
    state.comments.set(key, existing);
    state.uncertain.delete(key);
    return await update(existing);
  }
  if (state.uncertain.has(key)) throw state.uncertain.get(key);
  try {
    const response = await waitForCommentRequest(
      async () =>
        await client.rest.issues.createComment({
          owner: target.owner,
          repo: target.repo,
          issue_number: target.issueNumber,
          body,
          ...requestSignal(options.signal),
        }),
      options.signal,
    );
    state.comments.set(key, response.data.id);
    return response.data.id;
  } catch (error: unknown) {
    if (error instanceof GitHubQuotaError) throw error;
    if (publication?.mode === "append") state.uncertain.set(key, error);
    const recovered = await find();
    if (recovered !== undefined) {
      state.comments.set(key, recovered);
      state.uncertain.delete(key);
      return recovered;
    }
    throw error;
  }
}
