import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkflow,
  saveWorkflowChanges,
  workflowHash,
  workflowPath,
} from "../packages/create-dsh-action/src/workflow-files.mjs";

const roots: string[] = [];
const first = ".github/workflows/dsh-review.yml";
const second = ".github/workflows/dsh-commands.yml";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "dsh-workflow-files-"));
  roots.push(root);
  return root;
}
async function writeWorkflow(root: string, path: string, contents: string) {
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, path), contents);
}

describe("installer safe workflow writes", () => {
  it("creates complete files without leaving staged artifacts", async () => {
    const root = await project();
    expect(
      await saveWorkflowChanges(root, [
        { path: first, source: "complete workflow\n", expectedHash: null },
      ]),
    ).toEqual([first]);
    expect(await readFile(join(root, first), "utf8")).toBe("complete workflow\n");
    expect(await readdir(join(root, ".github/workflows"))).toEqual(["dsh-review.yml"]);
  });

  it("refuses to overwrite existing files and rejects stale expected contents", async () => {
    const root = await project();
    await writeWorkflow(root, first, "concurrent edit");
    for (const expectedHash of [null, workflowHash("old contents")]) {
      await expect(
        saveWorkflowChanges(root, [{ path: first, source: "replacement", expectedHash }]),
      ).rejects.toThrow("changed before save");
    }
    expect((await readWorkflow(root, first)).source).toBe("concurrent edit");
  });

  it("rolls back earlier batch writes when a later destination appears during save", async () => {
    const root = await project();
    await expect(
      saveWorkflowChanges(
        root,
        [
          { path: first, source: "first new file", expectedHash: null },
          { path: second, source: "second new file", expectedHash: null },
        ],
        {
          beforeWrite: async (path) => {
            if (path === second) await writeFile(join(root, second), "concurrent file");
          },
        },
      ),
    ).rejects.toThrow("changed before save");
    await expect(readFile(join(root, first))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, second), "utf8")).toBe("concurrent file");
    expect(await readdir(join(root, ".github/workflows"))).toEqual(["dsh-commands.yml"]);
  });

  it("restores replaced original bytes when a later file changes during save", async () => {
    const root = await project();
    await writeWorkflow(root, first, "first original");
    await writeWorkflow(root, second, "second original");
    await expect(
      saveWorkflowChanges(
        root,
        [
          {
            path: first,
            source: "first replacement",
            expectedHash: workflowHash("first original"),
          },
          {
            path: second,
            source: "second replacement",
            expectedHash: workflowHash("second original"),
          },
        ],
        {
          beforeWrite: async (path) => {
            if (path === second) await writeFile(join(root, second), "concurrent second");
          },
        },
      ),
    ).rejects.toThrow("changed before save");
    expect((await readWorkflow(root, first)).source).toBe("first original");
    expect((await readWorkflow(root, second)).source).toBe("concurrent second");
    expect((await readdir(join(root, ".github/workflows"))).sort()).toEqual([
      "dsh-commands.yml",
      "dsh-review.yml",
    ]);
  });

  it.each([
    "../outside.yml",
    ".github/workflows/../../outside.yml",
    ".github/workflows/nested/file.yml",
    "C:/outside.yml",
  ])("rejects workflow traversal %s", async (path) => {
    await expect(workflowPath(await project(), path)).rejects.toThrow("ordinary");
  });

  it("rejects symlinked parents before reading or writing outside the repository", async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, ".github"));
    await symlink(
      outside,
      join(root, ".github/workflows"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(readWorkflow(root, first)).rejects.toThrow("Symbolic-link");
    await expect(
      saveWorkflowChanges(root, [{ path: first, source: "outside write", expectedHash: null }]),
    ).rejects.toThrow("Symbolic-link");
    expect(await readdir(outside)).toEqual([]);
  });
});
