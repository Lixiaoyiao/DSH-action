import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleWithin } from "../lifecycle/deadline.js";
import type { RunOutcome } from "./types.js";

/** Publish metadata already redacted at collection. Raw process/model output never enters artifacts. */
export async function publishDiagnosticArtifact(result: RunOutcome): Promise<RunOutcome> {
  if (result.diagnostics?.level !== "detailed") return result;
  if (!process.env.ACTIONS_RUNTIME_TOKEN) {
    core.warning(
      "Detailed diagnostics artifact is available only inside GitHub Actions; the step summary retains diagnostics.",
    );
    return result;
  }
  const root = await mkdtemp(join(tmpdir(), "dsh-diagnostics-"));
  const path = join(root, "diagnostics.json");
  const content = JSON.stringify({
    run: result.runUrl,
    status: result.conclusion,
    configuration: result.configuration,
    diagnostics: result.diagnostics,
  });
  if (Buffer.byteLength(content) > 1024 * 1024) {
    await rm(root, { recursive: true, force: true });
    core.warning("Diagnostic artifact exceeded its byte limit; step summary retained.");
    return result;
  }
  await writeFile(path, content, { mode: 0o600 });
  const name =
    `dsh-diagnostics-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${process.env.GITHUB_JOB ?? "job"}-${process.env.GITHUB_ACTION ?? "action"}`
      .replace(/[^A-Za-z0-9_-]/gu, "_")
      .slice(0, 240);
  const upload = new DefaultArtifactClient().uploadArtifact(name, [path], root, {
    retentionDays: 3,
  });
  // Late completion owns its source files; a finalization timeout is not cancellation proof.
  const pending = upload.finally(() => rm(root, { recursive: true, force: true }));
  try {
    const settled = await settleWithin(pending, 5000);
    if (settled.settled && settled.value.id !== undefined)
      return { ...result, diagnostics: { ...result.diagnostics, artifactId: settled.value.id } };
    core.warning(
      "Diagnostic artifact upload did not finish within finalization; primary result preserved.",
    );
  } catch {
    core.warning("Diagnostic artifact upload failed; primary result and step summary preserved.");
  }
  return result;
}
