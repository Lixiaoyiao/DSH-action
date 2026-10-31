import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isRecord } from "../src/security/record.js";

function workflowSteps(workflow: string): readonly Readonly<Record<string, unknown>>[] {
  return Object.values(workflowRecord(workflowRecord(parse(workflow)).jobs)).flatMap((job) => {
    const steps = workflowRecord(job).steps;
    return Array.isArray(steps) ? steps.map(workflowRecord) : [];
  });
}
function step(workflow: string, id: string): Readonly<Record<string, unknown>> {
  const matches = workflowSteps(workflow).filter((value) => value.id === id || value.name === id);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("Expected one workflow step: " + id);
  return matches[0];
}
function stepRun(workflow: string, id: string): string {
  const run = step(workflow, id).run;
  if (typeof run !== "string") throw new Error("Expected script for workflow step: " + id);
  return run;
}
function stepInputs(workflow: string, id: string): Readonly<Record<string, unknown>> {
  return workflowRecord(step(workflow, id).with);
}
function jsonInput(inputs: Readonly<Record<string, unknown>>, name: string): unknown {
  const value = inputs[name];
  if (typeof value !== "string") throw new Error("Missing input " + name);
  return JSON.parse(value) as unknown;
}

function workflowRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error("Expected a workflow mapping");
  }
  return value;
}

function candidateShellCalls(script: string): readonly { name: string; invocation: string }[] {
  const lines = script.split(/\r?\n/u);
  const calls: { name: string; invocation: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line === undefined) continue;
    const name = /^\s*run_candidate\s+(\w+)\s/u.exec(line)?.[1];
    if (name === undefined) continue;
    let invocation = line;
    while (line.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      line = lines[index] ?? "";
      invocation += `\n${line}`;
    }
    calls.push({ name, invocation });
  }
  return calls;
}

