import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import semver from "semver";
import { INSTALLER_ACTION_INPUTS, INSTALLER_RUNTIME_DEPENDENCIES } from "./action-inputs.generated.mjs";

// Cordis' native !!js representation. Parsing/import never evaluates expressions.
const jsTag = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value) => ({ __jsExpr: value }),
  identify: (value) => value && typeof value === "object" && typeof value.__jsExpr === "string",
  stringify: (item) => item.value.__jsExpr,
};
const yamlOptions = { customTags: [jsTag] };
const TARGET = INSTALLER_ACTION_INPUTS.dshVersion.defaultValue;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const secretName =
  /(?:api[-_]?key|secret|password|token|authorization|cookie|credential|private[-_]?key)/iu;
function credentialField(parts) {
 const key=parts.at(-1)??"";const owner=parts.at(-2);
 return (secretName.test(key)&&!/(?:Env|EnvName)$/u.test(key)) || owner === "env" || (owner === "headers" && !["accept","content-type","user-agent"].includes(key.toLowerCase()));
}
const machineFile =
  /^(?:\.env(?:\..*)?|\.credentials.*|\.npmrc|compatibility\.json|settings\.yaml|sessions|storages|attachments|logs|cache|node_modules|\.git|\.anonymous-user-id)$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function resolveProfileHome(home, env = process.env) {
  const chosen = home ?? (env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
  return resolve(
    chosen === "~"
      ? homedir()
      : /^~[\\/]/u.test(chosen)
        ? join(homedir(), chosen.slice(2))
        : chosen,
  );
}
export async function discoverProfiles({ home, env } = {}) {
  const root = resolveProfileHome(home, env);
  let entries;
  try {
    entries = await readdir(join(root, "profiles"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const manifest = JSON.parse(
        await readFile(join(root, "profiles", entry.name, "package.json"), "utf8"),
      );
      profiles.push({
        name: entry.name,
        bundles: manifest.dsh?.profile?.bundles ?? [],
        dependencies: Object.keys(manifest.dependencies ?? {}).length,
      });
    } catch {
      profiles.push({ name: entry.name, error: "Unreadable Profile package.json" });
    }
  }
  return profiles;
}
export function defaultProjectFiles({ mode = "review", dshMode = "controlled" } = {}) {
  const allowed = [
    "workspace.read",
    "workspace.search",
    "workspace.edit",
    "native.web-search",
    "native.web-fetch",
  ];
  if (mode === "commands" || mode === "both") allowed.push("native.bash", "native.subagent");
  return [
    {
      path: ".dsh/package.json",
      source:
        JSON.stringify(
          {
            name: "dsh-project-profile",
            private: true,
            type: "module",
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
            dependencies: {},
          },
          null,
          2,
        ) + "\n",
      expectedHash: null,
    },
    {
      path: ".dsh/cordis.patch.yml",
      source:
        "# Native DSH Profile. Commit changes here for the next Action run.\n" +
        YAML.stringify(
          dshMode === "controlled"
            ? [
                {
                  id: "dsh-action-policy",
                  config: { allowedTools: allowed, deniedTools: [], rules: [] },
                },
              ]
            : [],
          yamlOptions,
        ),
      expectedHash: null,
    },
  ];
}

export async function previewProfileImport({ home, env, profile }) {
  if (
    !profile ||
    profile.includes("/") ||
    profile.includes("\\") ||
    profile === "." ||
    profile === ".."
  )
    throw new Error("Choose one named local Profile");
  const root = resolveProfileHome(home, env),
    directory = join(root, "profiles", profile);
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Profile source cannot be a symbolic link");
  const reports = [],
    requiredEnv = new Set(),
    resources = new Map(),
    sourceHashes = new Map();
  let totalBytes = 0;
  async function read(path) {
    const metadata = await lstat(path);
    if (metadata.size > 8 * 1024 * 1024 - totalBytes)
      throw new Error("Profile migration exceeds 8 MiB");
    const data = await readFile(path);
    totalBytes += data.length;
    if (totalBytes > 8 * 1024 * 1024) throw new Error("Profile migration exceeds 8 MiB");
    sourceHashes.set(path, digest(data));
    return data;
  }
  const original = JSON.parse((await read(join(directory, "package.json"))).toString("utf8"));
  const bundles = original.dsh?.profile?.bundles;
  if (
    !Array.isArray(bundles) ||
    bundles.some((name) => typeof name !== "string" || !packageName.test(name))
  )
    throw new Error("Profile needs native package.json dsh.profile.bundles");
  const dependencies = {};
  for (const [name, spec] of Object.entries(original.dependencies ?? {})) {
    if (!packageName.test(name) || typeof spec !== "string" || semver.validRange(spec) === null) {
      reports.push({
        kind: "blocked",
        field: `dependencies.${name}`,
        reason:
          "Local paths, aliases and mutable non-registry sources require an explicit portable package",
      });
      continue;
    }
    let version = semver.valid(spec);
    let installed;
    try {
      installed = JSON.parse(
        (await read(join(directory, "node_modules", ...name.split("/"), "package.json"))).toString(
          "utf8",
        ),
      );
      version = semver.valid(installed.version) ?? version;
    } catch {
      /* Exact registry versions do not require an installed local copy. */
    }
    if (!version) {
      reports.push({
        kind: "blocked",
        field: `dependencies.${name}`,
        reason: "Cannot resolve an exact installed version",
      });
      continue;
    }
    if (installed?.name !== undefined && installed.name !== name) {
      reports.push({
        kind: "blocked",
        field: `dependencies.${name}`,
        reason: "Package alias identity mismatch",
      });
      continue;
    }
    const requirements = installed?.engines?.dsh;
    if (requirements === undefined)
      for (const [peer, range] of Object.entries(installed?.peerDependencies ?? {}))
        if (
          /^@deepseek-ai\/dsh(?:-|$)/u.test(peer) &&
          !semver.satisfies(TARGET, range, { includePrerelease: true })
        )
          reports.push({
            kind: "blocked",
            field: name,
            reason: `Peer ${peer} is incompatible with cloud DSH ${TARGET}`,
          });
    if (requirements && !semver.satisfies(TARGET, requirements, { includePrerelease: true }))
      reports.push({
        kind: "blocked",
        field: name,
        reason: `Incompatible with cloud DSH ${TARGET}`,
      });
    if (
      installed?.os?.includes("!linux") ||
      (installed?.os?.some((v) => !v.startsWith("!")) && !installed.os.includes("linux"))
    )
      reports.push({ kind: "blocked", field: name, reason: "Package does not support Linux" });
    if(/^@deepseek-ai\/dsh(?:-|$)/u.test(name)&&version!==TARGET)reports.push({kind:"blocked",field:name,reason:`Cannot mix DSH versions; Action requires ${TARGET}`});
    if (INSTALLER_RUNTIME_DEPENDENCIES[name] !== undefined) {
      if (version !== INSTALLER_RUNTIME_DEPENDENCIES[name])
        reports.push({
          kind: "blocked",
          field: name,
          reason: `Requires ${name}@${version}; Action locks ${INSTALLER_RUNTIME_DEPENDENCIES[name]}`,
        });
      else reports.push({ kind: "reused", field: name, reason: "Provided by the pinned runtime" });
    } else dependencies[name] = version;
  }
  for (const key of ["scripts", "overrides", "resolutions"])
    if (original[key] !== undefined)
      reports.push({
        kind: "blocked",
        field: `package.json.${key}`,
        reason: "Must be replaced with portable dependencies; not copied or executed",
      });
  let patches = [];
  for (const path of [join(directory, "cordis.patch.yml"), join(root, "cordis.patch.yml")]) {
    try {
      const parsed = YAML.parse((await read(path)).toString("utf8"), yamlOptions);
      if (!Array.isArray(parsed)) throw new Error("Expected a native patch array");
      patches.push(...parsed);
      reports.push({
        kind: "imported",
        field: path === join(root, "cordis.patch.yml") ? "Home patch" : "Profile patch",
        reason: "Preserved in official application order",
      });
    } catch (error) {
      if (error.code === "ENOENT" && path === join(root, "cordis.patch.yml")) continue;
      throw new Error("Could not parse the native Profile/Home patch", { cause: error });
    }
  }
  async function resource(relativePath, moduleName=false) {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (
      !normalized ||
      normalized.split("/").some((p) => !p || p === ".." || p === "." || machineFile.test(p))
    )
      throw new Error("Resource must be inside the Profile and contain no machine state");
    let current = directory;
    for (const part of normalized.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Resource symbolic links cannot be migrated");
    }
    if ((await lstat(current)).isDirectory()) {
      for (const entry of await readdir(current)) await resource(`${normalized}/${entry}`);
    } else {
      if (resources.size >= 256) throw new Error("Too many Profile resources");
      const data = await read(current);
      if (!Buffer.from(data.toString("utf8")).equals(data))
        throw new Error("Binary local resources require explicit repository management");
      resources.set(normalized, data.toString("utf8"));
    }
    return moduleName ? `./${normalized}` : {__jsExpr:`ctx.profileContext.dir + ${JSON.stringify("/"+normalized)}`};
  }
  const fieldName = (parts) => parts.join(".");
  function reference(parts, prefix = "") {
    const name = `HARNESS_${parts
      .join("_")
      .replace(/[^A-Za-z0-9_]/gu, "_")
      .toUpperCase()}`.slice(0, 120);
    requiredEnv.add(name);
    reports.push({
      kind: "credential-reference",
      field: fieldName(parts),
      reason: `Set GitHub Secret ${name}${prefix ? "; store the token without its Bearer prefix" : ""}; credential value is not copied`,
    });
    return {
      __jsExpr: prefix ? `${JSON.stringify(prefix)} + process.env.${name}` : `process.env.${name}`,
    };
  }
  async function sanitize(value, parts = []) {
    if (Array.isArray(value))
      return Promise.all(value.map((v, i) => sanitize(v, [...parts, String(i)])));
    if (value && typeof value === "object") {
      if (typeof value.__jsExpr === "string") {
        const match = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value.__jsExpr.trim());
        if (!match) {
          reports.push({
            kind: "blocked",
            field: fieldName(parts),
            reason: "Dynamic expression needs review; not evaluated or silently removed",
          });
          return value;
        }
        if (
          !["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_SEARCH_BASE_URL"].includes(match[1])
        )
          requiredEnv.add(match[1]);
        return value;
      }
      const result = {};
      for (const [key, child] of Object.entries(value))
        result[key] = await sanitize(child, [...parts, key]);
      return result;
    }
    if (typeof value !== "string") return value;
    const key = parts.at(-1) ?? "";
    if (credentialField(parts) && value !== "")
      return reference(parts, /^Bearer\s/iu.test(value) ? "Bearer " : "");
    if (/(?:^https?:\/\/[^/]*@|[?&](?:token|key|secret|signature|api_key)=)/iu.test(value)) {
      reports.push({
        kind: "blocked",
        field: fieldName(parts),
        reason: "Authenticated URL must use an environment reference",
      });
      return "";
    }
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]|^~[\\/]/u.test(value)) {
      const rel = relative(directory, resolve(value));
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        try {
          return await resource(rel,key === "name");
        } catch {
          /* Report the source field without exposing the local path. */
        }
      }
      reports.push({
        kind: "blocked",
        field: fieldName(parts),
        reason: "Machine-specific path needs a portable replacement",
      });
      return "";
    }
    if (value.startsWith("./") && ["name", "path", "cwd", "file", "promptFile"].includes(key)) {
      try {
        return await resource(value,key === "name");
      } catch {
        reports.push({
          kind: "blocked",
          field: fieldName(parts),
          reason: "Referenced local resource cannot be safely migrated",
        });
      }
    }
    if (
      ["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh.exe"].includes(value) &&
      key === "command"
    )
      reports.push({
        kind: "blocked",
        field: fieldName(parts),
        reason: "Windows-only command requires a Linux equivalent",
      });
    return value;
  }
  const secretValues = [];
  function collectSecrets(value,parts=[]) {
    if (Array.isArray(value)) {
      value.forEach((child,index)=>collectSecrets(child,[...parts,String(index)]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        secretName.test(key) &&
        !/(?:Env|EnvName)$/.test(key) &&
        child.length >= 4
      )
        secretValues.push(child, child.replace(/^Bearer\s+/iu, ""));
      else collectSecrets(child,[...parts,key]);
    }
  }
  collectSecrets(patches);
  patches = await sanitize(patches);
  for (const [path, content] of resources) {
    const secret =
      secretValues.some((value) => value.length >= 4 && content.includes(value)) ||
      /(?:api[_-]?key|password|token|secret|authorization|cookie)["']?\s*[:=]\s*["']?(?!process\.env|\$\{)[A-Za-z0-9_+/-]{4}/iu.test(
        content,
      ) ||
      /-----BEGIN .*PRIVATE KEY-----/u.test(content);
    const credentialUrl=/(?:https?:\/\/[^/\s]+@|[?&](?:token|key|secret|signature|api_key)=)/iu.test(content);
    const local = /\b[A-Za-z]:[\\/]|(?:["'\s])\/(?:home|Users)\/|~[\\/]/u.test(content);
    if (secret || local || /^(?:profile-runtime|action-.*|native-launcher)\.mjs$/u.test(path)) {
      resources.delete(path);
      reports.push({
        kind: "blocked",
        field: path,
        reason: secret || credentialUrl
          ? "Referenced resource contains credentials; replace them with a native environment reference"
          : local
            ? "Referenced resource contains machine-specific paths"
            : "Reserved Action runtime resource name",
      });
    }
  }
  for (const name of requiredEnv)
    if (/^(?:GITHUB_|GH_|ACTIONS_|INPUT_|DEEPSEEK_|DSH_|NODE_|NPM_|LD_|DYLD_)/iu.test(name))
      reports.push({
        kind: "blocked",
        field: name,
        reason: "Reserved Controller or runtime environment variable",
      });
  try {
    const legacy = await lstat(join(root, "settings.yaml"));
    if (legacy.isFile() && legacy.size > 0)
      reports.push({
        kind: "blocked",
        field: "settings.yaml",
        reason:
          "Legacy settings must first be migrated by official DSH into the selected Profile; they are not machine state and were not silently discarded",
      });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of await readdir(root))
    if (machineFile.test(file))
      reports.push({
        kind: "omitted",
        field: file,
        reason: "Machine state or credentials are not migrated",
      });
  for (const filename of ["package-lock.json", "pnpm-lock.yaml"]) {
    try {
      await lstat(join(directory, filename));
      reports.push({
        kind: "omitted",
        field: filename,
        reason:
          "Source lock describes the local installation. Generate the project lock with npm after reviewing the pinned project dependencies; locks are never hand-merged with the Action runtime.",
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const selectedBundles = [
    ...new Set([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-headless",
      ...bundles.filter(
        (b) => !/^@deepseek-ai\/dsh-(?:web-app|acp-app|sdk-app|sdk-minimal)$/u.test(b),
      ),
    ]),
  ];
  if (selectedBundles.length !== bundles.length || selectedBundles.some((b, i) => b !== bundles[i]))
    reports.push({
      kind: "converted",
      field: "dsh.profile.bundles",
      reason: "Use the official base + headless entrypoint in Actions",
    });
  reports.push({kind:"not_checked",field:"runtime activation",reason:"Headless plugin activation and provider availability are verified by the Action; preview does not execute imported code"});
  const files = [
    {
      path: ".dsh/package.json",
      source:
        JSON.stringify(
          {
            name: "dsh-project-profile",
            private: true,
            type: "module",
            dsh: { profile: { bundles: selectedBundles } },
            dependencies,
          },
          null,
          2,
        ) + "\n",
      expectedHash: null,
    },
    {
      path: ".dsh/cordis.patch.yml",
      source: YAML.stringify(patches, yamlOptions),
      expectedHash: null,
    },
    ...Array.from(resources, ([path, source]) => ({
      path: `.dsh/${path}`,
      source,
      expectedHash: null,
    })),
  ];
  return {
    profile,
    files,
    reports,
    requiredEnv: [...requiredEnv].sort(),
    blocked: reports.some((r) => r.kind === "blocked"),
    async validate() {
      for (const [path, expected] of sourceHashes)
        if (digest(await readFile(path)) !== expected)
          throw new Error("Source Profile changed after preview; review again");
    },
  };
}

export function printProfilePreview(preview, output) {
  output.write(`\nProfile migration preview: ${preview.profile}\n`);
  for (const report of preview.reports)
    output.write(`  [${report.kind}] ${report.field}: ${report.reason}\n`);
  for (const file of preview.files) output.write(`  create ${file.path}\n`);
  output.write("No local credentials, Session history or machine state will be copied.\n");
}
export async function selectProfileImport({ home, env, prompt, output, selected, skip = false }) {
  if (skip) return undefined;
  const profiles = await discoverProfiles({ home, env });
  if (profiles.length === 0 && !selected) return undefined;
  output.write("\nLocal DSH Profiles:\n");
  profiles.forEach((p, i) =>
    output.write(
      `  ${i + 1}) ${p.name} (${p.bundles?.length ?? 0} Bundles)${p.error ? " — " + p.error : ""}\n`,
    ),
  );
  let profile = selected;
  if (!profile) {
    const answer = (
      await prompt.question("Profile number to import (Enter creates a fresh project Profile): ")
    ).trim();
    if (!answer) return undefined;
    profile = profiles[Number(answer) - 1]?.name;
    if (!profile) throw new Error("Choose a listed Profile number");
  }
  const preview = await previewProfileImport({ home, env, profile });
  printProfilePreview(preview, output);
  if (preview.blocked)
    throw new Error(
      "Profile migration has blocked fields. Resolve the listed incompatibilities before importing.",
    );
  if (
    !/^(y|yes)$/iu.test(
      (await prompt.question("Create this native project Profile? [y/N]: ")).trim(),
    )
  )
    return undefined;
  return preview;
}

export function workflowWithProfile(source, requiredEnv = []) {
  const doc = YAML.parseDocument(source);
  for (const job of Object.values(doc.toJS().jobs ?? {})) void job;
  const jobs = doc.get("jobs");
  for (const pair of jobs?.items ?? []) {
    const steps = pair.value?.get?.("steps");
    for (const step of steps?.items ?? []) {
      if (!String(step.get?.("uses") ?? "").startsWith("Lixiaoyiao/DSH-action@")) continue;
      const inputs = step.get("with");
      for (const key of [
        "model",
        "reasoning-effort",
        "permission-profile",
        "allowed-tools",
        "disallowed-tools",
        "mcp-config",
        "plugin-config",
        "allow-plugin-install",
      ])
        inputs?.delete(key);
      if (requiredEnv.length) {
        inputs.set("dsh-env", JSON.stringify(requiredEnv));
        for (const name of requiredEnv)
          doc.setIn(
            ["jobs", pair.key.value, "steps", steps.items.indexOf(step), "env", name],
            `\${{ secrets.${name} }}`,
          );
      }
    }
  }
  return doc.toString({ lineWidth: 0 });
}
