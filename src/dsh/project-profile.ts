import { pinnedPackageSourceSchema } from "../extensions/schema.js";
import { LOCKED_RUNTIME_PACKAGES } from "./runtime-packages.generated.js";
import { assertNoSecretOutput } from "../security/env.js";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import type { ActionInputs } from "../inputs.js";
import type { SecurityPolicy } from "../security/policy.js";
import { canonicalJson } from "../security/canonical-json.js";
import {
  allowedToolIdSchema,
  mcpToolId,
  pluginToolId,
  type AllowedToolId,
} from "../tools/schema.js";
import type { ExtensionPlan, ExtensionToolGrant } from "../extensions/plan.js";
import { resolveExtensionPlan, emptyNativeExtensionPlan } from "../extensions/plan.js";
import { DshConfigurationError } from "./errors.js";
import { DSH_VERSION } from "../release.js";

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const BUILTIN_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];
const policySchema = z.strictObject({
  allowedTools: z
    .array(allowedToolIdSchema)
    .default([
      "workspace.read",
      "workspace.search",
      "workspace.edit",
      "native.web-search",
      "native.web-fetch",
    ]),
  deniedTools: z.array(allowedToolIdSchema).default([]),
  rules: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^(?:mcp|plugin)\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/u)
          .transform((value) => {
            const [provider, owner, tool] = value.split(".");
            return provider === "mcp"
              ? mcpToolId(owner ?? "", tool ?? "")
              : pluginToolId(owner ?? "", tool ?? "");
          }),
        runtimeName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
        permissions: z.array(z.enum(["read", "workspace-write", "network"])).min(1),
        timeoutMs: z.number().int().min(100).max(1800000).default(60000),
        maxOutputBytes: z.number().int().min(1024).max(2097152).default(131072),
        maxCalls: z.number().int().min(1).max(100).default(10),
        groupMaxCalls: z.number().int().min(1).max(1000).default(30),
      }),
    )
    .max(256)
    .default([]),
});
export interface ProjectProfileAudit {
  readonly sourceSha: string;
  readonly path: string;
  readonly digest: string;
  readonly withheld?: boolean;
}
export interface ProjectProfile {
  readonly audit: ProjectProfileAudit;
  readonly manifest: Record<string, unknown>;
  readonly bundles: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly patch: string;
  readonly files: Readonly<Record<string, string>>;
  readonly policy: z.infer<typeof policySchema>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function profilePath(path: string): string {
  if (
    path.length > 240 ||
    !path ||
    /[\\:]/u.test(path) ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p === ".git" || p === "node_modules")
  )
    throw new DshConfigurationError(
      "dsh-profile must name a normalized repository-relative directory",
    );
  return path;
}
function admittedFile(path: string): void {
  profilePath(path);
  if (
    path
      .split("/")
      .some((p) =>
        /^\.env(?:\.|$)|^\.credentials|^\.npmrc$|^compatibility\.json$|^action-.*\.mjs$|^action-.*\.yml$|^native-launcher\.mjs$|^profile-runtime\.mjs$|^\.action-/u.test(
          p,
        ),
      )
  )
    throw new DshConfigurationError(
      `Profile contains a credential, machine-state or reserved runtime file: ${path}`,
    );
}
/** Reads data only; the official parser keeps !!js inert until Worker activation. */
export async function readProjectProfile(
  directory: string,
  source: { sourceSha: string; path: string },
  knownSecrets: readonly string[] = [],
): Promise<ProjectProfile> {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      admittedFile(path);
      if (entry.isSymbolicLink())
        throw new DshConfigurationError("Profile symbolic links are forbidden");
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new DshConfigurationError("Profile must contain ordinary files");
      const data = await readFile(join(directory, path));
      assertNoSecretOutput("environment", data.toString("utf8"), knownSecrets);
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024 || Object.keys(files).length >= 256)
        throw new DshConfigurationError("Profile exceeds 256 files or 8 MiB");
      files[path] = data.toString("base64");
    }
  }
  if ((await lstat(directory)).isSymbolicLink())
    throw new DshConfigurationError("Profile directory must not be a symbolic link");
  await walk("");
  const manifest = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(files["package.json"] ?? "", "base64").toString("utf8")));
  assertNoSecretOutput("environment", JSON.stringify(manifest), knownSecrets);
  const declaration = z
    .object({ profile: z.object({ bundles: z.array(z.string().regex(PACKAGE)).max(64) }) })
    .parse(manifest.dsh);
  if (new Set(declaration.profile.bundles).size !== declaration.profile.bundles.length)
    throw new DshConfigurationError("Duplicate Profile Bundle");
  const dependencies = z
    .record(z.string().regex(PACKAGE), z.string())
    .parse(manifest.dependencies ?? {});
  for (const [name, version] of Object.entries(dependencies)) {
    if (/^@deepseek-ai\/dsh(?:-|$)/u.test(name) && version !== DSH_VERSION)
      throw new DshConfigurationError("Profile cannot mix DSH package-family versions");
    if (!pinnedPackageSourceSchema.safeParse(version).success)
      throw new DshConfigurationError(
        "Profile dependency " + name + " requires an exact version or immutable Git source",
      );
    if (LOCKED_RUNTIME_PACKAGES[name] !== undefined && version !== LOCKED_RUNTIME_PACKAGES[name])
      throw new DshConfigurationError(
        `Profile dependency ${name} conflicts with its Action-provided version ${LOCKED_RUNTIME_PACKAGES[name] ?? DSH_VERSION}`,
      );
  }
  if (
    manifest.scripts !== undefined ||
    manifest.overrides !== undefined ||
    manifest.resolutions !== undefined
  )
    throw new DshConfigurationError(
      "Profile scripts and dependency overrides are not portable Action configuration",
    );
  if (files["cordis.patch.yml"] === undefined)
    throw new DshConfigurationError("Profile requires cordis.patch.yml");
  const patch = Buffer.from(files["cordis.patch.yml"], "base64").toString("utf8");
  let patches: ReturnType<typeof loadOverlayPatches>;
  try {
    patches = loadOverlayPatches("dsh-action", join(directory, "cordis.patch.yml"));
  } catch {
    throw new DshConfigurationError("Invalid native cordis.patch.yml");
  }
  assertNoSecretOutput("environment", JSON.stringify(patches), knownSecrets);
  for (const item of patches) {
    if (
      item.id === "dsh-action-policy" &&
      Object.keys(item).some((k) => k !== "id" && k !== "config")
    )
      throw new DshConfigurationError("The Action policy entry accepts only user policy config");
    if (
      item.insert?.some(
        (row) =>
          (typeof Reflect.get(row, "id") === "string" && row.id.startsWith("dsh-action-")) ||
          ["headless-runner", "headless-startup"].includes(row.id),
      )
    )
      throw new DshConfigurationError("Profile cannot replace Action-owned plugins");
  }
  const policyPatches = patches.filter((p) => p.id === "dsh-action-policy");
  const entries = composeEntries([
    [{ insert: [{ id: "dsh-action-policy", name: "dsh-action-policy", config: {} }] }],
    policyPatches,
  ]);
  const policy = policySchema.parse(entries[0]?.config ?? {});
  const selectionRows = [
    { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { search: true, fetch: true } },
    { id: "web", name: "@deepseek-ai/dsh-web" },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
    { id: "tool-subagent", name: "@deepseek-ai/dsh-tool-subagent" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search" },
  ];
  const selected = composeEntries([
    [{ insert: selectionRows }],
    patches.filter((p) => selectionRows.some((row) => row.id === p.id)),
  ]);
  const disabled = new Set<AllowedToolId>(policy.deniedTools);
  for (const row of selected) {
    if (row.id === "tool-web" || row.id === "web") {
      const config = z.record(z.string(), z.unknown()).safeParse(row.config ?? {});
      if (
        row.disabled === true ||
        (row.id === "tool-web" && config.success && config.data.search === false)
      )
        disabled.add("native.web-search");
      if (
        row.disabled === true ||
        (row.id === "tool-web" && config.success && config.data.fetch === false)
      )
        disabled.add("native.web-fetch");
    }
    if (row.disabled === true) {
      if (row.id === "tool-bash") disabled.add("native.bash");
      if (row.id === "tool-subagent") disabled.add("native.subagent");
      if (row.id === "tool-fs") {
        disabled.add("workspace.read");
        disabled.add("workspace.edit");
      }
      if (row.id === "tool-fs-search") disabled.add("workspace.search");
    }
  }
  policy.deniedTools = [...disabled];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const rule of policy.rules) {
    const [provider, owner] = rule.id.split(".");
    const namespace = `${provider ?? ""}__${owner ?? ""}__`;
    if (!rule.runtimeName.startsWith(namespace))
      throw new DshConfigurationError(
        `Profile extension ${rule.id} must use its own runtime namespace; builtins require their canonical grants`,
      );
    if (ids.has(rule.id) || names.has(rule.runtimeName) || !rule.permissions.includes("read"))
      throw new DshConfigurationError(
        "Profile tool rules require distinct IDs/names and read permission",
      );
    ids.add(rule.id);
    names.add(rule.runtimeName);
  }
  for (const id of [...policy.allowedTools, ...policy.deniedTools])
    if (/^(mcp|plugin)\./u.test(id) && !ids.has(id))
      throw new DshConfigurationError(`Profile policy has no rule for ${id}`);
  return {
    audit: { ...source, digest: hash(canonicalJson(files)) },
    manifest,
    bundles: declaration.profile.bundles,
    dependencies,
    patch,
    files,
    policy,
  };
}

