import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { materializeRepositoryAtSha } from "../src/github/repository.js";
import { createGitHubCommitFromWorkspace } from "../src/write/github.js";
import {
  applyWorkspaceChanges,
  createWorkspaceSnapshot,
  inspectWorkspaceChanges,
} from "../src/write/workspace.js";
import { githubClientFixture } from "./helpers/github-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("binary file byte integrity", () => {
  it("preserves binary blobs through materialization, worker reads, saves and Git Blob publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-binary-roundtrip-"));
    roots.push(root);
    const source = join(root, "source");
    const worker = join(root, "worker");
    const original = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const changed = Buffer.from(original).reverse();
    // A complete one-pixel PNG also checks a real supported image's raw bytes.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    );
    const commitSha = "a".repeat(40);
    const treeSha = "b".repeat(40);
    const originalBlobSha = "c".repeat(40);
    const published = new Map<string, Buffer>();
    const createBlob = vi.fn(({ content, encoding }: { content: string; encoding: string }) => {
      expect(encoding).toBe("base64");
      const bytes = Buffer.from(content, "base64");
      const sha = createHash("sha1")
        .update(`blob ${String(bytes.byteLength)}\0`)
        .update(bytes)
        .digest("hex");
      published.set(sha, bytes);
      return Promise.resolve({ data: { sha } });
    });
    const createTree = vi.fn().mockResolvedValue({ data: { sha: "d".repeat(40) } });
    const createCommit = vi.fn().mockResolvedValue({ data: { sha: "e".repeat(40) } });
    const client = githubClientFixture({
      rest: {
        git: {
          getCommit: vi
            .fn()
            .mockResolvedValue({ data: { sha: commitSha, tree: { sha: treeSha } } }),
          getTree: vi.fn().mockResolvedValue({
            data: {
              sha: treeSha,
              truncated: false,
              tree: [
                {
                  path: "opaque.data",
                  type: "blob",
                  mode: "100644",
                  sha: originalBlobSha,
                  size: original.byteLength,
                },
              ],
            },
          }),
          getBlob: vi.fn().mockResolvedValue({
            data: {
              sha: originalBlobSha,
              encoding: "base64",
              content: original.toString("base64"),
            },
          }),
          createBlob,
          createTree,
          createCommit,
        },
      },
    });

    await materializeRepositoryAtSha(client, "o", "r", commitSha, source);
    const snapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      worker,
    );
    expect(await readFile(join(worker, "opaque.data"))).toEqual(original);
    await writeFile(join(worker, "opaque.data"), changed);
    await writeFile(join(worker, "pixel.png"), png);
    const changes = await inspectWorkspaceChanges(snapshot);
    expect(changes).toEqual({
      added: ["pixel.png"],
      modified: ["opaque.data"],
      deleted: [],
      all: ["opaque.data", "pixel.png"],
    });
    await applyWorkspaceChanges(snapshot, changes);
    expect(await readFile(join(source, "opaque.data"))).toEqual(changed);
    expect(await readFile(join(source, "pixel.png"))).toEqual(png);

    const result = await createGitHubCommitFromWorkspace(
      client,
      { owner: "o", repo: "r", baseSha: commitSha, message: "Preserve binary bytes" },
      snapshot,
    );

    expect(result.paths).toEqual(["opaque.data", "pixel.png"]);
    expect(createBlob).toHaveBeenCalledTimes(2);
    expect([...published.values()]).toEqual([png, changed]);
    expect(createTree).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      base_tree: treeSha,
      tree: [
        { path: "pixel.png", type: "blob", mode: "100644", sha: [...published.keys()][0] },
        { path: "opaque.data", type: "blob", mode: "100644", sha: [...published.keys()][1] },
      ],
    });
    expect(createCommit).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      message: "Preserve binary bytes",
      tree: "d".repeat(40),
      parents: [commitSha],
    });
  });
});
