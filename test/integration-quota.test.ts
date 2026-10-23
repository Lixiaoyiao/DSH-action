import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadInputs } from "../src/inputs.js";

interface ProbeOptions {
  readonly repository: string;
  readonly blobSha: string;
  readonly token: string;
}
interface ProbeDependencies {
  readonly fetch: typeof fetch;
  readonly report: (report: unknown) => void;
}
interface QuotaModule {
  readonly probeIntegrationQuota: (
    options: ProbeOptions,
    dependencies: ProbeDependencies,
  ) => Promise<void>;
}

async function quotaModule() {
  const imported: unknown = await import(
    pathToFileURL(resolve(".github/e2e/integration-quota.mjs")).href
  );
  return z
    .object({
      probeIntegrationQuota: z.custom<QuotaModule["probeIntegrationQuota"]>(
        (value) => typeof value === "function",
      ),
    })
    .parse(imported);
}

describe("integration writer-profile quota admission", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("selects the owned fixture through the Action's real environment input reader", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/e2e.yml", import.meta.url),
      "utf8",
    );
    const invocation = workflow.split("run_candidate github ")[1]?.split("github_result=")[0];
    if (invocation === undefined) throw new Error("Missing Issue-tool invocation");
    const bindings = [...invocation.matchAll(/["'](INPUT_[A-Z0-9-]+)=\$CHECKS_BASE_BRANCH["']/gu)];
    expect(bindings).toHaveLength(1);
    vi.stubEnv("INPUT_DEEPSEEK-API-KEY", "synthetic-deepseek-key");
    vi.stubEnv("INPUT_GITHUB-TOKEN", "synthetic-github-token");
    vi.stubEnv("INPUT_BASE-BRANCH", "");
    const name = bindings[0]?.[1];
    if (name === undefined) throw new Error("Missing fixture branch environment binding");
    vi.stubEnv(name, "dsh-e2e/checks-base-123-1");
    expect(loadInputs().baseBranch).toBe("dsh-e2e/checks-base-123-1");
  });
  it("reads one pinned blob using this job token and reports only quota scalars", async () => {
    const { probeIntegrationQuota } = await quotaModule();
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const reports: unknown[] = [];
    let bodyCancelled = false;
    await probeIntegrationQuota(
      {
        repository: "Lixiaoyiao/DSH-action",
        blobSha: "a".repeat(40),
        token: "test-private-token",
      },
      {
        fetch: (url, options) => {
          calls.push({
            url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
            options,
          });
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel: () => {
                  bodyCancelled = true;
                },
              }),
              {
                status: 200,
                headers: {
                  "x-ratelimit-limit": "1000",
                  "x-ratelimit-used": "2",
                  "x-ratelimit-remaining": "998",
                  "x-ratelimit-reset": "1791791527",
                  "x-ratelimit-resource": "core",
                },
              },
            ),
          );
        },
        report: (value) => reports.push(value),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/Lixiaoyiao/DSH-action/git/blobs/" + "a".repeat(40),
    );
    expect(calls[0]?.options?.method).toBe("GET");
    expect(bodyCancelled).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("test-private-token");
    expect(reports).toEqual([
      {
        scope: "core-e2e-integration-job",
        status: 200,
        quota: { limit: 1000, used: 2, remaining: 998, reset: 1791791527, resource: "core" },
        resetAt: "2026-10-12T07:52:07.000Z",
        readAdmitted: true,
        oldTokenRecoveryProven: false,
        completeJobBudgetProven: false,
      },
    ]);
  });

  it.each([
    { status: 403, remaining: "0", resource: "core" },
    { status: 429, remaining: "20", resource: "core" },
    { status: 200, remaining: undefined, resource: "core" },
    { status: 200, remaining: "-1", resource: "core" },
    { status: 200, remaining: "99999999999999999999999", resource: "core" },
    { status: 200, remaining: "998", resource: "graphql" },
  ])(
    "refuses admission without a usable content-read budget: $status/$remaining/$resource",
    async ({ status, remaining, resource }) => {
      const { probeIntegrationQuota } = await quotaModule();
      const reports: unknown[] = [];
      let requests = 0;
      const headers: Record<string, string> = {
        "x-ratelimit-limit": "1000",
        "x-ratelimit-used": "2",
        "x-ratelimit-reset": "1791791527",
        "x-ratelimit-resource": resource,
      };
      if (remaining !== undefined) headers["x-ratelimit-remaining"] = remaining;
      await expect(
        probeIntegrationQuota(
          {
            repository: "Lixiaoyiao/DSH-action",
            blobSha: "a".repeat(40),
            token: "test-private-token",
          },
          {
            fetch: () => {
              requests++;
              return Promise.resolve(new Response("private blob body", { status, headers }));
            },
            report: (value) => reports.push(value),
          },
        ),
      ).rejects.toThrow("no fixture or task was started");
      expect(requests).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        status,
        readAdmitted: false,
        oldTokenRecoveryProven: false,
        completeJobBudgetProven: false,
      });
      expect(JSON.stringify(reports)).not.toMatch(/private blob body|test-private-token/u);
    },
  );

  it("does not retry or echo a transport error that contains a credential", async () => {
    const { probeIntegrationQuota } = await quotaModule();
    let requests = 0;
    const reports: unknown[] = [];
    await expect(
      probeIntegrationQuota(
        {
          repository: "Lixiaoyiao/DSH-action",
          blobSha: "a".repeat(40),
          token: "test-private-token",
        },
        {
          fetch: () => {
            requests++;
            return Promise.reject(new Error("test-private-token private URL"));
          },
          report: (value) => reports.push(value),
        },
      ),
    ).rejects.toThrow(
      /^Integration job content-read quota was not established; no fixture or task was started$/u,
    );
    expect(requests).toBe(1);
    expect(reports).toEqual([]);
  });

  it("uses the run-owned snapshot for Issue tools while retaining native full-repository validation", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/e2e.yml", import.meta.url),
      "utf8",
    );
    const baseline = workflow
      .split("- name: Prepare deterministic GitHub integration harness")[1]
      ?.split("- name: Create isolated Issue and draft PR fixtures")[0];
    expect(baseline).toContain(
      'node .github/e2e/integration-quota.mjs "$(git hash-object action.yml)"',
    );
    const integration = workflow
      .split("- name: Exercise routes, filters, structured output, and typed GitHub tools")[1]
      ?.split("- name: Capture bounded business execution evidence")[0];
    const github = integration?.split("run_candidate github ")[1]?.split("github_result=")[0];
    expect(github).toContain('"INPUT_BASE-BRANCH=$CHECKS_BASE_BRANCH"');
    expect(integration).toContain(
      '[[ "$(gh api "repos/$REPOSITORY/git/ref/heads/$CHECKS_BASE_BRANCH" --jq .object.sha)" == "$CHECKS_BASE_SHA" ]]',
    );
    const native = integration
      ?.split("run_candidate native_write ")[1]
      ?.split("native_write_result=")[0];
    expect(native).not.toContain("INPUT_BASE-BRANCH");
    expect(native).toContain(
      'INPUT_TEST-COMMANDS=[["npm","ci","--ignore-scripts"],["npm","run","typecheck"],["npm","test"]]',
    );
  });
});