describe("trusted core E2E workflow", () => {
  let workflow: string;

  beforeAll(async () => {
    workflow = await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  });

  it("parses as YAML and exposes separate pull-request and exact-main qualification modes", () => {
    expect(() => {
      parse(workflow);
    }).not.toThrow();
    const parsed = workflowRecord(parse(workflow));
    const dispatch = workflowRecord(workflowRecord(parsed.on).workflow_dispatch);
    expect(workflowRecord(workflowRecord(dispatch.inputs).candidate_mode).options).toEqual([
      "pull-request",
      "main",
    ]);
    expect(workflowRecord(step(workflow, "bind").env).APPROVED_CANDIDATE_SHA).toBe(
      "${{ vars.DSH_E2E_CANDIDATE_SHA }}",
    );
    expect(stepRun(workflow, "bind")).toContain(
      "bash .github/e2e/assert-candidate-binding.sh admit",
    );
    expect(
      workflowSteps(workflow).some(
        (value) =>
          typeof value.run === "string" &&
          value.run.includes('if [[ "$CANDIDATE_MODE" == "pull-request" ]]; then'),
      ),
    ).toBe(true);
  });

  it("keeps the integrity golden path on one minimal trusted-write turn", () => {
    const integrity = stepInputs(workflow, "integrity");

    expect(integrity).toMatchObject({
      "permission-profile": "custom",
      "max-turns": "1",
      "deepseek-api-key": "dsh-e2e-integrity-fixture-key",
      "base-url": "${{ steps.integrity_fixture.outputs.base_url }}",
    });
    expect(jsonInput(integrity, "allowed-tools")).toEqual(["workspace.edit", "native.bash"]);
    expect(integrity.prompt).toContain("DSH_E2E_INTEGRITY_FIXTURE");
    expect(Object.values(integrity).join(" ")).not.toContain("secrets.DEEPSEEK_API_KEY");
    const start = stepRun(workflow, "integrity_fixture");
    expect(start).toContain("node .github/e2e/integrity-llm.mjs");
    expect(start).not.toContain("secrets.");
    expect(step(workflow, "Stop deterministic integrity fixture").if).toBe("always()");
    expect(stepRun(workflow, "Assert integrity failure")).toContain(
      'map(.phase) == ["bash-issued", "bash-observed"]',
    );
  });

  it("uses the bound candidate runtime default at every Action and direct-process entry", () => {
    expect(
      workflowSteps(workflow)
        .filter((value) => value.uses === "./candidate-action")
        .every((value) => !Object.hasOwn(workflowRecord(value.with), "dsh-version")),
    ).toBe(true);
    expect(workflow).not.toContain("INPUT_DSH-VERSION=");
    expect(workflowSteps(workflow).some((value) => value.uses === "./candidate-action")).toBe(true);
    expect(workflow).toContain("node candidate-action/dist/index.js");
  });

  it("declares real validation commands for the no-change Subagent write without executing validation", () => {
    const launch = stepInputs(workflow, "no_change");
    const assertion = stepRun(workflow, "Assert native.subagent and no-change semantics");
    expect(jsonInput(launch, "test-commands")).toEqual([
      ["npm", "ci", "--ignore-scripts"],
      ["npm", "run", "typecheck"],
      ["npm", "test"],
    ]);
    expect(launch).toMatchObject({
      "task-access": "write",
      "allow-write": "true",
      "run-tests": "true",
    });
    expect(jsonInput(launch, "disallowed-tools")).toEqual(["native.bash", "native.web-search"]);
    expect(assertion).toContain('.policy.trust == "trusted-write"');
    expect(assertion).toContain('.write.status == "no-changes" and .write.changedPaths == []');
    expect(assertion).toContain('.validation.status == "not-applicable"');
    expect(assertion).toContain('.id == "native.subagent" and .completed == true and .ok == true');
    expect(assertion).toContain("for component in main candidate prs comments task-refs task-prs");
  });

  it("requires nonempty validation argv for every explicit write task and preserves the failing validator", () => {
    const parsed: unknown = parse(workflow);
    const steps = Object.values(workflowRecord(workflowRecord(parsed).jobs)).flatMap((job) => {
      const candidates = workflowRecord(job).steps;
      return Array.isArray(candidates) ? candidates.map(workflowRecord) : [];
    });
    const writeTasks = steps.filter((step) => {
      if (step.uses !== "./candidate-action") return false;
      const inputs = workflowRecord(step.with);
      return inputs.command === "task" && inputs["task-access"] === "write";
    });
    expect(writeTasks.map((step) => step.id)).toEqual(
      expect.arrayContaining(["native_write", "no_change"]),
    );
    for (const step of writeTasks) {
      const configured = workflowRecord(step.with)["test-commands"];
      if (typeof configured !== "string") {
        throw new Error(`Positive write ${String(step.name)} lacks explicit validation commands`);
      }
      const commands: unknown = JSON.parse(configured);
      expect(commands, String(step.name)).toBeInstanceOf(Array);
      if (!Array.isArray(commands)) throw new Error("Validation commands must be argv arrays");
      expect(commands.length, String(step.name)).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, String(step.name)).toBeInstanceOf(Array);
        if (!Array.isArray(command)) throw new Error("Validation command must be an argv array");
        expect(command.length, String(step.name)).toBeGreaterThan(0);
        expect(command.every((argument: unknown) => typeof argument === "string")).toBe(true);
      }
    }
    const failingValidator = writeTasks.find(
      (step) => workflowRecord(step.with)["test-commands"] === '[["false"]]',
    );
    expect(failingValidator?.["continue-on-error"]).toBe(true);
  });

  it("requires each shell-launched write to provide its own nonempty validation argv", () => {
    const parsed: unknown = parse(workflow);
    const scripts = Object.values(workflowRecord(workflowRecord(parsed).jobs)).flatMap((job) => {
      const steps = workflowRecord(job).steps;
      return Array.isArray(steps)
        ? steps.flatMap((step: unknown) => {
            const run = workflowRecord(step).run;
            return typeof run === "string" ? [run] : [];
          })
        : [];
    });
    const calls = scripts.flatMap(candidateShellCalls);
    const writes = calls.filter(({ invocation }) =>
      /INPUT_ALLOW-WRITE=true|INPUT_TASK-ACCESS=write|INPUT_COMMAND=(?:fix|implement)/u.test(
        invocation,
      ),
    );
    expect(writes.map(({ name }) => name)).toEqual([
      "github",
      "metadata",
      "native_write",
      "fix",
      "implement",
    ]);
    for (const { name, invocation } of writes) {
      expect(invocation, name).toContain("'INPUT_RUN-TESTS=true'");
      const configured = /(['"])INPUT_TEST-COMMANDS=(.*?)\1/u.exec(invocation)?.[2];
      expect(configured, name).toBeDefined();
      if (configured === undefined) throw new Error(`Shell write ${name} lacks validation argv`);
      if (configured === "$validation") {
        const script = scripts.find((candidate) => candidate.includes(invocation));
        const setup = script?.slice(0, script.indexOf(invocation));
        expect(setup, name).toContain(
          '\'[["node",".github/dsh-e2e-fixtures/validate-business-file.mjs",$path,$content]]\'',
        );
        continue;
      }
      const commands: unknown = JSON.parse(configured);
      expect(commands, name).toBeInstanceOf(Array);
      if (!Array.isArray(commands)) throw new Error(`Shell write ${name} has invalid validation`);
      expect(commands.length, name).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, name).toBeInstanceOf(Array);
        if (!Array.isArray(command)) throw new Error(`Shell write ${name} has invalid argv`);
        expect(command.length, name).toBeGreaterThan(0);
        expect(command.every((argument: unknown) => typeof argument === "string")).toBe(true);
      }
    }
    const nativeWrite = writes.find(({ name }) => name === "native_write")?.invocation;
    expect(nativeWrite).toContain(
      'INPUT_TEST-COMMANDS=[["npm","ci","--ignore-scripts"],["npm","run","typecheck"],["npm","test"]]',
    );
    for (const script of scripts.filter((candidate) => candidate.includes("run_candidate()"))) {
      const defaults = script.split("run_candidate() {")[1]?.split("read_output() {")[0];
      expect(defaults).toBeDefined();
      expect(defaults).not.toContain("INPUT_TEST-COMMANDS=");
    }
  });

  it("installs candidate test dependencies separately from the trusted harness lock", () => {
    const fixtures = stepRun(workflow, "Install fixture dependencies without lifecycle scripts");
    const candidate = stepRun(
      workflow,
      "Install exact candidate test dependencies without lifecycle scripts",
    );
    const ecosystem = stepRun(workflow, "Deterministic native ecosystem compatibility");

    expect(fixtures).toContain("npm ci --ignore-scripts");
    expect(candidate).toContain("npm ci --prefix candidate-action --ignore-scripts --no-fund");
    expect(candidate).toContain("npm ls --prefix candidate-action --all");
    expect(candidate).not.toMatch(/--force|--legacy-peer-deps|--no-audit/u);
    expect(ecosystem).toContain("cd candidate-action");
    expect(ecosystem).toContain("./node_modules/.bin/vitest run");
    expect(ecosystem).not.toContain("../node_modules/.bin/vitest");
    expect(workflowSteps(workflow).findIndex((value) => value.run === candidate)).toBeLessThan(
      workflowSteps(workflow).findIndex((value) => value.run === ecosystem),
    );
  });

  it("locks controlled tool-policy semantics into the strict and MCP golden paths", () => {
    const strict = stepRun(workflow, "Assert strict/Profile/Bundle result");
    const mcp = stepRun(workflow, "Assert MCP allow/deny and receipts");

    for (const assertion of [strict, mcp]) {
      expect(assertion).toContain('.toolPolicy.policyOwner == "controller"');
      expect(assertion).toContain(".toolPolicy.effectiveTools == .permissions.effectiveTools");
      expect(assertion).toContain('(.toolPolicy | has("observedTools") | not)');
    }
    expect(strict).toContain(
      '.toolPolicy.requestedTools == ["workspace.edit","workspace.read","workspace.search"]',
    );
    expect(mcp).toContain(
      '.toolPolicy.requestedTools == ["mcp.fixture.echo","mcp.fixture.hidden","workspace.read","workspace.search"]',
    );
  });

  it("requires an unknown MCP proof from the real model without exposing its expected value", () => {
    const start = stepRun(workflow, "mcp_server");
    const launch = stepInputs(workflow, "mcp");
    const assertion = stepRun(workflow, "Assert MCP allow/deny and receipts");
    const report = stepRun(workflow, "Report bounded MCP proof diagnostics");
    const artifact = step(workflow, "Preserve MCP execution evidence");

    expect(launch["deepseek-api-key"]).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
    expect(launch.prompt).toContain("taskOutput.proof");
    expect(jsonInput(launch, "task-output-schema")).toMatchObject({
      properties: { proof: { type: "string", minLength: 48, maxLength: 48 } },
    });
    expect(Object.values(launch).join(" ")).not.toMatch(
      /expectedProof|expected_proof|\.endpoint|const.*proof/iu,
    );
    const servers = workflowRecord(jsonInput(launch, "mcp-config")).servers;
    if (!Array.isArray(servers)) throw new Error("Missing MCP servers");
    const tools = workflowRecord(servers[0]).tools;
    if (!Array.isArray(tools)) throw new Error("Missing MCP tools");
    expect(tools.some((tool) => workflowRecord(tool).maxCalls === 1)).toBe(true);
    expect(jsonInput(launch, "disallowed-tools")).toEqual(["mcp.fixture.hidden"]);
    expect(start).toContain('echo "::add-mask::$proof"');
    expect(workflowSteps(workflow).find((value) => value.run === assertion)?.if).toBe("always()");
    expect(assertion.indexOf("mcp-proof-evidence.mjs capture")).toBeLessThan(
      assertion.indexOf("jq -e"),
    );
    expect(assertion).toContain('.actionOutcome == "success" and .proofMatches == true');
    expect(assertion).toContain('[[ "$(wc -l < "$MCP_AUDIT")" -eq 1 ]]');
    expect(assertion).toContain("length == 1");
    expect(assertion).toContain('all(.id != "mcp.fixture.hidden")');
    expect(workflowSteps(workflow).find((value) => value.run === report)?.if).toBe("always()");
    expect(report).not.toMatch(/RESULT_JSON|task-output|summary:|MCP_ENDPOINT|DEEPSEEK_API_KEY/u);
    expect(artifact.if).toBe("always()");
    expect(workflowRecord(artifact.with).path).toContain("dsh-e2e-mcp-evidence.json");
    expect(workflowRecord(artifact.with).path).toContain("dsh-e2e-mcp-audit.jsonl");
    expect(workflowRecord(artifact.with).path).not.toMatch(
      /endpoint|server\.log|\.stdout|result-json/u,
    );
  });

  it("requires a source from a real Web Search and records evidence before failed assertions", () => {
    const launch = stepInputs(workflow, "web");
    const assertion = stepRun(workflow, "Assert Web Search mediation and receipt");
    const artifact = step(workflow, "Preserve bounded Web Search evidence");
    expect(launch["deepseek-api-key"]).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
    expect(launch.prompt).toContain("actual DSH runtime web_search tool exactly once");
    expect(launch.prompt).toContain("first source returned by that tool");
    expect(launch.prompt).toContain("site:api-docs.deepseek.com context caching");
    expect(jsonInput(launch, "allowed-tools")).toEqual(["native.web-search"]);
    expect(launch["task-output-schema"]).toBeDefined();
    expect(launch).not.toHaveProperty("base-url");
    expect(launch).not.toHaveProperty("mcp-config");
    expect(launch.isolation).not.toBe("none");
    expect(launch.prompt).not.toContain("official DeepSeek Harness repository");
    expect(workflowSteps(workflow).find((value) => value.run === assertion)?.if).toBe("always()");
    expect(assertion.indexOf("node .github/e2e/web-search-evidence.mjs")).toBeLessThan(
      assertion.indexOf("jq -e"),
    );
    expect(assertion).toContain(".receiptCount == 1 and .completedWebSearchCount == 1");
    expect(assertion).toContain('.permissions.network == "mediated-web"');
    expect(assertion).toContain(".loop.dshToolReceipts // []");
    expect(artifact.if).toBe("always()");
    expect(workflowRecord(artifact.with).path).toContain("dsh-e2e-web-evidence.json");
    expect(workflowRecord(artifact.with).path).not.toMatch(/result-json|\.log|\.stdout/u);
  });

  it("runs an exact-candidate native read-only smoke with observed DSH inventory", () => {
    const launch = stepInputs(workflow, "native");
    const assertion = stepRun(workflow, "Assert native composition and observed inventory");

    expect(step(workflow, "native").uses).toBe("./candidate-action");
    expect(launch["dsh-mode"]).toBe("native");
    expect(launch.isolation).toBe("docker");
    expect(launch).not.toHaveProperty("mcp-config");
    expect(launch).not.toHaveProperty("plugin-config");
    for (const contract of [
      '.dsh.mode == "native"',
      '.dsh.composition == "dsh-native-headless"',
      '.toolPolicy.policyOwner == "dsh"',
      'index("read") != null',
      'index("glob") != null',
      'index("grep") != null',
      'index("workspace.read") == null',
      '(.toolPolicy | has("effectiveTools") | not)',
      '(.toolPolicy | has("requestedTools") | not)',
      '.isolation.workspaceAccess == "read-only"',
      '.isolation.extensionProfile == "none"',
    ]) {
      expect(assertion).toContain(contract);
    }
  });

  it("qualifies the candidate native ecosystem, trusted-write workspace, and Controller GitHub path", async () => {
    const ecosystem = stepRun(workflow, "Deterministic native ecosystem compatibility");
    const nativeWrite = stepInputs(workflow, "native_write");
    const nativeWriteAssertion = stepRun(workflow, "Assert native trusted-write authority");
    const integration = stepRun(workflow, "integration_contracts");
    const fixture = await readFile(
      new URL("../.github/e2e/github-integration-llm.mjs", import.meta.url),
      "utf8",
    );

    expect(ecosystem).toContain("cd candidate-action");
    expect(ecosystem).toContain(
      "./node_modules/.bin/vitest run test/native-ecosystem.integration.test.ts",
    );
    expect(step(workflow, "native_write").uses).toBe("./candidate-action");
    expect(nativeWrite["deepseek-api-key"]).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
    expect(nativeWrite["dsh-mode"]).toBe("native");
    expect(nativeWrite["task-access"]).toBe("write");
    expect(jsonInput(nativeWrite, "allowed-tools")).toEqual(["workspace.edit"]);
    expect(nativeWriteAssertion).toContain('.policy.trust == "trusted-write"');
    expect(nativeWriteAssertion).toContain('.isolation.workspaceAccess == "read-write"');
    expect(nativeWriteAssertion).toContain('.toolPolicy.policyOwner == "dsh"');
    for (const contract of [
      "run_candidate native_write",
      "run_candidate native_checks",
      "INPUT_DSH-MODE=native",
      'INPUT_ALLOWED-TOOLS=["workspace.edit"]',
      'INPUT_ALLOWED-TOOLS=["github.checks.read"]',
      '.dsh.composition == "dsh-native-headless"',
      '.toolPolicy.policyOwner == "dsh"',
      '(.toolPolicy | has("effectiveTools") | not)',
      '.isolation.workspaceAccess == "read-write"',
      '.permissions.effectiveTools == ["github.checks.read"]',
      'fixture_hash="$(printf',
      '[[ "$public_result" != *"$fixture_key"* ]]',
      '[[ "$public_result" != *"$fixture_hash"* ]]',
    ]) {
      expect(integration).toContain(contract);
    }
    expect(fixture).toContain('route.startsWith("native-")');
    expect(fixture).toContain('prompt.includes("Generate the session title")');
    expect(fixture).toContain('route === "native-write"');
    expect(fixture).toContain('route === "native-checks"');
  });

  it("requires an authoritative blocked integrity result without a write envelope", () => {
    const assertion = stepRun(workflow, "Assert integrity failure");

    for (const contract of [
      '.error.code == "VALIDATION_INTEGRITY"',
      '.error.category == "domain"',
      '.error.phase == "validation"',
      ".error.retryable == false",
      '.validation.integrity.mode == "strict"',
      '.validation.integrity.status == "blocked"',
      ".validation.integrity.dangerousChangeCount >= 1",
      ".validation.integrity.controlPlaneChangeCount >= 1",
      '.path == "scripts/verify-dsh-config.mjs"',
      '.change == "modified"',
      '.category == "entrypoint"',
      '.risk == "dangerous"',
      'contains("no-op")',
      '(has("write") | not)',
    ]) {
      expect(assertion).toContain(contract);
    }
  });

  it("checks remote mutation state even after a semantic assertion failure", () => {
    const mutation = stepRun(workflow, "Assert expected failures made no GitHub mutation");

    expect(workflowSteps(workflow).find((value) => value.run === mutation)?.if).toBe("always()");
    expect(mutation).toContain("for component in main candidate prs comments task-refs task-prs");
  });

  it("does not warn about cleanup when the trusted-write step never ran", () => {
    const cleanup = stepRun(workflow, "Close only the verified E2E PR and delete its branch");

    expect(workflowSteps(workflow).find((value) => value.run === cleanup)?.if).toBe(
      "${{ always() && steps.trusted.outcome != 'skipped' }}",
    );
    expect(cleanup).toContain("No broad cleanup was attempted.");
  });

  it("exercises v0.6 GitHub integration through deterministic exact-DSH runs", () => {
    const install = stepRun(workflow, "Install exact candidate runtime without lifecycle scripts");
    const integration = stepRun(workflow, "integration_contracts");

    expect(install).toContain(
      "npm ci --prefix candidate-action --omit=dev --ignore-scripts --no-audit --no-fund",
    );
    expect(install).toContain(
      'test -f "$GITHUB_WORKSPACE/candidate-action/node_modules/@deepseek-ai/dsh/lib/bin.js"',
    );

    for (const contract of [
      "INPUT_LABEL-TRIGGER=dsh-e2e-label",
      "INPUT_ASSIGNEE-TRIGGER=dsh-e2e-assignee",
      "INPUT_ALLOWED-ACTORS=dsh-e2e-no-match",
      "INPUT_TRIGGER-PHRASE=/deepseek",
      "INPUT_EXCLUDE-COMMENTS-BY-ACTOR=$actor,github-actions[bot]",
      "github.issue.labels.set",
      "github.issue.assignees.set",
      "github.issue.state.update",
      "github.comment.create",
      "github.pull.metadata.update",
      'INPUT_ALLOWED-TOOLS=["github.checks.read"]',
      "INPUT_PROMPT=Update the bound draft PR metadata exactly as requested.",
      '.validation.status == "passed"',
      '.taskOutput == {route:"github",accepted:true}',
      "DSH_E2E_HISTORY_HIDDEN_",
      "DSH_E2E_TRIGGER_VISIBLE_",
      "[image removed]",
      "dsh-e2e-reference-must-not-forward",
      "dsh-e2e-source-must-not-forward",
      "dsh-e2e-html-must-not-forward",
      "dsh-e2e-raw-must-not-forward",
    ]) {
      expect(integration).toContain(contract);
    }
    expect(integration.match(/'INPUT_ISOLATION=none'/gu)).toHaveLength(3);
    expect(
      integration.match(
        /INPUT_DSH-EXECUTABLE=\$GITHUB_WORKSPACE\/candidate-action\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/gu,
      ),
    ).toHaveLength(3);
    expect(integration).not.toContain("secrets.DEEPSEEK_API_KEY");
  });

  it("creates a minimal base with an immutable validator and a one-file checks diff", () => {
    const creation = stepRun(workflow, "integration_entities");

    for (const contract of [
      ".github/dsh-e2e-fixtures/checks-",
      "dsh-e2e/checks-base-",
      '{tree:[{path:$path,mode:"100644",type:"blob",sha:$sha},',
      '{path:".github/dsh-e2e-fixtures/validate-business-file.mjs",mode:"100644",type:"blob",sha:$validator}]}',
      "--rawfile content .github/e2e/validate-business-file.mjs",
      '[[ "$validator_blob_sha" == "$(git hash-object .github/e2e/validate-business-file.mjs)" ]]',
      "base_tree:$base",
      "parents:[$parent]",
      'echo "base_tree_sha=$base_tree_sha"',
      'echo "base_sha=$base_sha"',
      'echo "tree_sha=$tree_sha"',
      'echo "head_sha=$head_sha"',
      '-f base="$base_branch"',
      '--arg sha "$head_sha"',
    ]) {
      expect(creation).toContain(contract);
    }
    expect(creation).toContain('--arg parent "$CANDIDATE_SHA"');
    expect(creation).toContain('--arg parent "$base_sha"');
    expect(creation).not.toContain('-f sha="$CANDIDATE_SHA" >/dev/null');
    expect(creation).toContain(
      'node .github/e2e/fixture-ref.mjs create "$base_branch" "$base_sha"',
    );
    expect(creation).toContain('node .github/e2e/fixture-ref.mjs create "$branch" "$head_sha"');
    expect(creation).not.toContain('gh api --method POST "repos/$REPOSITORY/git/refs"');
  });

  it("asserts generic receipts and verifies typed payload effects through remote state", () => {
    const integration = stepRun(workflow, "integration_contracts");

    expect(integration).toContain('.id == "github.issue.labels.set"');
    expect(integration).toContain('.id == "github.issue.assignees.set"');
    expect(integration).toContain('.id == "github.issue.state.update"');
    expect(integration).toContain('.id == "github.pull.metadata.update"');
    expect(integration).toContain('.id == "github.checks.read"');
    expect(integration).toContain("[.labels[].name] == [$label]");
    expect(integration).toContain("[.assignees[].login] == [$actor]");
    expect(integration).toContain('.state_reason == "completed"');
    expect(integration).toContain('--jq .head.sha)" == "$CHECKS_HEAD"');
    for (const forbiddenReceiptPayload of [
      ".labels == [$label]",
      ".assignees == [$actor]",
      ".title == $title",
      ".headSha == $head",
    ]) {
      expect(integration).not.toContain(forbiddenReceiptPayload);
    }
  });

  it("qualifies PR review, failed-CI fix, and Issue implementation through recorded effects", () => {
    const integration = stepRun(workflow, "integration_contracts");
    for (const contract of [
      "run_candidate review",
      "run_candidate fix",
      "run_candidate implement",
      ".publication.inlinePublished == 1",
      "repos/$REPOSITORY/check-runs",
      "DSH_E2E_CI_FAILURE_",
      "INPUT_RUN-TESTS=true",
      "INPUT_VALIDATION-INTEGRITY=strict",
      'select(.id == "native.bash" and .completed and .ok)',
      "node .github/e2e/assert-business-effects.mjs fix",
      "node .github/e2e/assert-business-effects.mjs implement",
      'echo "implementation_branch=$implementation_branch"',
      'echo "implementation_pull_ids=',
      '["bash-issued","bash-observed"]',
    ])
      expect(integration).toContain(contract);
    expect(integration.indexOf('echo "implementation_branch=')).toBeLessThan(
      integration.indexOf("run_candidate implement"),
    );
    expect(integration.indexOf('echo "implementation_pull_ids=')).toBeLessThan(
      integration.indexOf('[[ "$implement_ok" == "true" ]]'),
    );
    const cleanup = stepRun(workflow, "Remove only verified integration fixtures");
    expect(cleanup).toContain("assert-business-effects.mjs cleanup-implement");
    expect(cleanup).toContain("assert-business-effects.mjs fix-cleanup");
    expect(cleanup).toContain("cleanup_failure_check");
    expect(cleanup).toContain("-f conclusion=neutral");
    expect(cleanup).toContain("original_commit_id == $head");
    const evidence = stepRun(workflow, "Capture bounded business execution evidence");
    expect(workflowSteps(workflow).find((value) => value.run === evidence)?.if).toBe("always()");
    expect(evidence).toContain("{route,index,kind,phase,authorizationMatches}");
    expect(evidence).not.toContain(".prompt");
  });

  it.each(["fix", "implement"])(
    "explicitly grants workspace editing before the %s fixture requests a Bash write",
    (operation) => {
      const integration = stepRun(workflow, "integration_contracts");
      const invocation = integration
        .split(`run_candidate ${operation} `)[1]
        ?.split(`|| ${operation}_ok=false`)[0];

      expect(invocation).toContain("'INPUT_PERMISSION-PROFILE=custom'");
      expect(invocation).toContain('INPUT_ALLOWED-TOOLS=["workspace.edit","native.bash"]');
      expect(invocation).toContain("'INPUT_ALLOW-WRITE=true'");
      expect(invocation).toContain("'INPUT_ISOLATION=docker'");
      expect(invocation).toContain("'INPUT_RUN-TESTS=true'");
      expect(invocation).toContain("'INPUT_VALIDATION-INTEGRITY=strict'");
    },
  );

  it("cleans partial integration fixtures independently and aggregates failures", () => {
    const cleanup = stepRun(workflow, "Remove only verified integration fixtures");

    expect(workflowSteps(workflow).find((value) => value.run === cleanup)?.if).toBe("always()");
    expect(cleanup).toContain("set +e");
    expect(cleanup).toContain("dsh-e2e:github-integration:v1");
    expect(cleanup).toContain("^dsh-e2e/checks-");
    expect(cleanup).toContain("cleanup_issue() (");
    expect(cleanup).toContain("cleanup_label() (");
    expect(cleanup).toContain("cleanup_pull() (");
    expect(cleanup).toContain("cleanup_branch() (");
    expect(cleanup).toContain("cleanup_base_branch() (");
    expect(cleanup).toContain("cleanup_failures=$((cleanup_failures + 1))");
    expect(cleanup).toContain('[[ "$cleanup_failures" -eq 0 ]]');
    expect(cleanup).toContain(".parents[0].sha");
    expect(cleanup).toContain(".tree.sha");
    expect(cleanup).toContain(".files | length == 1");
    expect(cleanup).toContain('path == ".github/dsh-e2e-fixtures"');
    expect(cleanup).toContain(".tree | length == 4");
    expect(cleanup).toContain(
      'validator_blob_sha="$(git hash-object .github/e2e/validate-business-file.mjs)"',
    );
    expect(cleanup).toContain(
      'select(.path == ".github/dsh-e2e-fixtures/validate-business-file.mjs" and .mode == "100644" and .type == "blob" and .sha == $validator)',
    );
    expect(cleanup).toContain("git/blobs/$blob_sha");
    expect(cleanup).toContain(
      'node .github/e2e/fixture-ref.mjs delete "$CHECKS_BRANCH" "$ref_sha"',
    );
    expect(cleanup).toContain(
      'node .github/e2e/fixture-ref.mjs delete "$CHECKS_BASE_BRANCH" "$ref_sha"',
    );
    expect(cleanup.match(/\.status == "404" or \.status == 404/gu)).toHaveLength(2);
    expect(cleanup).toContain("Fixture ref preflight could not confirm absence.");
    expect(cleanup).not.toMatch(/ref_sha=.*\|\| return 0/u);
    expect(cleanup).not.toContain("matching-refs");
  });
});
