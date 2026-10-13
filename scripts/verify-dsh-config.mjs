import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse } from "yaml";

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
  // Retain the narrow upload-suppression probes until the launcher exposes a
  // composed-config seam; general startup and lifecycle use behavioral tests.
  for (const launcher of ["action-launcher.mjs", "native-launcher.mjs"]) {
    const source = await readFile(join(projectRoot, "assets", "dsh", launcher), "utf8");
    for (const row of [
      "session-telemetry-otel",
      "session-log-deepseek",
      "plugin-package-inventory-deepseek",
    ]) {
      assert.ok(
        source.includes(`{ id: "${row}", disabled: true }`),
        `${launcher} must suppress ${row}`,
      );
    }
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
