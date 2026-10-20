import { finishRunReport } from "../src/result.js";
import { describe, expect, it } from "vitest";

import { AgentNoProgressError } from "../src/agent/loop.js";
import {
  DshConfigurationError,
  DshMalformedOutputError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import { ActionConfigurationError, PolicyDeniedError } from "../src/errors.js";
import { ExtensionPolicyError } from "../src/extensions/plan.js";
import {
  actionStatus,
  buildActionOutputs,
  describeActionFailure,
  formatStepSummary,
  type ActionPhase,
  type RunFacts,
} from "../src/result.js";
import {
  buildControllerToolPolicyAudit,
  buildDshToolPolicyAudit,
  type PermissionAudit,
} from "../src/permissions/profile.js";
import { buildAuthorityAudit } from "../src/security/authority.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import {
  ValidationIntegrityError,
  type ValidationIntegritySummary,
} from "../src/write/validation-integrity.js";
import { ValidationFailureError } from "../src/write/validate.js";
import { EntityBindingChangedError } from "../src/write/errors.js";
import { GitHubEntityRevalidationError } from "../src/tools/github-gateway-revalidation.js";
import { fixtureObject } from "./helpers/json-fixture.js";

it("preserves a stale entity identity through the Gateway transport wrapper", () => {
  const error = new GitHubEntityRevalidationError({
    cause: new EntityBindingChangedError("PR head changed"),
  });
  expect(describeActionFailure(error, "write")).toMatchObject({
    code: "ENTITY_BINDING_CHANGED",
    category: "domain",
    retryable: false,
  });
});

const policy: SecurityPolicy = {
  trust: "trusted-write",
  allowed: true,
  reason: "Explicit write gates passed",
  capabilities: {
    readRepository: true,
    readCi: true,
    publishComments: true,
    executeRepositoryCode: true,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: true,
    commit: true,
    push: true,
    createPullRequest: false,
    manageIssueLabels: true,
    manageIssueAssignees: true,
    updateIssueState: true,
    updatePullRequestMetadata: true,
  },
};

const permission: PermissionAudit = {
  schemaVersion: 1,
  digest: "d".repeat(64),
  profile: "custom",
  requestedTools: [
    "workspace.read",
    "workspace.edit",
    "native.web-search",
    "native.subagent",
    "mcp.repo-index.lookup",
  ],
  disallowedTools: ["native.subagent"],
  effectiveTools: [
    "workspace.read",
    "workspace.edit",
    "native.web-search",
    "mcp.repo-index.lookup",
  ],
  deniedTools: [
    {
      id: "native.subagent",
      reasonCode: "EXPLICIT_DENY",
      reason: "Explicit disallowed-tools entry; deny always wins",
    },
  ],
  network: "bridge",
  workspaceWrite: true,
  extensionDigest: "e".repeat(64),
  trustedExtensions: [
    {
      id: "repo-index",
      kind: "mcp",
      network: true,
      workspaceWrite: false,
    },
  ],
};

const toolPolicy = buildControllerToolPolicyAudit(permission, "controller");
const authority = buildAuthorityAudit();

const integrity: ValidationIntegritySummary = {
  schemaVersion: 1,
  mode: "strict",
  status: "changed",
  changeCount: 2,
  dangerousChangeCount: 0,
  controlPlaneChangeCount: 1,
  testChangeCount: 1,
  changes: [
    {
      path: "package.json",
      change: "modified",
      category: "entrypoint",
      risk: "suspicious",
      controlPlane: true,
      reasons: ["A configured package validation script changed and requires baseline replay"],
    },
    {
      path: "test/race.test.ts",
      change: "added",
      category: "test-source",
      risk: "informational",
      controlPlane: false,
      reasons: ["A validation test was added or modified"],
    },
  ],
  truncated: false,
  baselineReplay: { status: "passed", commandCount: 2 },
};

function failureOutcome(error: RunFacts["error"]): RunFacts {
  return {
    conclusion: "failure",
    operation: "fix",
    summary: error?.title ?? "Failed",
    findingsCount: 0,
    durationMs: 12_000,
    policy,
    ...(error === undefined ? {} : { error }),
  };
}

