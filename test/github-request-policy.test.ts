import { finishRunReport } from "../src/result.js";
import { describe, expect, it, vi } from "vitest";

import { createRequestPolicy, GitHubQuotaError } from "../src/github/request-policy.js";
import { buildActionOutputs, describeActionFailure, formatStepSummary } from "../src/result.js";

const sha = "a".repeat(40);
const blob = { method: "GET", url: `/repos/o/r/git/blobs/${sha}`, request: { dshImmutable: true } };
function quota(status = 429, headers: Record<string, string> = {}) {
  return Object.assign(new Error("private server body secret-token"), {
    status,
    response: { headers },
  });
}

describe("run-scoped GitHub request policy", () => {
  it("caches and merges only explicitly selected immutable reads, with isolated return values", async () => {
    const policy = createRequestPolicy();
    const request = vi.fn(() => Promise.resolve({ data: { content: "text" } }));
    const [first, second] = await Promise.all([
      policy.run(request, blob),
      policy.run(request, blob),
    ]);
    first.data.content = "changed";
    expect(second.data.content).toBe("text");
    expect((await policy.run(request, blob)).data.content).toBe("text");
    expect(request).toHaveBeenCalledOnce();
    expect(policy.snapshot()).toMatchObject({ requests: 1, cacheHits: 1, coalesced: 1 });
  });

  it("keeps permissions, refs, identity checks, mutation reconciliation and writes fresh", async () => {
    const policy = createRequestPolicy();
    const request = vi.fn(() => Promise.resolve({ data: {} }));
    for (const options of [
      { ...blob, request: {} },
      { ...blob, url: "/repos/o/r/collaborators/operator/permission" },
      { ...blob, url: "/repos/o/r/git/ref/heads/main" },
      { ...blob, url: `/repos/o/r/git/commits/${sha}` },
      { ...blob, url: "/repos/o/r/issues/1" },
      { ...blob, method: "POST" },
    ]) {
      await Promise.all([policy.run(request, options), policy.run(request, options)]);
    }
    expect(request).toHaveBeenCalledTimes(12);
    expect(policy.snapshot()).toMatchObject({ cacheHits: 0, coalesced: 0 });
  });

  it("supports Octokit template URLs while separating response variants and runs", async () => {
    const first = createRequestPolicy();
    const second = createRequestPolicy();
    const request = vi.fn(() => Promise.resolve({ data: {} }));
    const template = {
      ...blob,
      url: "/repos/{owner}/{repo}/git/trees/{tree_sha}",
      owner: "o",
      repo: "r",
      tree_sha: sha,
    };
    await first.run(request, template);
    await first.run(request, template);
    await first.run(request, { ...template, recursive: "1" });
    await second.run(request, template);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retain failures or oversized response bodies", async () => {
    const policy = createRequestPolicy();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ data: "x".repeat(2 * 1024 * 1024) });
    await expect(policy.run(request, blob)).rejects.toThrow("temporary failure");
    await policy.run(request, blob);
    await policy.run(request, blob);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("bounds retained cache entry count", async () => {
    const policy = createRequestPolicy();
    const request = vi.fn(() => Promise.resolve({ data: {} }));
    for (let index = 0; index < 130; index += 1) {
      await policy.run(request, {
        ...blob,
        url: `/repos/o/r/git/blobs/${index.toString(16).padStart(40, "0")}`,
      });
    }
    await policy.run(request, blob);
    await policy.run(request, blob);
    expect(request).toHaveBeenCalledTimes(132);
  });

  it("retries quota-limited reads with bounded header-aware waiting", async () => {
    let now = 1_000_000;
    const sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    const policy = createRequestPolicy({ now: () => now, sleep, deadlineMs: now + 60_000 });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        quota(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1002",
          "x-ratelimit-resource": "core",
        }),
      )
      .mockResolvedValue({ data: {} });
    await policy.run(request, { method: "GET", url: "/repos/o/r" });
    expect(sleep).toHaveBeenCalledWith(2250, undefined);
    expect(policy.snapshot()).toMatchObject({
      requests: 2,
      retries: 1,
      waitMs: 2250,
      resetAt: "1970-01-01T00:16:42.000Z",
      resource: "core",
    });
  });

  it("never retries writes, unknown network effects, or definite permission errors", async () => {
    const policy = createRequestPolicy();
    const write = vi.fn().mockRejectedValue(quota());
    await expect(
      policy.run(write, { method: "POST", url: "/repos/o/r/issues" }),
    ).rejects.toBeInstanceOf(GitHubQuotaError);
    expect(write).toHaveBeenCalledOnce();
    for (const error of [new Error("connection lost"), quota(403), quota(401)]) {
      const request = vi.fn().mockRejectedValue(error);
      await expect(policy.run(request, blob)).rejects.toBe(error);
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it("fails rather than waiting past the task budget or a long reset", async () => {
    for (const deadlineMs of [1001000, 2000000]) {
      const sleep = vi.fn();
      const policy = createRequestPolicy({ now: () => 1000000, sleep, deadlineMs });
      const request = vi.fn().mockRejectedValue(quota(429, { "retry-after": "30" }));
      await expect(policy.run(request, blob)).rejects.toBeInstanceOf(GitHubQuotaError);
      expect(request).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("classifies headerless secondary 403 limits without exposing the server message or retrying writes", async () => {
    for (const method of ["GET", "POST"]) {
      const sleep = vi.fn();
      const policy = createRequestPolicy({ now: () => 1000000, sleep, deadlineMs: 2000000 });
      const error = Object.assign(new Error("private error"), {
        status: 403,
        response: {
          headers: { "x-ratelimit-remaining": "50" },
          data: { message: "You have exceeded a SECONDARY RATE LIMIT. secret-token" },
        },
      });
      const request = vi.fn().mockRejectedValue(error);
      await expect(policy.run(request, { method, url: "/private/repository" })).rejects.toThrow(
        GitHubQuotaError,
      );
      expect(request).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(policy.snapshot()).toMatchObject({ quotaFailures: 1, retries: 0, waitMs: 0 });
      expect(JSON.stringify(policy.snapshot())).not.toMatch(/secret-token|private/u);
    }
  });

  it("bounds repeated 429 reads and cancellation without replaying a task", async () => {
    let now = 1000000;
    const sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    const policy = createRequestPolicy({ now: () => now, sleep, deadlineMs: 1060000 });
    const request = vi.fn().mockRejectedValue(quota(429, { "retry-after": "1" }));
    await expect(policy.run(request, blob)).rejects.toBeInstanceOf(GitHubQuotaError);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      policy.run(request, { ...blob, request: { dshImmutable: true, signal: controller.signal } }),
    ).rejects.toThrow("cancelled");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("exports only bounded counters and recovery time, and gives scope-specific guidance", async () => {
    const policy = createRequestPolicy();
    const request = vi.fn().mockRejectedValue(
      quota(429, {
        "retry-after": "600",
        authorization: "secret-token",
        "x-ratelimit-resource": "core",
      }),
    );
    let failure;
    try {
      await policy.run(request, { method: "POST", url: "/private/repository" });
    } catch (error) {
      failure = describeActionFailure(error, "write");
    }
    const outcome = {
      schemaVersion: 1 as const,
      conclusion: "failure" as const,
      summary: "quota",
      findingsCount: 0,
      durationMs: 1,
      githubRequests: policy.snapshot(),
      ...(failure === undefined ? {} : { error: failure }),
    };
    const output = JSON.stringify(buildActionOutputs(finishRunReport(outcome)));
    expect(output).not.toMatch(/secret-token|private server|private\/repository/u);
    expect(output).toContain("GITHUB_QUOTA_EXHAUSTED");
    expect(output).toContain("production-action");
    expect(formatStepSummary(finishRunReport(outcome))).toContain("Quota recovery");
    expect(failure?.guidance).toContain("installation");
  });
});
