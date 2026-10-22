import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  guiLocalPlugins,
  guiPluginInputs,
} from "../packages/create-deepseek-harness-action/src/gui/plugins.mjs";
import {
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "../src/extensions/schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-gui-"));
  roots.push(root);
  const home = join(root, "home");
  const profile = join(home, "profiles", "default");
  const installed = join(profile, "node_modules", "example-bundle");
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "example-bundle": "^1.2.0" },
      dsh: { profile: { bundles: ["example-bundle"] } },
    }),
  );
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: "example-bundle",
      version: "1.2.3",
      engines: { dsh: ">=0.2.1-rc.1 <0.3.0" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  await writeFile(join(home, ".credentials.yaml"), "PRIVATE_LOCAL_KEY_MUST_STAY_LOCAL");
  await writeFile(join(profile, "cordis.patch.yml"), "PRIVATE_PROFILE_CONFIG_MUST_STAY_LOCAL");
  return { root, home, installed };
}
const selection = {
  name: "example-bundle",
  version: "1.2.3",
  id: "audit",
  kind: "bundle" as const,
};

describe("local plugin selection in the GUI", () => {
  it("only discovers package metadata after an explicit mode-specific request", async () => {
    const f = await fixture();
    const result = await guiLocalPlugins({ dshMode: "native", home: f.home }, {});
    expect(result.plugins).toEqual([
      expect.objectContaining({ name: "example-bundle", version: "1.2.3", compatible: true }),
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(await readdir(f.root)).toEqual(["home"]);
    await expect(guiLocalPlugins({ dshMode: "unknown", home: f.home }, {})).rejects.toThrow(
      "Choose a mode",
    );
  });
  it("keeps selected Controlled tools explicit and preserves existing command permissions", () => {
    const original = {
      "allow-write": "true",
      "run-tests": "true",
      "permission-profile": "standard",
      "allowed-tools": '["workspace.edit"]',
    };
    expect(() =>
      guiPluginInputs({ dshMode: "controlled", inputs: original, selections: [selection] }),
    ).toThrow("explicitly selected");
    const result = guiPluginInputs({
      dshMode: "controlled",
      inputs: original,
      selections: [{ ...selection, tools: ["plugin__audit__scan"] }],
    });
    expect(parsePluginConfiguration(result.inputs["plugin-config"] ?? "").bundles[0]).toMatchObject(
      {
        id: "audit",
        network: false,
        tools: [{ id: "scan", name: "plugin__audit__scan", permissions: ["read"] }],
      },
    );
    expect(result.inputs).toMatchObject({
      "allow-write": "true",
      "run-tests": "true",
      "permission-profile": "standard",
      "allowed-tools": '["workspace.edit","plugin.audit.scan"]',
    });
    expect(original).not.toHaveProperty("plugin-config");
  });
  it("reports incompatible local package metadata without modifying its files", async () => {
    const f = await fixture();
    const source = JSON.stringify({
      name: "example-bundle",
      version: "1.2.3",
      engines: { dsh: "<0.2.0" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    });
    await writeFile(join(f.installed, "package.json"), source);
    const result = await guiLocalPlugins({ dshMode: "native", home: f.home }, {});
    expect(result.plugins[0]).toMatchObject({
      compatible: false,
    });
    expect(result.plugins[0]?.reason).toContain("incompatible with DSH");
    expect(await readFile(join(f.installed, "package.json"), "utf8")).toBe(source);
    expect(await readdir(f.root)).toEqual(["home"]);
  });
  it("builds pinned Native configuration without importing local secrets or extra authority", async () => {
    const f = await fixture();
    await guiLocalPlugins({ dshMode: "native", home: f.home }, {});
    const result = guiPluginInputs({
      dshMode: "native",
      inputs: { "allow-write": "false", "permission-profile": "strict" },
      selections: [selection],
    });
    expect(
      parseNativePluginConfiguration(result.inputs["plugin-config"] ?? "").bundles[0],
    ).toMatchObject({
      package: "example-bundle",
      source: "1.2.3",
      network: false,
      workspaceWrite: false,
    });
    expect(result.inputs).toMatchObject({ "allow-write": "false", "permission-profile": "strict" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  it.each(["latest", "^1.2.3", "1.2", "file:../plugin"])(
    "rejects an unpinned version %s",
    (version) => {
      expect(() =>
        guiPluginInputs({ dshMode: "native", inputs: {}, selections: [{ ...selection, version }] }),
      ).toThrow("exact published version");
    },
  );
  it("does not overwrite an existing package or an expression-based plugin configuration", () => {
    const result = guiPluginInputs({ dshMode: "native", inputs: {}, selections: [selection] });
    expect(() =>
      guiPluginInputs({ dshMode: "native", inputs: result.inputs, selections: [selection] }),
    ).toThrow("already configured");
    expect(() =>
      guiPluginInputs({
        dshMode: "native",
        inputs: { "plugin-config": "${{ inputs.plugins }}" },
        selections: [selection],
      }),
    ).toThrow("Edit it in Advanced");
  });
});
