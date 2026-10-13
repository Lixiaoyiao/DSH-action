import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const mainSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const repository = "owner/repository";
const script = fileURLToPath(
  new URL("../.github/e2e/assert-candidate-binding.sh", import.meta.url),
);
const temporary: string[] = [];
const pull = {
  state: "open",
  draft: false,
  head: { sha: candidateSha, ref: "candidate", repo: { full_name: repository } },
  base: { ref: "main", repo: { full_name: repository } },
};

// Only GitHub transport is replaced. Bash and jq execute the production guards.
const transport = `
gh() {
  [[ "$1" == api ]] || return 1
  case "$2" in
    "repos/$REPOSITORY/git/ref/heads/$DEFAULT_BRANCH") printf '%s\\n' "$FIXTURE_MAIN_SHA" ;;
    "repos/$REPOSITORY/collaborators/$ACTOR/permission") printf '%s\\n' "$FIXTURE_PERMISSION" ;;
    "repos/$REPOSITORY/pulls/$CANDIDATE_PR") printf '%s\\n' "$FIXTURE_PULL" ;;
    *) return 1 ;;
  esac
}
source "$CANDIDATE_SCRIPT" "$CHECK_STAGE"
`;

async function check(stage: "admit" | "revalidate", overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-candidate-binding-"));
  temporary.push(directory);
  const output = join(directory, "output");
  const result = spawnSync(process.env.DSH_TEST_BASH ?? "bash", ["-c", transport], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...process.env,
      GH_TOKEN: "fixture-token",
      REPOSITORY: repository,
      DEFAULT_BRANCH: "main",
      CANDIDATE_MODE: "pull-request",
      CANDIDATE_SHA: candidateSha,
      CANDIDATE_PR: "42",
      WORKFLOW_REF: "refs/heads/main",
      WORKFLOW_SHA: mainSha,
      DISPATCH_SHA: mainSha,
      ACTOR: "maintainer",
      APPROVED_CANDIDATE_SHA: candidateSha,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
      FIXTURE_MAIN_SHA: mainSha,
      FIXTURE_PERMISSION: "write",
      FIXTURE_PULL: JSON.stringify(pull),
      CANDIDATE_SCRIPT: script.replaceAll("\\", "/"),
      CHECK_STAGE: stage,
      ...overrides,
    },
  });
  expect(result.error).toBeUndefined();
  const outputs = await readFile(output, "utf8").catch(() => "");
  return { status: result.status, outputs };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("trusted candidate workflow wiring", () => {
  it.each(["e2e", "session-e2e", "session-auto-e2e"])(
    "%s admits through the immutable workflow checkout with only a read token",
    async (name) => {
      const workflow = z
        .looseObject({
          jobs: z.looseObject({
            gate: z.looseObject({
              permissions: z.record(z.string(), z.string()),
              outputs: z.record(z.string(), z.string()),
              steps: z.array(
                z.looseObject({
                  uses: z.string().optional(),
                  with: z.record(z.string(), z.unknown()).optional(),
                  run: z.string().optional(),
                  env: z.record(z.string(), z.string()).optional(),
                }),
              ),
            }),
          }),
        })
        .parse(
          parse(
            await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
          ),
        );
      const gate = workflow.jobs.gate;
      expect(gate.permissions).toEqual({ contents: "read", "pull-requests": "read" });
      expect(gate.steps).toHaveLength(2);
      expect(gate.steps[0]?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/u);
      expect(gate.steps[0]?.with).toEqual({
        ref: "${{ github.workflow_sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
      });
      expect(gate.steps[1]?.run).toBe("bash .github/e2e/assert-candidate-binding.sh admit");
      expect(gate.steps[1]?.env).toMatchObject({
        GH_TOKEN: "${{ github.token }}",
        WORKFLOW_SHA: "${{ github.workflow_sha }}",
        DISPATCH_SHA: "${{ github.sha }}",
        APPROVED_CANDIDATE_SHA: "${{ vars.DSH_E2E_CANDIDATE_SHA }}",
      });
      expect(JSON.stringify(gate)).not.toContain("secrets.");
      for (const field of [
        "run_e2e",
        "candidate_mode",
        "candidate_sha",
        "candidate_branch",
        "pull_request",
        "harness_sha",
      ]) {
        expect(gate.outputs[field]).toBe(`\${{ steps.bind.outputs.${field} }}`);
      }
    },
  );
});

