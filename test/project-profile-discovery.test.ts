import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRepositoryProfile } from "../src/dsh/project-profile.js";
import { githubClientFixture } from "./helpers/github-client.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(entries: readonly string[], selection = "auto") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-profile-discovery-"));
  roots.push(directory);
  const getBlob = vi.fn(({ file_sha }: { file_sha: string }) =>
    Promise.resolve({
      data: {
        sha: file_sha,
        encoding: "base64",
        content: Buffer.from(
          file_sha === "package.json"
            ? "{}"
            : file_sha === "cordis.patch.yml"
              ? "[]"
              : "# Legacy skill",
        ).toString("base64"),
      },
    }),
  );
  const client = githubClientFixture({
    rest: {
      git: {
        getCommit: () => Promise.resolve({ data: { sha: "a".repeat(40), tree: { sha: "root" } } }),
        getTree: ({ tree_sha }: { tree_sha: string }) =>
          Promise.resolve({
            data: {
              sha: tree_sha,
              truncated: false,
              tree:
                tree_sha === "root"
                  ? [{ path: ".dsh", sha: "profile", mode: "040000", type: "tree" }]
                  : tree_sha === "skills"
                    ? [{ path: "SKILL.md", sha: "skill", mode: "100644", type: "blob" }]
                    : entries.map((path) => ({
                        path,
                        sha: path,
                        mode: path === "skills" ? "040000" : "100644",
                        type: path === "skills" ? "tree" : "blob",
                      })),
            },
          }),
        getBlob,
      },
    },
  });
  return {
    getBlob,
    load: () =>
      loadRepositoryProfile({
        client,
        owner: "o",
        repo: "r",
        sourceSha: "a".repeat(40),
        selection,
        directory,
      }),
  };
}
describe("project Profile discovery", () => {
  it("leaves a legacy skills-only .dsh directory on the no-Profile compatibility path", async () => {
    const f = await fixture(["skills"]);
    await expect(f.load()).resolves.toBeUndefined();
    expect(f.getBlob).not.toHaveBeenCalled();
  });
  it.each([["package.json"], ["cordis.patch.yml"]])(
    "does not hide an incomplete Profile with %s",
    async (name) => {
      const f = await fixture([name]);
      await expect(f.load()).rejects.toThrow();
    },
  );
  it("requires a Profile when the directory is explicitly selected", async () => {
    const f = await fixture(["skills"], ".dsh");
    await expect(f.load()).rejects.toThrow(/Profile/);
  });
});