/** Freeze just the Profile subtree from immutable Git objects, never a PR checkout. */
export async function loadRepositoryProfile(options: {
  client: GitHubClient;
  owner: string;
  repo: string;
  sourceSha: string;
  selection: string;
  directory: string;
  knownSecrets?: readonly string[];
}): Promise<ProjectProfile | undefined> {
  const path = profilePath(options.selection === "auto" ? ".dsh" : options.selection);
  const target = { owner: options.owner, repo: options.repo };
  const commit = await options.client.rest.git.getCommit({
    ...target,
    commit_sha: options.sourceSha,
  });
  if (commit.data.sha !== options.sourceSha)
    throw new DshConfigurationError("Profile source commit identity mismatch");
  let treeSha = commit.data.tree.sha;
  for (const segment of path.split("/")) {
    const tree = await options.client.rest.git.getTree({ ...target, tree_sha: treeSha });
    if (tree.data.truncated || tree.data.sha !== treeSha)
      throw new DshConfigurationError("Profile tree is truncated or mismatched");
    const entry = tree.data.tree.find((e) => e.path === segment);
    if (entry === undefined) {
      if (options.selection === "auto") return undefined;
      throw new DshConfigurationError(`Missing Profile directory ${path}`);
    }
    if (entry.type !== "tree" || entry.mode !== "040000" || !entry.sha)
      throw new DshConfigurationError("Profile path must be an ordinary Git directory");
    treeSha = entry.sha;
  }
  const profileTree = await options.client.rest.git.getTree({ ...target, tree_sha: treeSha });
  if (profileTree.data.truncated || profileTree.data.sha !== treeSha)
    throw new DshConfigurationError("Profile resource tree is incomplete");
  const files = new Set(profileTree.data.tree.map((entry) => entry.path));
  const manifestPresent = files.has("package.json"),
    patchPresent = files.has("cordis.patch.yml");
  // .dsh/skills is a native repository capability, not a declaration of a Profile.
  if (options.selection === "auto" && !manifestPresent && !patchPresent) return undefined;
  if (!manifestPresent || !patchPresent)
    throw new DshConfigurationError("Project Profile requires package.json and cordis.patch.yml");
  let bytes = 0,
    count = 0;
  async function materialize(sha: string, relative: string): Promise<void> {
    const tree = await options.client.rest.git.getTree({ ...target, tree_sha: sha });
    if (tree.data.truncated || tree.data.sha !== sha)
      throw new DshConfigurationError("Profile resource tree is incomplete");
    for (const entry of tree.data.tree) {
      if (!entry.path || !entry.sha)
        throw new DshConfigurationError("Profile tree entry is invalid");
      const file = relative ? `${relative}/${entry.path}` : entry.path;
      admittedFile(file);
      if (entry.type === "tree" && entry.mode === "040000") {
        await materialize(entry.sha, file);
        continue;
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw new DshConfigurationError("Profile symlinks and submodules are forbidden");
      if (++count > 256 || (entry.size ?? 0) > 8 * 1024 * 1024)
        throw new DshConfigurationError("Profile resource limit exceeded");
      const blob = await options.client.rest.git.getBlob({ ...target, file_sha: entry.sha });
      if (blob.data.sha !== entry.sha || blob.data.encoding !== "base64")
        throw new DshConfigurationError("Profile blob identity mismatch");
      const data = Buffer.from(blob.data.content, "base64");
      assertNoSecretOutput("environment", data.toString("utf8"), options.knownSecrets ?? []);
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) throw new DshConfigurationError("Profile exceeds 8 MiB");
      const destination = join(options.directory, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data, { mode: 0o600 });
    }
  }
  await materialize(treeSha, "");
  return readProjectProfile(
    options.directory,
    { sourceSha: options.sourceSha, path },
    options.knownSecrets,
  );
}

