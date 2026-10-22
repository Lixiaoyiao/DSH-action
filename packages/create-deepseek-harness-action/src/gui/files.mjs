import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, mkdir, writeFile, rename, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_BYTES = 256 * 1024;
export const workflowHash = (source) => createHash("sha256").update(source).digest("hex");

export async function workflowPath(root, name) {
  if (!/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ya?ml$/u.test(name))
    throw new Error("Select an ordinary .yml or .yaml file inside .github/workflows.");
  let current = resolve(root);
  for (const part of name.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Symbolic-link workflow paths cannot be edited.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}

export async function readWorkflow(root, name) {
  const path = await workflowPath(root, name);
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size > MAX_BYTES)
      throw new Error("Workflow must be an ordinary file no larger than 256 KiB.");
    const bytes = await readFile(path);
    const source = bytes.toString("utf8");
    if (!Buffer.from(source).equals(bytes)) throw new Error("Workflow is not valid UTF-8.");
    return { path: name, source, hash: workflowHash(source) };
  } catch (error) {
    if (error.code === "ENOENT") return { path: name, source: "", hash: null };
    throw error;
  }
}

export async function listWorkflows(root) {
  await workflowPath(root, ".github/workflows/check.yml");
  let names;
  try {
    names = await readdir(join(root, ".github", "workflows"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = names.filter((name) => /\.ya?ml$/u.test(name));
  if (files.length > 100)
    throw new Error("This GUI supports up to 100 workflow files per repository.");
  return Promise.all(
    files.sort().map(async (name) => {
      const path = `.github/workflows/${name}`;
      try {
        return await readWorkflow(root, path);
      } catch (error) {
        return { path, editable: false, reason: error.message };
      }
    }),
  );
}

/** A preview's expected bytes must still be present. No Git commit or push occurs. */
export async function saveWorkflowChanges(root, changes, options = {}) {
  const entries = [];
  const written = [];
  try {
    for (const change of changes) {
      const original = await readWorkflow(root, change.path);
      if (original.hash !== change.expectedHash)
        throw new Error(`${change.path} changed since preview. Reload and preview again.`);
      const target = await workflowPath(root, change.path);
      await mkdir(join(root, ".github", "workflows"), { recursive: true });
      const suffix = randomBytes(12).toString("hex");
      const staged = `${target}.${suffix}.tmp`;
      const backup = `${target}.${suffix}.bak`;
      await writeFile(staged, change.source, { flag: "wx", mode: 0o600 });
      entries.push({ ...change, target, staged, backup, original, backedUp: false });
    }
    for (const entry of entries) {
      await options.beforeWrite?.(entry.path);
      await workflowPath(root, entry.path);
      const latest = await readWorkflow(root, entry.path);
      if (latest.hash !== entry.expectedHash)
        throw new Error(`${entry.path} changed since preview. Reload and preview again.`);
      if (entry.expectedHash !== null) {
        await rename(entry.target, entry.backup);
        entry.backedUp = true;
        if (workflowHash(await readFile(entry.backup, "utf8")) !== entry.expectedHash)
          throw new Error(`${entry.path} changed during save.`);
      }
      // Exclusive creation also protects a file that appears between the checks.
      await link(entry.staged, entry.target);
      written.push(entry);
    }
  } catch (error) {
    const recovery = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (written.includes(entry)) {
          const current = await readWorkflow(root, entry.path);
          if (current.hash !== workflowHash(entry.source))
            throw new Error("concurrent edit", { cause: error });
          await unlink(entry.target);
        }
        if (entry.backedUp) {
          await link(entry.backup, entry.target);
          await unlink(entry.backup);
          entry.backedUp = false;
        }
      } catch {
        recovery.push(entry.backup);
      }
    }
    if (recovery.length)
      throw new Error(
        `Save interrupted by another edit. Original files retained at: ${recovery.join(", ")}`,
        { cause: error },
      );
    throw error;
  } finally {
    for (const entry of entries) await unlink(entry.staged).catch(() => undefined);
  }
  for (const entry of entries) {
    // A cleanup error must not turn acknowledged writes into a failed save.
    if (entry.backedUp)
      await unlink(entry.backup).catch(() => options.onCleanupWarning?.(entry.backup));
  }
  return entries.map(({ path }) => path);
}

export function workflowDiff(path, before, after) {
  if (before === after) return "";
  const a = before.split(/\r?\n/u),
    b = after.split(/\r?\n/u);
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const context = Math.max(0, start - 3);
  const tail = Math.min(3, a.length - endA);
  return [
    `--- ${before === "" ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ -${context + 1},${endA - context + tail} +${context + 1},${endB - context + tail} @@`,
    ...a.slice(context, start).map((line) => ` ${line}`),
    ...a.slice(start, endA).map((line) => `-${line}`),
    ...b.slice(start, endB).map((line) => `+${line}`),
    ...a.slice(endA, endA + tail).map((line) => ` ${line}`),
  ].join("\n");
}