// These workflows run on Ubuntu. Windows development can opt into Git Bash
// with DSH_TEST_BASH and put the real jq executable on PATH.
describe.skipIf(process.platform === "win32" && process.env.DSH_TEST_BASH === undefined)(
  "candidate admission and late binding",
  () => {
    it("emits the existing PR binding outputs only after admission", async () => {
      const result = await check("admit");
      expect(result.status).toBe(0);
      expect(result.outputs.replaceAll("\r", "").trim().split("\n")).toEqual([
        "run_e2e=true",
        "candidate_mode=pull-request",
        `candidate_sha=${candidateSha}`,
        "candidate_branch=candidate",
        "pull_request=42",
        `harness_sha=${mainSha}`,
      ]);
    });

    it.each(["", "0"])("admits exact main with omitted PR value %j", async (pr) => {
      const result = await check("admit", {
        CANDIDATE_MODE: "main",
        CANDIDATE_SHA: mainSha,
        APPROVED_CANDIDATE_SHA: mainSha,
        CANDIDATE_PR: pr,
      });
      expect(result.status).toBe(0);
      expect(result.outputs).toContain("pull_request=\n");
      expect(result.outputs).toContain("candidate_branch=main");
    });

    it.each([
      { name: "non-default workflow", values: { WORKFLOW_REF: "refs/heads/candidate" } },
      { name: "workflow mismatch", values: { WORKFLOW_SHA: candidateSha } },
      { name: "moved default branch", values: { FIXTURE_MAIN_SHA: candidateSha } },
      { name: "unapproved candidate", values: { APPROVED_CANDIDATE_SHA: mainSha } },
      { name: "read-only actor", values: { FIXTURE_PERMISSION: "read" } },
      { name: "invalid SHA", values: { CANDIDATE_SHA: "short" } },
      { name: "main candidate mismatch", values: { CANDIDATE_MODE: "main", CANDIDATE_PR: "" } },
    ])("rejects $name before emitting admission outputs", async ({ values }) => {
      const result = await check("admit", values);
      expect(result.status).not.toBe(0);
      expect(result.outputs).toBe("");
    });

    it.each([
      { name: "closed PR", value: { ...pull, state: "closed" } },
      { name: "draft PR", value: { ...pull, draft: true } },
      { name: "moved head", value: { ...pull, head: { ...pull.head, sha: mainSha } } },
      {
        name: "fork head",
        value: { ...pull, head: { ...pull.head, repo: { full_name: "fork/repo" } } },
      },
      {
        name: "foreign base repository",
        value: { ...pull, base: { ...pull.base, repo: { full_name: "other/repo" } } },
      },
      { name: "non-default base", value: { ...pull, base: { ...pull.base, ref: "other" } } },
    ])("rejects $name during admission and late revalidation", async ({ value }) => {
      for (const stage of ["admit", "revalidate"] as const) {
        const result = await check(stage, { FIXTURE_PULL: JSON.stringify(value) });
        expect(result.status).not.toBe(0);
        expect(result.outputs).toBe("");
      }
    });

    it("revalidates PR and main without depending on admission-only inputs or writing outputs", async () => {
      const admission = {
        WORKFLOW_REF: "",
        WORKFLOW_SHA: "",
        DISPATCH_SHA: "",
        ACTOR: "",
        APPROVED_CANDIDATE_SHA: "",
      };
      expect(await check("revalidate", admission)).toEqual({ status: 0, outputs: "" });
      expect(
        await check("revalidate", {
          ...admission,
          CANDIDATE_MODE: "main",
          CANDIDATE_SHA: mainSha,
          CANDIDATE_PR: "",
        }),
      ).toEqual({ status: 0, outputs: "" });
      const moved = await check("revalidate", {
        ...admission,
        CANDIDATE_MODE: "main",
        CANDIDATE_SHA: mainSha,
        CANDIDATE_PR: "",
        FIXTURE_MAIN_SHA: candidateSha,
      });
      expect(moved.status).not.toBe(0);
    });
  },
);
