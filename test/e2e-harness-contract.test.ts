import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { isRecord } from "../src/security/record.js";
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected mapping");
  return value;
}
it("qualifies explicit Profile defaults while keeping legacy and trusted-main admission", async () => {
  const workflow = record(parse(await readFile(".github/workflows/e2e.yml", "utf8")));
  const inputs = record(record(record(workflow.on).workflow_dispatch).inputs);
  expect(inputs.profile_defaults).toMatchObject({ type: "boolean", default: false });
  const job = record(record(workflow.jobs).read_only);
  expect(record(job.env).PROFILE_DEFAULTS).toBe("${{ inputs.profile_defaults }}");
  const steps = job.steps;
  if (!Array.isArray(steps)) throw new Error("Missing steps");
  for (const name of [
    "Assert strict/Profile/Bundle result",
    "Assert native composition and observed inventory",
    "Assert Web Search mediation and receipt",
  ]) {
    const step = steps.map(record).find((step) => step.name === name);
    expect(step?.run).toContain('--argjson profile_defaults "$PROFILE_DEFAULTS"');
    expect(step?.run).toContain("if $profile_defaults then");
  }
  const gate = await readFile(".github/e2e/assert-candidate-binding.sh", "utf8");
  expect(gate).toContain("E2E must be dispatched from the default branch workflow");
  expect(gate).toContain("DSH_E2E_CANDIDATE_SHA must exactly match candidate_sha");
});
