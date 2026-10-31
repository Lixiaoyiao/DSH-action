import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, mkdir, writeFile, rename, link, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

async function projectPath(root, name) {
  if (!name.startsWith(".dsh/")) return workflowPath(root, name);
  if (
    name.length > 240 ||
    /[\\:\x00-\x1f]/u.test(name) ||
    name
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part === "node_modules" || part === ".git",
      )
  )
    throw new Error("Invalid project Profile path");
  let path = resolve(root);
  for (const part of name.split("/")) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("Symbolic-link Profile paths cannot be edited");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path;
}
async function readProjectFile(root, name) {
  if (!name.startsWith(".dsh/")) return readWorkflow(root, name);
  const path = await projectPath(root, name);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
      throw new Error("Invalid Profile file");
    const data = await readFile(path);
    return { path: name, source: data.toString("utf8"), hash: workflowHash(data) };
  } catch (error) {
    if (error.code === "ENOENT") return { path: name, source: "", hash: null };
    throw error;
  }
}

/** Expected bytes must still be present; batch writes roll back on conflict. */
export async function saveWorkflowChanges(root, changes, options = {}) {
  const entries = [];
  const written = [];
  const read = options.profiles ? readProjectFile : readWorkflow;
  const resolvePath = options.profiles ? projectPath : workflowPath;
  try {
    for (const change of changes) {
      const original = await read(root, change.path);
      if (original.hash !== change.expectedHash)
        throw new Error(`${change.path} changed before save. Read the current file and retry.`);
      const target = await resolvePath(root, change.path);
      await mkdir(dirname(target), { recursive: true });
      const suffix = randomBytes(12).toString("hex");
      const staged = `${target}.${suffix}.tmp`;
      const backup = `${target}.${suffix}.bak`;
      await writeFile(staged, change.source, { flag: "wx", mode: 0o600 });
      entries.push({ ...change, target, staged, backup, original, backedUp: false });
    }
    for (const entry of entries) {
      await options.beforeWrite?.(entry.path);
      await resolvePath(root, entry.path);
      const latest = await read(root, entry.path);
      if (latest.hash !== entry.expectedHash)
        throw new Error(`${entry.path} changed before save. Read the current file and retry.`);
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
          const current = await read(root, entry.path);
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