describe("versioned action results", () => {
  it("preserves partial model usage in outputs and explains the worker-reported buckets", () => {
    const usage = {
      source: "headless-worker" as const,
      completeness: "partial" as const,
      reportedSteps: 1,
      observedSteps: 2,
      tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 },
    };
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "review",
      summary: "Review complete",
      findingsCount: 0,
      durationMs: 10,
      agent: {
        durationMs: 10,
        usage,
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: false,
          processIsolated: true,
          networkIsolated: false,
          workspaceAccess: "read-only",
          extensionProfile: "github-action",
          limitations: [],
        },
      },
    };
    const result = fixtureObject(
      JSON.parse(String(buildActionOutputs(finishRunReport(outcome))["result-json"])),
    );
    expect(fixtureObject(result.agent).usage).toEqual(usage);
    const summary = formatStepSummary(finishRunReport(outcome));
    expect(summary).toContain("**Model usage (worker reported):** partial; 1/2 steps");
    expect(summary).toContain("uncached input 100; output 20; cache read 300");
    expect(summary).not.toContain("cache write");
  });
  it("emits three outputs and one canonical report with every confirmed fact", () => {
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "fix",
      summary: "Fixed the race",
      findingsCount: 2,
      durationMs: 4_200,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
      policy,
      permission,
      toolPolicy,
      dsh: { mode: "controlled", composition: "github-action-controlled" },
      authority,
      agent: {
        durationMs: 3_100,
        turns: 3,
        toolCalls: 1,
        validationRetries: 1,
        toolReceipts: [
          {
            callId: `call-${"a".repeat(40)}`,
            id: "command.test",
            ok: true,
            durationMs: 120,
          },
        ],
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: true,
          processIsolated: true,
          networkIsolated: false,
          workspaceAccess: "read-write",
          extensionProfile: "github-action",
          limitations: [],
        },
      },
      validation: { status: "passed", commandCount: 2, integrity },
      writeStatus: "success",
      commitSha: "c".repeat(40),
      changedPaths: ["src/fix.ts"],
      commentId: 99,
    };

    const outputs = buildActionOutputs(finishRunReport(outcome));
    expect(Object.keys(outputs).sort()).toEqual(["conclusion", "result-json", "summary"]);
    expect(outputs.conclusion).toBe("success");
    expect(outputs.summary).toBe("Fixed the race");
    const result = fixtureObject(JSON.parse(outputs["result-json"] ?? ""));
    expect(result).toMatchObject({
      schemaVersion: 2,
      termination: {
        conclusion: "success",
        status: "success",
        summary: "Fixed the race",
        durationMs: 4_200,
      },
      operation: { kind: "fix", findingsCount: 2 },
      context: {
        runUrl: "https://github.com/octo/repo/actions/runs/10",
        policy: { trust: "trusted-write", allowed: true },
        permission,
        toolPolicy,
        dsh: { mode: "controlled", composition: "github-action-controlled" },
        authority,
      },
      agent: {
        durationMs: 3_100,
        turns: 3,
        toolCalls: 1,
        validationRetries: 1,
        toolReceipts: [{ id: "command.test", ok: true }],
      },
      validation: { status: "passed", commandCount: 2, integrity },
      publication: {
        writeStatus: "success",
        commitSha: "c".repeat(40),
        changedPaths: ["src/fix.ts"],
        commentId: 99,
      },
    });
    expect(fixtureObject(result.validation).integrity).toEqual(integrity);
    expect(outputs).not.toHaveProperty("authority");
  });

  it("represents a successful write with no repository mutation", () => {
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "task",
      summary: "The requested state was already present",
      findingsCount: 0,
      durationMs: 500,
      writeStatus: "no-changes",
      changedPaths: [],
    };

    const outputs = buildActionOutputs(finishRunReport(outcome));
    expect(JSON.parse(String(outputs["result-json"]))).toMatchObject({
      termination: { status: "success" },
      publication: { writeStatus: "no-changes", changedPaths: [] },
    });
    expect(formatStepSummary(finishRunReport(outcome))).toContain("**Write:** no-changes");
    expect(
      fixtureObject(fixtureObject(JSON.parse(outputs["result-json"] ?? "")).operation),
    ).not.toHaveProperty("taskOutput");
  });

  it("adds validated task output without replacing the fixed audit envelope", () => {
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "task",
      summary: "Release assessment complete",
      findingsCount: 0,
      durationMs: 750,
      taskOutput: { releaseReady: true, checks: ["unit", "integration"] },
    };

    const outputs = buildActionOutputs(finishRunReport(outcome));
    expect(JSON.parse(outputs["result-json"] ?? "")).toEqual({
      schemaVersion: 2,
      termination: {
        status: "success",
        conclusion: "success",
        summary: "Release assessment complete",
        durationMs: 750,
      },
      operation: {
        kind: "task",
        findingsCount: 0,
        taskOutput: { releaseReady: true, checks: ["unit", "integration"] },
      },
      context: {},
    });
  });

  it("distinguishes timeout, validation, denial, and ordinary failure statuses", () => {
    const timeout = failureOutcome(describeActionFailure(new DshTimeoutError(60_000), "agent"));
    const validation = failureOutcome(
      describeActionFailure(
        new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "failed",
            timedOut: false,
            outputTruncated: false,
          },
        }),
        "write",
      ),
    );
    const denied = failureOutcome(
      describeActionFailure(new PolicyDeniedError("allow-write is false"), "context"),
    );
    const validationTimeout = failureOutcome(
      describeActionFailure(
        new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 137,
            stdout: "",
            stderr: "",
            timedOut: true,
            outputTruncated: false,
          },
        }),
        "write",
      ),
    );
    const malformed = failureOutcome(
      describeActionFailure(new DshMalformedOutputError("invalid JSON"), "agent"),
    );
    const validationInfrastructure = failureOutcome(
      describeActionFailure(new Error("Docker could not start"), "validation"),
    );
    const validationConfiguration = failureOutcome(
      describeActionFailure(new DshConfigurationError("mutable image"), "validation"),
    );

    expect(actionStatus(timeout)).toBe("timed_out");
    expect(actionStatus(validation)).toBe("validation_failed");
    expect(validation.error).toMatchObject({
      code: "VALIDATION_FAILED",
      category: "domain",
      phase: "write",
      retryable: false,
    });
    expect(actionStatus(validationTimeout)).toBe("validation_failed");
    expect(validationTimeout.error).toMatchObject({
      code: "VALIDATION_TIMEOUT",
      category: "domain",
      phase: "write",
      retryable: true,
    });
    expect(actionStatus(denied)).toBe("denied");
    expect(denied.error).toMatchObject({
      code: "POLICY_DENIED",
      category: "policy",
      phase: "context",
      retryable: false,
    });
    expect(actionStatus(malformed)).toBe("validation_failed");
    expect(validationInfrastructure.error).toMatchObject({
      code: "ACTION_RUNTIME_FAILED",
      category: "runtime",
      phase: "validation",
      retryable: true,
    });
    expect(actionStatus(validationInfrastructure)).toBe("failed");
    expect(validationConfiguration.error).toMatchObject({
      code: "DSH_CONFIGURATION",
      category: "configuration",
      phase: "validation",
      retryable: false,
    });
    expect(actionStatus(validationConfiguration)).toBe("failed");
  });

  it("keeps classified error identity stable while phase records only where it surfaced", () => {
    const phases: readonly ActionPhase[] = [
      "entrypoint",
      "configuration",
      "routing",
      "authorization",
      "context",
      "agent",
      "validation",
      "publication",
      "write",
    ];
    const classified = [
      {
        error: new ActionConfigurationError("invalid input"),
        identity: { code: "ACTION_CONFIGURATION", category: "configuration", retryable: false },
        status: "failed",
      },
      {
        error: new ExtensionPolicyError("extension denied"),
        identity: { code: "POLICY_DENIED", category: "policy", retryable: false },
        status: "denied",
      },
      {
        error: new DshTimeoutError(1_000),
        identity: { code: "DSH_TIMEOUT", category: "runtime", retryable: true },
        status: "timed_out",
      },
      {
        error: new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "failed",
            timedOut: false,
            outputTruncated: false,
          },
        }),
        identity: { code: "VALIDATION_FAILED", category: "domain", retryable: false },
        status: "validation_failed",
      },
    ] as const;

    for (const { error, identity, status } of classified) {
      for (const phase of phases) {
        const failure = describeActionFailure(error, phase);
        expect(failure).toMatchObject({ ...identity, phase });
        expect(actionStatus(failureOutcome(failure))).toBe(status);
      }
    }
  });

  it("reports extension policy denial from context without phase-based reclassification", () => {
    const failure = describeActionFailure(
      new ExtensionPolicyError("Bridge-networked extensions are denied"),
      "context",
    );
    const outputs = buildActionOutputs(finishRunReport(failureOutcome(failure)));
    const structured = fixtureObject(JSON.parse(String(outputs["result-json"])));

    expect(failure).toMatchObject({
      code: "POLICY_DENIED",
      category: "policy",
      phase: "context",
      retryable: false,
    });
    expect(failure.code).not.toBe("CONTEXT_PREPARATION_FAILED");
    expect(fixtureObject(structured.termination).error).toEqual(failure);
  });

  it("keeps the generic runtime identity stable for unclassified errors across phases", () => {
    const phases: readonly ActionPhase[] = [
      "entrypoint",
      "configuration",
      "routing",
      "authorization",
      "context",
      "agent",
      "validation",
      "publication",
      "write",
    ];

    for (const phase of phases) {
      const failure = describeActionFailure(new Error("unknown"), phase);
      expect(failure).toMatchObject({
        code: "ACTION_RUNTIME_FAILED",
        category: "runtime",
        phase,
        retryable: true,
      });
      expect(actionStatus(failureOutcome(failure))).toBe("failed");
    }
  });

  it("classifies validation-integrity failures before generic validation failures", () => {
    const blocked: ValidationIntegritySummary = {
      schemaVersion: 1,
      mode: "strict",
      status: "blocked",
      changeCount: 1,
      dangerousChangeCount: 1,
      controlPlaneChangeCount: 1,
      testChangeCount: 0,
      changes: [
        {
          path: "package.json",
          change: "modified",
          category: "entrypoint",
          risk: "dangerous",
          controlPlane: true,
          reasons: ["Configured validation script became a no-op"],
        },
      ],
      truncated: false,
    };
    const failure = describeActionFailure(new ValidationIntegrityError(blocked), "write");

    expect(failure).toMatchObject({
      code: "VALIDATION_INTEGRITY",
      category: "domain",
      phase: "write",
      title: "Validation integrity policy blocked the write",
      retryable: false,
    });
    expect(failure.guidance).toContain("The Agent cannot lower validation-integrity");
    expect(actionStatus(failureOutcome(failure))).toBe("validation_failed");

    const noProgress = describeActionFailure(
      new AgentNoProgressError({ cause: new ValidationIntegrityError(blocked) }),
      "agent",
    );
    expect(noProgress).toMatchObject({
      code: "VALIDATION_INTEGRITY",
      category: "domain",
      phase: "agent",
    });
  });

  it("reports effective permission and validation-integrity details in the step summary", () => {
    const deniedTools = [
      {
        id: "native.subagent" as const,
        reasonCode: "TRUST_REQUIRED" as const,
        reason: "Denied for @team ![pixel](https://tracker.invalid) `policy`",
      },
    ];
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "fix",
      summary: "Updated code and tests",
      findingsCount: 0,
      durationMs: 1_500,
      permission: {
        ...permission,
        deniedTools,
      },
      toolPolicy: { ...toolPolicy, deniedTools },
      dsh: { mode: "controlled", composition: "github-action-controlled" },
      authority,
      validation: { status: "passed", commandCount: 2, integrity },
    };

    const summary = formatStepSummary(finishRunReport(outcome));
    expect(summary).toContain("### Effective Agent permissions");
    expect(summary).toContain("**DSH mode:** controlled");
    expect(summary).toContain("**DSH composition:** github-action-controlled");
    expect(summary).toContain("**Profile:** `custom`");
    expect(summary).toContain("**Tool policy owner:** `Controller`");
    expect(summary).toContain("**Requested tools:**");
    expect(summary).toContain("`native.web-search`");
    expect(summary).toContain("**Network:** `bridge`");
    expect(summary).toContain("**Workspace write:** `enabled`");
    expect(summary).toContain("`mcp:repo-index (network=yes, workspace-write=no)`");
    expect(summary).toContain("**Denials (1):**");
    expect(summary).toContain("### Known authority sources");
    expect(summary).toContain("`controller:github (credential not exposed to worker)`");
    expect(summary).toContain("`controller:deepseek (run-scoped proxy mediation)`");
    expect(summary).toContain("does not prove the worker has no other authority");
    expect(summary).toContain("@​team [image removed] 'policy'");
    expect(summary).toContain("**Integrity:** mode `strict` · status `changed`");
    expect(summary).toContain(
      "**Definition changes:** 2 total · 0 dangerous · 1 control-plane · 1 test",
    );
    expect(summary).toContain("**Baseline replay:** `passed` (2 command(s))");
  });

  it("labels a native DSH-owned runtime inventory as observed rather than effective", () => {
    const observedToolPolicy = buildDshToolPolicyAudit(["read", "grep"]);
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "task",
      summary: "Observed runtime inventory",
      findingsCount: 0,
      durationMs: 10,
      permission,
      toolPolicy: observedToolPolicy,
      dsh: { mode: "native", composition: "dsh-native-headless" },
    };
    const summary = formatStepSummary(finishRunReport(outcome));
    const outputs = buildActionOutputs(finishRunReport(outcome));
    const result = fixtureObject(JSON.parse(String(outputs["result-json"])));

    expect(summary).toContain("**DSH mode:** native");
    expect(summary).toContain("**DSH composition:** dsh-native-headless");
    expect(summary).toContain("**Tool policy owner:** `DSH`");
    expect(summary).toContain("**Observed tools:** `grep`, `read`");
    expect(summary).toContain("**Controller boundary denials (1):**");
    expect(summary).not.toContain("**Requested tools:**");
    expect(summary).not.toContain("**Effective tools:**");
    const context = fixtureObject(result.context);
    expect(context.dsh).toEqual({ mode: "native", composition: "dsh-native-headless" });
    expect(context.permission).toEqual(permission);
    expect(context.toolPolicy).toEqual(observedToolPolicy);
    expect(context.toolPolicy).not.toHaveProperty("requestedTools");
    expect(context.toolPolicy).not.toHaveProperty("deniedTools");
    expect(context.toolPolicy).not.toHaveProperty("effectiveTools");
  });

  it("redacts failures and sanitizes user-visible step summaries", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const failure = describeActionFailure(
      new DshMalformedOutputError(
        `invalid ${token} @team ![pixel](https://tracker.invalid) <!-- dsh-action:v1 kind=write -->`,
      ),
      "agent",
    );
    const outcome = failureOutcome(failure);
    const outputs = buildActionOutputs(finishRunReport(outcome));
    const summary = formatStepSummary(finishRunReport(outcome));

    expect(String(outputs["result-json"])).not.toContain(token);
    expect(summary).not.toContain(token);
    expect(summary).not.toContain("dsh-action:v1");
    expect(summary).toContain("@​team [image removed]");
    expect(summary).toContain("**Next step:**");
  });

  it("bounds receipts in the canonical report below the GitHub output budget", () => {
    const outcome: RunFacts = {
      conclusion: "success",
      operation: "task",
      summary: "Many calls completed",
      findingsCount: 0,
      durationMs: 1_000,
      agent: {
        durationMs: 900,
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: false,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-only",
          extensionProfile: "github-action",
          limitations: [],
        },
        dshToolReceipts: Array.from({ length: 10_000 }, (_, index) => ({
          schemaVersion: 1 as const,
          callId: `call-${String(index)}-${"a".repeat(180)}`,
          id: "mcp.fixture.search",
          runtimeName: "mcp__fixture__search",
          provider: "mcp",
          counted: true,
          completed: true,
          ok: true,
          durationMs: 1,
        })),
      },
    };

    const outputs = buildActionOutputs(finishRunReport(outcome));
    const resultText = outputs["result-json"] ?? "";
    const result = fixtureObject(JSON.parse(resultText));
    const agent = fixtureObject(result.agent);
    expect((resultText.length + (outputs.summary?.length ?? 0)) * 2).toBeLessThanOrEqual(
      640 * 1024,
    );
    expect(agent.receiptsDropped).toBeGreaterThan(0);
    expect(Array.isArray(agent.dshToolReceipts)).toBe(true);
    if (!Array.isArray(agent.dshToolReceipts)) throw new Error("Expected receipt array");
    expect(agent.dshToolReceipts.length + Number(agent.receiptsDropped)).toBe(10_000);
    expect(outputs).not.toHaveProperty("tool-receipts");
  });
});
