import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectProfile, assertProfileInputCompatibility } from "../src/dsh/project-profile.js";
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