export function assertProfileInputCompatibility(inputs: ActionInputs): void {
  const conflicts = [
    inputs.model === undefined ? "" : "model",
    inputs.reasoningEffort === undefined ? "" : "reasoning-effort",
    inputs.mcpConfig.servers.length ? "mcp-config" : "",
    inputs.pluginConfig.bundles.length || inputs.pluginConfig.plugins.length ? "plugin-config" : "",
    inputs.permissionProfile !== "strict" ? "permission-profile" : "",
    inputs.allowedTools.some((id) => !id.startsWith("github.") && !id.startsWith("command."))
      ? "allowed-tools"
      : "",
    inputs.disallowedTools.some((id) => !id.startsWith("github.") && !id.startsWith("command."))
      ? "disallowed-tools"
      : "",
  ].filter(Boolean);
  if (conflicts.length)
    throw new DshConfigurationError(
      `Project Profile conflicts with ${conflicts.join(", ")}; move Harness settings to ${inputs.dshProfile === "auto" ? ".dsh" : inputs.dshProfile}/cordis.patch.yml`,
    );
}

/** Admission metadata only. Official DSH remains the plugin/MCP loader and schema owner. */
export function projectExtensionPlan(
  profile: ProjectProfile,
  inputs: ActionInputs,
  authority: SecurityPolicy,
): ExtensionPlan {
  if (authority.trust === "untrusted" || !authority.capabilities.loadExtensions)
    throw new DshConfigurationError("Project extension startup requires trusted authority");
  const dependencies = Object.fromEntries(
    Object.entries(profile.dependencies).filter(
      ([name]) => LOCKED_RUNTIME_PACKAGES[name] === undefined,
    ),
  );
  const digest = hash(
    canonicalJson({
      profile: profile.audit.digest,
      mode: inputs.dshMode,
      network: inputs.workerNetwork,
      trust: authority.trust,
    }),
  );
  if (inputs.dshMode === "native") {
    const empty = emptyNativeExtensionPlan();
    return {
      ...empty,
      digest,
      configurationDigest: digest,
      network: inputs.workerNetwork,
      workspaceWrite: authority.capabilities.modifyWorkspace,
      packageDependencies: dependencies,
      audit: { ...empty.audit, digest, workerNetwork: inputs.workerNetwork },
    };
  }
  const empty = resolveExtensionPlan({
    allowedTools: [],
    mcp: { schemaVersion: 1, servers: [] },
    plugins: { schemaVersion: 1, bundles: [], plugins: [] },
    allowPluginInstall: false,
    policy: authority,
  });
  const allowed = new Set<AllowedToolId>(profile.policy.allowedTools);
  const denied = new Set<AllowedToolId>(profile.policy.deniedTools);
  const tools: ExtensionToolGrant[] = profile.policy.rules
    .filter(
      (rule) =>
        allowed.has(rule.id) &&
        !denied.has(rule.id) &&
        (!rule.permissions.includes("workspace-write") || authority.capabilities.modifyWorkspace) &&
        (!rule.permissions.includes("network") || inputs.workerNetwork),
    )
    .map((rule) => {
      const provider = rule.id.startsWith("mcp.") ? "mcp" : "plugin";
      const ownerId = rule.id.split(".")[1];
      if (ownerId === undefined) throw new DshConfigurationError("Invalid tool owner");
      return {
        ...rule,
        id: rule.id,
        provider,
        ownerId,
        ownerKind: provider,
        description: `Profile tool ${rule.runtimeName}`,
      };
    });
  return {
    ...empty,
    digest,
    configurationDigest: digest,
    network: inputs.workerNetwork,
    packageDependencies: dependencies,
    tools,
    manifests: tools.map((tool) => ({
      id: tool.id,
      provider: tool.provider,
      description: tool.description,
      permissions: [
        "read",
        ...(tool.permissions.includes("workspace-write") ? ["write" as const] : []),
        ...(tool.permissions.includes("network") ? ["network" as const] : []),
      ],
      inputSchema: { type: "object" },
    })),
    audit: { ...empty.audit, digest, network: inputs.workerNetwork },
  };
}

/** Stage one native Profile; runtime-only overlays are kept in a separate native patch file. */
export async function stageProjectProfile(
  profile: ProjectProfile | undefined,
  directory: string,
  legacyPatch: string,
  bundles: readonly string[],
): Promise<readonly string[]> {
  await mkdir(directory, { recursive: true });
  if (profile === undefined) {
    await writeFile(join(directory, "cordis.patch.yml"), legacyPatch, { mode: 0o600 });
    return bundles;
  }
  for (const [path, content] of Object.entries(profile.files)) {
    admittedFile(path);
    if (
      [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "cordis.yml",
      ].includes(path)
    )
      continue;
    const destination = join(directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(content, "base64"), { mode: 0o600 });
  }
  await writeFile(join(directory, ".action-runtime.patch.yml"), legacyPatch, { mode: 0o600 });
  return [...new Set([...BUILTIN_BUNDLES, ...profile.bundles])];
}
