import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "../security/record.js";

export function loaderModuleSpecifier(path: string): string {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? pathToFileURL(path).href : path;
}

function importExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = importExportTarget(candidate);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const record = value;
  if (Object.hasOwn(record, ".")) return importExportTarget(record["."]);
  for (const [condition, candidate] of Object.entries(record)) {
    if (condition !== "node" && condition !== "import" && condition !== "default") continue;
    const target = importExportTarget(candidate);
    if (target !== undefined) return target;
  }
  return undefined;
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function installedPluginEntry(
  packageDirectory: string,
  packageName: string,
): Promise<string> {
  const packageReal = await realpath(packageDirectory);
  const decoded: unknown = JSON.parse(await readFile(join(packageReal, "package.json"), "utf8"));
  if (!isRecord(decoded)) throw new Error(`Invalid installed plugin manifest: ${packageName}`);
  const manifest = decoded;
  if (manifest.name !== packageName) {
    throw new Error(`Installed direct plugin package identity mismatch: ${packageName}`);
  }
  const target =
    manifest.exports === undefined
      ? typeof manifest.main === "string"
        ? manifest.main
        : "./index.js"
      : importExportTarget(manifest.exports);
  // Unlike exports targets, legacy main paths do not require a "./" prefix.
  if (!target || (manifest.exports !== undefined && !target.startsWith("./"))) {
    throw new Error(`Direct plugin ${packageName} has no importable root export`);
  }
  let entry = resolve(packageReal, target);
  const details = await stat(entry);
  if (details.isDirectory()) entry = join(entry, "index.js");
  const entryReal = await realpath(entry);
  if (!insideDirectory(packageReal, entryReal)) {
    throw new Error(`Direct plugin ${packageName} entry escapes the installed package`);
  }
  return entryReal;
}

function workerModulePath(workerProfilePath: string, relativeEntry: string): string {
  const parts = relativeEntry.split(/[\\/]/u);
  return workerProfilePath.startsWith("/")
    ? posix.join(workerProfilePath, ...parts)
    : join(workerProfilePath, ...parts);
}

/** Resolve admitted direct plugins from the run-scoped Profile installation root. */
export async function resolveInstalledPluginModuleSpecifiers(options: {
  readonly packageRoot: string;
  readonly workerProfilePath: string;
  readonly plan: {
    readonly plugins: readonly {
      readonly definition: { readonly id: string; readonly package: string };
    }[];
  };
}): Promise<Readonly<Record<string, string>>> {
  const packageRootReal = await realpath(options.packageRoot);
  const resolved: Record<string, string> = {};
  for (const plugin of options.plan.plugins) {
    const packageDirectory = join(
      packageRootReal,
      "node_modules",
      ...plugin.definition.package.split("/"),
    );
    const hostEntry = await installedPluginEntry(packageDirectory, plugin.definition.package);
    if (!insideDirectory(packageRootReal, hostEntry)) {
      throw new Error(`Direct plugin ${plugin.definition.package} resolves outside the Profile`);
    }
    const workerEntry = workerModulePath(
      options.workerProfilePath,
      relative(packageRootReal, hostEntry),
    );
    resolved[plugin.definition.id] = loaderModuleSpecifier(workerEntry);
  }
  return Object.freeze(resolved);
}
