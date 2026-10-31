import { spawnSync } from "node:child_process";
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

it.skipIf(process.platform === "win32").each([false, true])(
  "executes the real Web Search result assertion for Profile defaults=%s",
  async (profile) => {
    const workflow = record(parse(await readFile(".github/workflows/e2e.yml", "utf8")));
    const steps = record(record(workflow.jobs).read_only).steps;
    if (!Array.isArray(steps)) throw new Error("Missing steps");
    const run = steps
      .map(record)
      .find((step) => step.name === "Assert Web Search mediation and receipt")?.run;
    if (typeof run !== "string") throw new Error("Missing web assertion");
    const commands = [...run.matchAll(/jq -e([^']*)'([\s\S]*?)'/gu)];
    const command = commands.find((match) => match[2]?.includes(".permissions.network"));
    if (command === undefined) throw new Error("Missing network assertion");
    expect(command[1]).toContain('--argjson profile_defaults "$PROFILE_DEFAULTS"');
    const assertion = command[2];
    if (assertion === undefined) throw new Error("Missing jq expression");
    const input = JSON.stringify({
      conclusion: "success",
      permissions: {
        effectiveTools: ["native.web-search"],
        network: profile ? "bridge" : "mediated-web",
      },
      loop: { dshToolReceipts: [{ id: "native.web-search", completed: true, ok: true }] },
    });
    const result = spawnSync(
      "jq",
      ["-e", "--argjson", "profile_defaults", String(profile), assertion],
      { encoding: "utf8", input, timeout: 5000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  },
);
