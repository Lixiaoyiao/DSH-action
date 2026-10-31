import { existsSync } from "node:fs";
import { join } from "node:path";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const noUploads = [
  "session-log-deepseek",
  "plugin-package-inventory-deepseek",
  "session-telemetry-otel",
];

/** Official patch application, with a narrow final overlay for Action-owned fields. */
export function composeActionProfile(profile, mode, environment = process.env, task) {
  const runtimeFile = join(profile.dir, ".action-runtime.patch.yml");
  const project = existsSync(runtimeFile);
  const base = profile.layers.flatMap((layer) => layer.patches);
  const runtime = project ? loadOverlayPatches("dsh-action", runtimeFile) : [];
  const insertions = runtime.flatMap((patch) => patch.insert ?? []);
  const user = project
    ? profile.patches.filter((patch) => patch.id !== "dsh-action-policy")
    : profile.patches;
  const layers = [base, ...(insertions.length ? [[{ insert: insertions }]] : []), user];
  let entries = composeEntries(
    layers,
    project
      ? (message) => {
          throw new Error(`Project Profile patch did not apply: ${message}`);
        }
      : undefined,
  );
  const patches = [...layers.flat()];
  const lookup = (id, rows = entries) => {
    for (const row of rows) {
      if (row.id === id) return row;
      if (row.group && Array.isArray(row.config)) {
        const found = lookup(id, row.config);
        if (found) return found;
      }
    }
  };
  const apply = (patch) => {
    patches.push(patch);
    entries = composeEntries([patches]);
  };
  const managed = (id, fields, extras = {}) => {
    const row = lookup(id);
    if (!row) return;
    if (row.config?.__jsExpr !== undefined)
      throw new Error(
        `Action-managed ${id} config must be an object; field-level expressions remain supported`,
      );
    apply({ id, ...extras, config: { ...(record(row.config) ? row.config : {}), ...fields } });
  };
  for (const patch of runtime) {
    if (patch.insert || patch.id === "web" || patch.id === "web-deepseek-api") continue;
    // Controlled tool visibility is enforced by the policy adapter; do not erase
    // user Agent/Skill/Workflow configuration with the legacy blanket disables.
    if (patch.disabled === true) continue;
    if (patch.id === "tool-web") {
      const configured = lookup("tool-web")?.config;
      managed("tool-web", {
        search: patch.config?.search === true && configured?.search !== false,
        fetch: patch.config?.fetch === true && configured?.fetch !== false,
      });
    } else if (record(patch.config))
      managed(patch.id, patch.config, patch.inject ? { inject: patch.inject } : {});
    else apply(patch);
  }
  if (!project && mode === "native" && lookup("mcp-resources"))
    apply({ id: "mcp-resources", disabled: true });
  if (typeof task === "string") {
    managed(
      "headless-runner",
      { task, json: true, sessionId: undefined },
      {
        disabled: false,
        inject:
          mode === "controlled" ? ["headlessStartup", "actionWorkspace"] : ["headlessStartup"],
      },
    );
    if (lookup("headless-startup"))
      apply({ id: "headless-startup", disabled: false, inject: ["cmdlineArgs"] });
  }
  const online = environment.DSH_ACTION_WORKER_NETWORK !== "false";
  managed("web-search-deepseek", {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    ...(environment.DEEPSEEK_SEARCH_BASE_URL
      ? { baseURL: environment.DEEPSEEK_SEARCH_BASE_URL }
      : {}),
  });
  managed("web-deepseek-api", {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: `${environment.DEEPSEEK_BASE_URL}/v1/tools`,
  });
  if (!online) {
    for (const id of ["tool-web", "web-search-deepseek", "web-deepseek-api", "web-fetch-http"])
      if (lookup(id)) apply({ id, disabled: true });
  }
  for (const id of noUploads) if (lookup(id)) apply({ id, disabled: true });
  if (mode === "native" && profile.patches.some((p) => p.id === "dsh-action-policy")) {
    if (environment.DSH_ACTION_DIAGNOSTICS && environment.DSH_ACTION_DIAGNOSTICS !== "off")
      process.stderr.write('DSH_DIAGNOSTIC {"phase":"profile.controlled-policy-inactive"}\n');
  }
  if (environment.DSH_ACTION_DIAGNOSTICS && environment.DSH_ACTION_DIAGNOSTICS !== "off")
    process.stderr.write('DSH_DIAGNOSTIC {"phase":"profile.composed"}\n');
  return patches;
}

export function admittedExtensionSelectors(profile) {
  const selectors = [];
  const addRow = (row) => {
    if (typeof row.id === "string") selectors.push({ id: row.id });
    else if (typeof row.name === "string") selectors.push({ name: row.name });
    if (Array.isArray(row.insert)) row.insert.forEach(addRow);
  };
  for (const layer of profile.layers) {
    if (
      layer.packageName === "@deepseek-ai/dsh-base" ||
      layer.packageName === "@deepseek-ai/dsh-headless"
    )
      continue;
    layer.patches.forEach(addRow);
  }
  for (const patch of profile.patches) {
    for (const row of patch.insert ?? []) {
      if (row.id !== "dsh-action-policy") addRow(row);
    }
  }
  return selectors;
}

export function requireAdmittedExtensions(host, selectors) {
  if (selectors.length === 0) return;
  // The official Headless driver settles Loader before creating its Agent.
  // Check only explicitly admitted extension entries, including their nested
  // groups/includes; DSH's unrelated optional entries retain their semantics.
  host.on(
    "agent/created",
    () => {
      const loader = host.get("loader");
      if (loader === undefined) throw new Error("admitted extension startup requires Loader");
      const entries = [...loader.entries()];
      const required = new Set();
      for (const selector of selectors) {
        const matched = entries.filter((entry) =>
          selector.id === undefined
            ? entry.options.name === selector.name
            : entry.options.id === selector.id,
        );
        if (matched.length === 0) throw new Error("an admitted extension entry was not composed");
        matched.forEach((entry) => required.add(entry));
      }
      for (const entry of required) {
        if (entry.subtree !== undefined) {
          for (const child of entry.subtree.entries()) required.add(child);
        }
        if (entry.subgroup !== undefined) {
          for (const child of entries) if (child.parent === entry.subgroup) required.add(child);
        }
        // ACTIVE=2 is the exact locked Cordis FiberState public enum.
        if (!entry.disabled && entry.fiber?.state !== 2) {
          throw new Error(`admitted extension ${entry.options.id} failed to activate`);
        }
      }
    },
    { prepend: true },
  );
}

/** Observe the locked Cordis lifecycle; never read plugin configuration or error payloads. */
export function observeProfileStartup(host) {
  if (!process.env.DSH_ACTION_DIAGNOSTICS || process.env.DSH_ACTION_DIAGNOSTICS === "off") return;
  // Public FiberState values from the pinned Cordis runtime.
  const states = ["pending", "loading", "active", "failed", "disposed", "unloading"];
  host.on(
    "internal/status",
    (fiber) => {
      const id = fiber.entry?.options.id;
      const state = states[fiber.state];
      if (typeof id !== "string" || state === undefined) return;
      process.stderr.write(
        "DSH_DIAGNOSTIC " +
          JSON.stringify({ phase: "loader.entry-" + state, name: id.slice(0, 128) }) +
          "\n",
      );
    },
    { global: true },
  );
}
