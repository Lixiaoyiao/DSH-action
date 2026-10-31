import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { composeEntries } from "@deepseek-ai/dsh-app-boot";
import { composeActionProfile } from "../assets/dsh/profile-runtime.mjs";

const require = createRequire(import.meta.url);
const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
const dshBin = join(dshPackage, "..", "lib", "bin.js");
const projectRoot = join(import.meta.dirname, "..");
const dshHome = await mkdtemp(join(tmpdir(), "dsh-action-config-"));

try {
  // The production launcher and Session lifecycle tests exercise task binding,
  // JSON output, resume admission, tool observation, and shutdown through DSH.
  // This check only owns published Action inputs and upstream patch acceptance.
  const action = await readFile(join(projectRoot, "action.yml"), "utf8");
  const actionInputs = Object.keys(parse(action).inputs);
  for (const forbidden of [
    "session-id",
    "resume",
    "resume-session",
    "file",
    "files",
    "image",
    "images",
    "attachment",
    "attachments",
  ]) {
    assert.ok(
      !actionInputs.includes(forbidden),
      `Action must not expose ${forbidden} in this migration`,
    );
  }
  for (const mode of ["controlled", "native"]) {
    const ids = [
      "session-telemetry-otel",
      "session-log-deepseek",
      "plugin-package-inventory-deepseek",
    ];
    const profile = {
      dir: dshHome,
      layers: [{ patches: [{ insert: ids.map((id) => ({ id, name: id })) }] }],
      patches: [],
    };
    const composed = composeEntries([composeActionProfile(profile, mode, {})]);
    for (const id of ids)
      assert.equal(
        composed.find((row) => row.id === id)?.disabled,
        true,
        mode + " must suppress " + id,
      );
  }

  for (const patch of [
    "strict-untrusted.patch.yml",
    "trusted-read.patch.yml",
    "trusted-write.patch.yml",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        dshBin,
        "--profile",
        "headless",
        "--patch",
        join(projectRoot, "assets", "dsh", patch),
        "--dump-config",
      ],
      {
        cwd: dshHome,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
        },
        timeout: 60_000,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `${patch} was rejected by DSH: ${result.error?.message ?? result.stderr ?? "unknown failure"}`,
      );
    }
  }
} finally {
  await rm(dshHome, { force: true, recursive: true });
}
