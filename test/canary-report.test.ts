import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

type Mode = "controlled" | "native";
const modes = ["controlled", "native"] as const;
const record = z.record(z.string(), z.unknown());
const assertionStep = z.looseObject({
  id: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
let assertions: Record<Mode, { run: string; env: Record<string, string> }>;

beforeAll(async () => {
  const workflow = z
    .looseObject({
      jobs: z.looseObject({ smoke: z.looseObject({ steps: z.array(assertionStep) }) }),
    })
    .parse(
      parse(
        await readFile(new URL("../.github/workflows/release-canary.yml", import.meta.url), "utf8"),
      ),
    );
  const assertion = (mode: Mode) => {
    const step = workflow.jobs.smoke.steps.find((entry) => entry.id === `${mode}_assert`);
    if (!step?.run || !step.env) throw new Error(`Missing ${mode} canary assertion`);
    return { run: step.run, env: step.env };
  };
  assertions = { controlled: assertion("controlled"), native: assertion("native") };
});

function report(mode: Mode) {
  return {
    schemaVersion: 2,
    termination: { conclusion: "success", status: "success", summary: "done", durationMs: 1 },
    operation: { kind: "task", findingsCount: 0 },
    context: {
      dsh: {
        mode,
        composition: mode === "controlled" ? "github-action-controlled" : "dsh-native-headless",
      },
      policy: { trust: "trusted-read" },
      permission: {
        profile: "strict",
        workspaceWrite: false,
        network: "host-gateway",
        effectiveTools: ["workspace.read", "workspace.search"],
      },
      toolPolicy:
        mode === "controlled"
          ? {
              schemaVersion: 1,
              policyOwner: "controller",
              effectiveTools: ["workspace.read", "workspace.search"],
              requestedTools: ["workspace.read", "workspace.search"],
              deniedTools: [],
            }
          : { schemaVersion: 1, policyOwner: "dsh", observedTools: ["read"] },
      textSources: {
        instruction: { path: "examples/prompts/repository-summary.md" },
        contexts: [{ path: "examples/context/release-checklist.txt" }],
      },
      githubRequests: { clientRole: "main-controller", cacheHits: 1 },
    },
    agent: { durationMs: 1, isolation: { backend: "docker", workspaceAccess: "read-only" } },
    publication: {},
  };
}

function replace(value: unknown, path: readonly string[], next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return next;
  const object = record.parse(value);
  return { ...object, [key]: replace(object[key], rest, next) };
}

function assertReport(mode: Mode, input: string) {
  return spawnSync("bash", ["-euc", assertions[mode].run], {
    env: { ...process.env, DSH_RESULT_JSON: input },
    encoding: "utf8",
    timeout: 10_000,
  });
}

it.each(modes)("%s canary consumes only the canonical result-json output", (mode) => {
  expect(assertions[mode].env).toEqual({
    DSH_RESULT_JSON: `\${{ steps.${mode}.outputs['result-json'] }}`,
  });
});

// GitHub's Linux runner supplies bash and jq; Windows development hosts do not.
// On Linux a missing executable fails these tests, rather than silently skipping proof.
describe.skipIf(process.platform === "win32")("executable release canary jq assertions", () => {
  it.each(modes)("accepts the canonical %s report", (mode) => {
    const result = assertReport(mode, JSON.stringify(report(mode)));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["schemaVersion", 1],
    ["termination.conclusion", "failure"],
    ["operation.kind", "review"],
    ["context.dsh.mode", "other"],
    ["context.dsh.composition", "other"],
    ["context.textSources.instruction.path", "other.md"],
    ["context.textSources.contexts", []],
    ["context.githubRequests.clientRole", "other"],
    ["context.githubRequests.cacheHits", 0],
    ["context.permission.profile", "workspace-write"],
    ["context.permission.workspaceWrite", true],
    ["context.toolPolicy.schemaVersion", 2],
    ["context.toolPolicy.policyOwner", "other"],
  ])("rejects invalid %s in both modes", (path, value) => {
    for (const mode of modes) {
      const result = assertReport(
        mode,
        JSON.stringify(replace(report(mode), path.split("."), value)),
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${mode}: ${result.stderr}`).not.toBe(0);
    }
  });

  it.each([
    ["context.permission.network", "unrestricted"],
    ["context.permission.effectiveTools", ["workspace.edit"]],
    ["context.toolPolicy.effectiveTools", ["workspace.edit"]],
    ["context.toolPolicy.requestedTools", undefined],
    ["context.toolPolicy.deniedTools", undefined],
    ["context.toolPolicy.observedTools", ["read"]],
  ])("rejects an invalid controlled policy at %s", (path, value) => {
    const result = assertReport(
      "controlled",
      JSON.stringify(replace(report("controlled"), path.split("."), value)),
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
  });

  it.each([
    ["context.policy.trust", "trusted-write"],
    ["agent.isolation.backend", "host"],
    ["agent.isolation.workspaceAccess", "read-write"],
    ["context.toolPolicy.observedTools", ["write"]],
    ["context.toolPolicy.effectiveTools", ["read"]],
    ["context.toolPolicy.requestedTools", []],
    ["context.toolPolicy.deniedTools", []],
  ])("rejects an invalid native policy at %s", (path, value) => {
    const result = assertReport(
      "native",
      JSON.stringify(replace(report("native"), path.split("."), value)),
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
  });

  it.each(["", "{"])("rejects absent or malformed output: %j", (input) => {
    for (const mode of modes) {
      const result = assertReport(mode, input);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).not.toBe(0);
    }
  });
});
