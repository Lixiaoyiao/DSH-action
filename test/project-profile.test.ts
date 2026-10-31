import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectProfile, assertProfileInputCompatibility } from "../src/dsh/project-profile.js";
import { verifyInstalledExtensions } from "../src/dsh/install.js";
import { emptyNativeExtensionPlan } from "../src/extensions/plan.js";
import { inputs } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("reads native configuration without executing expressions and rejects legacy mixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-project-profile-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    }),
  );
  await writeFile(
    join(root, "cordis.patch.yml"),
    "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: custom-model\n- id: system-prompt\n  config:\n    personaPrefix: !!js process.env.PROFILE_TEST_VALUE\n",
  );
  const profile = await readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" });
  expect(profile.patch).toContain("custom-model");
  expect(profile.patch).toContain("!!js");
  expect(() => assertProfileInputCompatibility(inputs({ model: "old-model" }))).toThrow(
    /model.*cordis.patch/,
  );
  expect(() => assertProfileInputCompatibility(inputs({ allowedTools: [] }))).not.toThrow();
});

it.each(["bash", "subagent", "edit"])(
  "rejects a Controlled extension alias for builtin %s",
  async (runtimeName) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-profile-alias-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    );
    await writeFile(
      join(root, "cordis.patch.yml"),
      JSON.stringify([
        {
          id: "dsh-action-policy",
          config: {
            allowedTools: ["plugin.alias.call"],
            deniedTools: ["native.bash"],
            rules: [{ id: "plugin.alias.call", runtimeName, permissions: ["read"] }],
          },
        },
      ]),
    );
    await expect(
      readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" }),
    ).rejects.toThrow(/namespace|canonical/);
  },
);
it("rejects a Profile resource that shadows the private runtime helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-profile-shadow-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: [] } } }),
  );
  await writeFile(join(root, "cordis.patch.yml"), "[]");
  await writeFile(
    join(root, "profile-runtime.mjs"),
    "export function composeActionProfile(){return [];}",
  );
  await expect(
    readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" }),
  ).rejects.toThrow(/reserved/);
});

it.each(["mcp", "plugin"])(
  "preserves official hyphenated %s owner namespaces",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-owner-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    );
    const id = provider + ".my-server.search";
    await writeFile(
      join(root, "cordis.patch.yml"),
      JSON.stringify([
        {
          id: "dsh-action-policy",
          config: {
            allowedTools: [id],
            rules: [{ id, runtimeName: provider + "__my-server__search", permissions: ["read"] }],
          },
        },
      ]),
    );
    const profile = await readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" });
    expect(profile.policy.rules[0]?.runtimeName).toBe(provider + "__my-server__search");
  },
);

it("rejects known Controller credentials after native YAML scalar decoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-decoded-secret-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: [] } } }),
  );
  const secret = "synthetic-controller-key";
  const encoded = secret.replaceAll("-", String.fromCharCode(92) + "u002d");
  await writeFile(
    join(root, "cordis.patch.yml"),
    '- id: mcp-client\n  config:\n    headers:\n      Authorization: "' + encoded + '"\n',
  );
  await expect(
    readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" }, [secret]),
  ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
});

it.each([
  { source: "1.2.3+build.7", valid: true },
  { source: "1.2.3-...", valid: false },
])("uses shared exact-source rules for $source", async ({ source, valid }) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-source-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["example-bundle"] } },
      dependencies: { "example-bundle": source },
    }),
  );
  await writeFile(join(root, "cordis.patch.yml"), "[]");
  const result = readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" });
  if (valid) expect((await result).dependencies["example-bundle"]).toBe(source);
  else await expect(result).rejects.toThrow(/exact version/);
});
it("verifies every native Profile Bundle patch even without legacy extension definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-project-bundle-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["example-bundle"] } },
      dependencies: { "example-bundle": "1.2.3" },
    }),
  );
  await writeFile(join(root, "cordis.patch.yml"), "[]");
  const profile = await readProjectProfile(root, { sourceSha: "a".repeat(40), path: ".dsh" });
  const directory = join(root, "node_modules", "example-bundle");
  await mkdir(directory, { recursive: true });
  const manifest = {
    name: "example-bundle",
    version: "1.2.3",
    dsh: { bundle: { patch: ["./base.yml", "./review.yml"] } },
  };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "base.yml"), "[]");
  await writeFile(join(directory, "review.yml"), "[]");
  await expect(
    verifyInstalledExtensions(root, emptyNativeExtensionPlan(), profile),
  ).resolves.toBeUndefined();
  manifest.dsh.bundle.patch[1] = "../outside.yml";
  await writeFile(join(directory, "..", "outside.yml"), "[]");
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await expect(
    verifyInstalledExtensions(root, emptyNativeExtensionPlan(), profile),
  ).rejects.toThrow(/patch escapes/);
});
