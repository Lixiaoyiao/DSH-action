import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import semver from "semver";
import { INSTALLER_ACTION_INPUTS } from "./action-inputs.generated.mjs";

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const TARGET = INSTALLER_ACTION_INPUTS.dshVersion.defaultValue;

async function manifest(path) {
  const details = await stat(path);
  if (!details.isFile() || details.size > 1024 * 1024) throw new Error("invalid manifest");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid manifest");
  return value;
}

function compatibility(installed) {
  const engine = installed.engines?.dsh;
  const ranges =
    engine === undefined
      ? Object.entries(installed.peerDependencies ?? {})
          .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
          .map(([, range]) => range)
      : [engine];
  if (ranges.length === 0)
    return { compatible: true, compatibility: "compatibility not declared; test in Actions" };
  const compatible = ranges.every(
    (range) =>
      typeof range === "string" &&
      semver.validRange(range) !== null &&
      semver.satisfies(TARGET, range, { includePrerelease: true }),
  );
  return {
    compatible,
    compatibility: compatible ? `compatible with DSH ${TARGET}` : `incompatible with DSH ${TARGET}`,
  };
}

async function discover(home, output) {
  let profiles;
  try {
    profiles = await readdir(join(home, "profiles"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("Could not read local DSH profiles. Check --dsh-home and folder access.", {
      cause: error,
    });
  }
  const result = [];
  const seen = new Map();
  for (const profile of profiles
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(home, "profiles", profile.name);
    let local;
    try {
      local = await manifest(join(directory, "package.json"));
    } catch {
      output.write("Skipped a DSH profile with unreadable package metadata.\n");
      continue;
    }
    const bundles = local.dsh?.profile?.bundles;
    for (const [name, source] of Object.entries(local.dependencies ?? {})) {
      if (!PACKAGE.test(name) || name.length > 214 || name.startsWith("@deepseek-ai/")) continue;
      let installed;
      try {
        installed = await manifest(
          join(directory, "node_modules", ...name.split("/"), "package.json"),
        );
      } catch {
        result.push({ name, version: "unknown", reason: "installed metadata is missing" });
        continue;
      }
      const version = semver.valid(installed.version) ?? "unknown";
      const key = `${name}@${version}`;
      const previous = seen.get(key);
      if (previous !== undefined && !result[previous].reason) continue;
      let reason;
      if (installed.name !== name) reason = "npm aliases need manual configuration";
      else if (typeof source !== "string" || semver.validRange(source) === null)
        reason = "local paths and non-registry sources need manual configuration";
      else if (version === "unknown") reason = "installed version is not an exact version";
      else if (!installed.dsh?.bundle?.patch)
        reason = "not a DSH Bundle; configure direct plugins manually";
      else if (!Array.isArray(bundles) || !bundles.includes(name))
        reason = "disabled in the local profile";
      else if (
        Array.isArray(installed.os) &&
        (installed.os.includes("!linux") ||
          (installed.os.some((os) => typeof os !== "string" || !os.startsWith("!")) &&
            !installed.os.includes("linux")))
      )
        reason = "does not support the Linux runner";
      const status = compatibility(installed);
      if (!status.compatible) reason ??= status.compatibility;
      const candidate = { name, version, ...status, ...(reason ? { reason } : {}) };
      if (previous === undefined) {
        seen.set(key, result.length);
        result.push(candidate);
      } else if (!reason) result[previous] = candidate;
    }
  }
  return result;
}

/** Read package metadata only; shared by the CLI and the authenticated local GUI. */
export async function discoverLocalPlugins({
  home,
  env = process.env,
  output = { write: () => undefined },
}) {
  const selectedHome = home ?? (env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
  const expanded =
    selectedHome === "~"
      ? homedir()
      : /^~[\\/]/u.test(selectedHome)
        ? join(homedir(), selectedHome.slice(2))
        : selectedHome;
  return discover(resolve(expanded), output);
}

export function addPluginInputs(contents, selection, review, commands = false) {
  if (!selection) return contents;
  if (commands && selection.allowedTools.length > 0) return contents;
  // Fork reviews keep their existing extension-free path. GitHub expressions
  // contain only package metadata validated above and explicit tool names.
  const sameRepo = "github.event.pull_request.head.repo.full_name == github.repository";
  const config = JSON.stringify(selection.configuration);
  const value = review ? `\${{ ${sameRepo} && '${config}' || '{"schemaVersion":1}' }}` : config;
  const marker = /^([ \t]*)dsh-version: .+$/mu;
  if (!marker.test(contents)) throw new Error("Installer template is missing dsh-version.");
  return contents.replace(marker, (line, indent) =>
    [
      line,
      `${indent}allow-plugin-install: ${review ? `\${{ ${sameRepo} }}` : '"true"'}`,
      `${indent}plugin-config: >-`,
      `${indent}  ${value}`,
      ...(selection.allowedTools.length === 0
        ? []
        : [
            `${indent}allowed-tools: >-`,
            `${indent}  ${review ? `\${{ ${sameRepo} && '${JSON.stringify(selection.allowedTools)}' || '[]' }}` : JSON.stringify(selection.allowedTools)}`,
          ]),
    ].join("\n"),
  );
}
