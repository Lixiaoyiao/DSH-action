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
export function composeActionProfile(profile, mode, environment = process.env) {
  const runtimeFile = join(profile.dir, ".action-runtime.patch.yml");
  const project = existsSync(runtimeFile);
  const base = profile.layers.flatMap((layer) => layer.patches);
  const runtime = project ? loadOverlayPatches("dsh-action", runtimeFile) : [];
  const insertions = runtime.flatMap((patch) => patch.insert ?? []);
  const user = project
    ? profile.patches.filter((patch) => patch.id !== "dsh-action-policy")
    : profile.patches;
  const layers = [base, ...(insertions.length ? [[{ insert: insertions }]] : []), user];
  let entries = composeEntries(layers);
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
