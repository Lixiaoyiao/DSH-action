import semver from "semver";
import { discoverLocalPlugins } from "../local-plugins.mjs";
import { parseDocument } from "yaml";

const SAME_REPOSITORY = "github.event.pull_request.head.repo.full_name == github.repository";
export function unwrapReviewGuard(value, fallback) {
  const prefix = `\${{ ${SAME_REPOSITORY} && '`;
  const suffix = `' || '${fallback}' }}`;
  return value.startsWith(prefix) && value.endsWith(suffix)
    ? value.slice(prefix.length, -suffix.length).replaceAll("''", "'")
    : value;
}
function reviewGuard(value, fallback) {
  return `\${{ ${SAME_REPOSITORY} && '${value.replaceAll("'", "''")}' || '${fallback}' }}`;
}

export async function guiLocalPlugins({ dshMode, home }, environment, defaultHome) {
  if (!["controlled", "native"].includes(dshMode))
    throw new Error("Choose a mode before discovering plugins.");
  const warnings = [];
  const plugins = await discoverLocalPlugins({
    home: home || defaultHome,
    env: environment,
    output: { write: (text) => warnings.push(text.trim()) },
  });
  if (dshMode === "controlled")
    warnings.push(
      "Controlled requires explicit read-only plugin tool names. No network or workspace-write permission is imported.",
    );
  return { plugins, warnings };
}

export function guiPluginInputs({ dshMode, inputs, selections, source }) {
  if (!["controlled", "native"].includes(dshMode)) throw new Error("Choose Controlled or Native.");
  if (!Array.isArray(selections) || selections.length > 16)
    throw new Error("Choose at most 16 plugins.");
  if (selections.length === 0)
    return { inputs: { ...inputs }, warnings: ["No plugins selected; permissions are unchanged."] };
  let configuration, allowedTools;
  try {
    configuration = JSON.parse(
      unwrapReviewGuard(
        inputs["plugin-config"] || '{"schemaVersion":1,"bundles":[],"plugins":[]}',
        '{"schemaVersion":1}',
      ),
    );
    allowedTools = JSON.parse(unwrapReviewGuard(inputs["allowed-tools"] || "[]", "[]"));
  } catch {
    throw new Error(
      "Existing plugin-config or allowed-tools uses an expression or invalid JSON. Edit it in Advanced to preserve custom logic.",
    );
  }
  if (configuration.schemaVersion !== 1 || !Array.isArray(allowedTools))
    throw new Error("Unsupported existing plugin configuration.");
  configuration.bundles ??= [];
  configuration.plugins ??= [];
  if (!Array.isArray(configuration.bundles) || !Array.isArray(configuration.plugins))
    throw new Error("Plugin collections must be arrays.");
  for (const selected of selections) {
    if (
      typeof selected.name !== "string" ||
      selected.name.length > 214 ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(selected.name)
    )
      throw new Error("Enter a registry package name, without a local path or URL.");
    if (typeof selected.version !== "string" || semver.valid(selected.version) !== selected.version)
      throw new Error("Use an exact published version, not a tag or range.");
    if (
      !["bundle", "plugin"].includes(selected.kind) ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(selected.id)
    )
      throw new Error(
        "Choose Bundle or Plugin and a lowercase identifier of at most 32 characters.",
      );
    if (
      [...configuration.bundles, ...configuration.plugins].some(
        (item) => item.id === selected.id || item.package === selected.name,
      )
    )
      throw new Error(
        "That plugin or identifier is already configured. Edit the existing entry in Advanced.",
      );
    const entry = {
      id: selected.id,
      package: selected.name,
      source: selected.version,
      network: false,
    };
    if (dshMode === "native") entry.workspaceWrite = false;
    else {
      if (
        !Array.isArray(selected.tools) ||
        selected.tools.length === 0 ||
        selected.tools.length > 64
      )
        throw new Error("Controlled plugins need explicitly selected read-only tool names.");
      entry.tools = [...new Set(selected.tools)].map((name) => {
        const match = /^plugin__([a-z][a-z0-9-]{0,31})__([a-z][a-z0-9_-]{0,63})$/u.exec(name);
        if (!match || match[1] !== selected.id || name.length > 64)
          throw new Error(
            "Tool names must use plugin__<same-id>__<tool> and be at most 64 characters.",
          );
        allowedTools.push(`plugin.${selected.id}.${match[2]}`);
        return {
          id: match[2],
          name,
          description: `Read-only ${selected.name} tool`,
          permissions: ["read"],
        };
      });
    }
    if (selected.kind === "plugin") entry.config = {};
    configuration[selected.kind === "bundle" ? "bundles" : "plugins"].push(entry);
  }
  const review =
    typeof source === "string" && parseDocument(source).hasIn(["on", "pull_request_target"]);
  const config = JSON.stringify(configuration);
  const tools = JSON.stringify([...new Set(allowedTools)]);
  return {
    inputs: {
      ...inputs,
      "plugin-config": review ? reviewGuard(config, '{"schemaVersion":1}') : config,
      "allow-plugin-install": review ? `\${{ ${SAME_REPOSITORY} }}` : "true",
      ...(dshMode === "controlled"
        ? { "allowed-tools": review ? reviewGuard(tools, "[]") : tools }
        : {}),
    },
    warnings: [
      "Only selected package names, exact versions and explicit read-only tools are configured. The GitHub runner installs them; no local files, credentials or private settings are copied.",
      "Manual package compatibility is checked by the locked DSH runtime on the runner. Review the diff before saving.",
    ],
  };
}
