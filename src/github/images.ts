/*
 * GitHub image discovery/download adapted from anthropics/claude-code-action.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 * DSH owns image decoding, attachment storage and model projection.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GITHUB_IMAGE_LIMITS = {
  count: 8,
  imageBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
} as const;
export const WORKER_GITHUB_IMAGES = "/dsh-home/github-images";

export interface GitHubImage {
  readonly source: string;
  readonly status: "ready" | "skipped" | "failed";
  readonly path?: string;
  readonly mediaType?: string;
  readonly bytes?: number;
  readonly reason?: string;
}

function imageUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "")
      return;
    if (
      url.hostname === "github.com" &&
      (/^\/user-attachments\/assets\/[a-f0-9-]+$/iu.test(url.pathname) ||
        /^\/[^/]+\/[^/]+\/assets\/\d+\/[a-f0-9-]+$/iu.test(url.pathname))
    )
      return url;
    if (
      ["user-images.githubusercontent.com", "private-user-images.githubusercontent.com"].includes(
        url.hostname,
      ) &&
      /^\/\d+\//u.test(url.pathname)
    )
      return url;
  } catch {
    /* Unsupported URLs are reported without fetching them. */
  }
  return;
}

function sourceLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "unsupported image reference";
  }
}

function redirectUrl(value: string): URL | undefined {
  const hosted = imageUrl(value);
  if (hosted !== undefined) return hosted;
  const url = new URL(value);
  // GitHub's signed upload delivery bucket. Accept only as a redirect from an
  // admitted GitHub upload, never as an input URL or a wildcard S3 destination.
  if (
    url.protocol === "https:" &&
    url.hostname === "github-production-user-asset-6210df.s3.amazonaws.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    /^\/\d+\/[^/]+$/u.test(url.pathname)
  )
    return url;
  return;
}

function references(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    // GitHub uploads are also pasted as bare links; Markdown and HTML may point
    // elsewhere, in which case the explicit skipped result explains the policy.
    for (const match of text.matchAll(
      /!\[[^\]\r\n]*\]\(\s*<?([^\s)>]+)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']|https:\/\/(?:github\.com\/(?:user-attachments\/assets\/|[^\s/]+\/[^\s/]+\/assets\/)|(?:private-)?user-images\.githubusercontent\.com\/)[^\s<>"')\]]+/giu,
    )) {
      const value = (match[1] ?? match[2] ?? match[0]).replaceAll("&amp;", "&");
      found.add(value);
      if (found.size >= 64) return [...found];
    }
  }
  return [...found];
}

const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function download(
  url: URL,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  remaining: number,
): Promise<{ bytes: Buffer; mediaType: string; extension: string }> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(current.href, {
      redirect: "manual",
      signal,
      headers: {
        accept: "image/png,image/jpeg,image/webp,image/gif",
        ...(current.hostname === "github.com" ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      const target = location === null ? undefined : redirectUrl(new URL(location, current).href);
      if (target === undefined)
        throw new Error("GitHub image redirect is outside supported GitHub image storage");
      current = target;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub image download returned HTTP ${String(response.status)}`);
    }
    const mediaType =
      (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const extension = extensions[mediaType];
    if (extension === undefined) {
      await response.body?.cancel();
      throw new Error("GitHub response is not PNG, JPEG, WebP or GIF");
    }
    const limit = Math.min(GITHUB_IMAGE_LIMITS.imageBytes, remaining);
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error("GitHub image exceeds the 4 MiB image or 16 MiB total download limit");
    }
    if (response.body === null) throw new Error("GitHub image response has no body");
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit)
          throw new Error("GitHub image exceeds the 4 MiB image or 16 MiB total download limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    if (size === 0) throw new Error("GitHub image response is empty");
    return { bytes: Buffer.concat(chunks), mediaType, extension };
  }
  throw new Error("GitHub image exceeded the redirect limit");
}

/** Controller-only download. Paths are metadata; DSH's read_image validates the raster. */
export async function prepareGitHubImages(options: {
  readonly texts: readonly string[];
  readonly directory: string;
  readonly token: string;
  readonly enabled: boolean;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly images: readonly GitHubImage[]; readonly files: readonly string[] }> {
  const images: GitHubImage[] = [];
  const files: string[] = [];
  let totalBytes = 0;
  let attempted = 0;
  for (const value of references(options.texts)) {
    options.signal.throwIfAborted();
    const source = sourceLabel(value);
    const url = imageUrl(value);
    const reason = !options.enabled
      ? "Image reading requires effective workspace.read permission and Docker isolation"
      : url === undefined
        ? "Only GitHub-hosted upload images are downloaded; external URLs are not fetched"
        : attempted >= GITHUB_IMAGE_LIMITS.count
          ? "The 8-image download limit was reached"
          : undefined;
    if (reason !== undefined || url === undefined) {
      images.push({ source, status: "skipped", reason: reason ?? "Unsupported image URL" });
      continue;
    }
    attempted += 1;
    try {
      const result = await download(
        url,
        options.token,
        AbortSignal.any([options.signal, AbortSignal.timeout(GITHUB_IMAGE_LIMITS.timeoutMs)]),
        options.fetch ?? fetch,
        GITHUB_IMAGE_LIMITS.totalBytes - totalBytes,
      );
      const name = `${createHash("sha256").update(result.bytes).digest("hex")}.${result.extension}`;
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(options.directory, name), result.bytes, { mode: 0o600 });
      totalBytes += result.bytes.length;
      if (!files.includes(name)) files.push(name);
      images.push({
        source,
        status: "ready",
        path: `${WORKER_GITHUB_IMAGES}/${name}`,
        mediaType: result.mediaType,
        bytes: result.bytes.length,
      });
    } catch (error) {
      options.signal.throwIfAborted();
      // Fetch exceptions may contain signed URLs; expose only our bounded failure reasons.
      const reason =
        error instanceof Error && error.message.startsWith("GitHub ")
          ? error.message
          : "GitHub image download failed or timed out";
      images.push({ source, status: "failed", reason });
    }
  }
  return { images, files };
}
