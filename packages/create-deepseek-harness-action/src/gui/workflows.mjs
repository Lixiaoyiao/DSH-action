import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { GUI_INPUTS } from "./contract.generated.mjs";
import { unwrapReviewGuard } from "./plugins.mjs";

const ACTION = "Lixiaoyiao/deepseek-harness-action@";
const CREDENTIAL_NAME =
  /(?:^|_)(?:secret|password|passwd|token|authorization|(?:api|access|secret|private)_?key)$/u;
const credentialInputs = new Set(["deepseek-api-key", "github-token"]);
const knownInputs = new Set(GUI_INPUTS.map(({ name }) => name));
const ACTOR_GUARD_MARKER = "dsh-allowed-actors:v1";
// https://github.com/actions/languageservices/blob/main/expressions/src/errors.ts
const MAX_JOB_EXPRESSION_LENGTH = 21000;

/** Compile literal routing semantics; checkConfiguration owns input validation. */
function jobActorGate(steps) {
  const gates = [];
  for (const step of steps) {
    const raw = step.inputs["allowed-actors"]?.trim() || "*";
    if (!step.editable || raw.includes("${{")) return;
    const patterns = raw
      .split(",")
      .map((entry) => entry.trim().replace(/^@/u, ""))
      .filter(Boolean);
    if (patterns.includes("*")) return "true";
    const names = [
      ...new Set(
        patterns
          .filter((entry) => entry !== "*[bot]")
          .flatMap((entry) => {
            const name = entry.toLowerCase().replace(/\[bot\]$/u, "");
            return [name, `${name}[bot]`];
          }),
      ),
    ];
    const match = (actor) => {
      const terms = names.length
        ? [`contains(fromJSON('${JSON.stringify(names).replaceAll("'", "''")}'), ${actor})`]
        : [];
      if (patterns.includes("*[bot]")) terms.push(`endsWith(${actor}, '[bot]')`);
      return terms.join(" || ") || "false";
    };
    const upstream = ["actor", "triggering_actor"].map((name) => {
      const actor = `github.event.workflow_run.${name}.login`;
      return `(!${actor} || (${match(actor)}))`;
    });
    gates.push(
      `(${match("github.actor")}) && (github.event_name != 'workflow_run' || (${upstream.join(" && ")}))`,
    );
  }
  return [...new Set(gates)].map((gate) => `(${gate})`).join(" || ") || "false";
}

function managedActorCondition(node, gate) {
  if (!isScalar(node) || !node.comment?.split("\n").includes(ACTOR_GUARD_MARKER)) return;
  const value = String(node.value).trim();
  if (value === `\${{ ${gate} }}`) return { custom: undefined };
  const suffix = `) && (${gate}) }}`;
  if (gate !== undefined && value.startsWith("${{ (") && value.endsWith(suffix))
    return { custom: value.slice("${{ (".length, -suffix.length) };
}

function updateJobActorGate(doc, jobId, previousSteps, nextSteps) {
  const job = doc.getIn(["jobs", jobId], true);
  const node = job.get("if", true);
  if (node !== undefined && !isScalar(node)) return;
  const owned = node?.comment?.split("\n").includes(ACTOR_GUARD_MARKER);
  const previous = owned ? managedActorCondition(node, jobActorGate(previousSteps)) : undefined;
  // A manually changed generated condition stays opaque; never replace it by guessing.
  if (owned && previous === undefined) return;
  const custom = owned ? previous.custom : node === undefined ? undefined : String(node.value);
  const gate = jobActorGate(nextSteps);
  if (gate === undefined || gate === "true") {
    if (!owned) return;
    if (custom === undefined) job.delete("if");
    else {
      node.value = custom;
      node.comment =
        node.comment
          .split("\n")
          .filter((line) => line !== ACTOR_GUARD_MARKER)
          .join("\n") || undefined;
    }
    return;
  }
  const expression = custom
    ?.trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .trim();
  const condition = expression === undefined ? gate : `(${expression}) && (${gate})`;
  if (condition.length > MAX_JOB_EXPRESSION_LENGTH)
    throw new Error(
      "The generated job condition exceeds GitHub's 21000-character expression limit. Use a shorter allowed-actors list or configure the job condition in the YAML editor.",
    );
  const value = `\${{ ${condition} }}`;
  const updated = node ?? doc.createNode(value);
  updated.value = value;
  updated.comment = [
    ...(node?.comment?.split("\n").filter((line) => line !== ACTOR_GUARD_MARKER) ?? []),
    ACTOR_GUARD_MARKER,
  ].join("\n");
  job.set("if", updated);
}

function documentFor(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 256 * 1024)
    throw new Error("Workflow YAML must be no larger than 256 KiB.");
  const doc = parseDocument(source, { strict: true, uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error(
      "Workflow YAML is invalid or contains duplicate keys. Existing files were not changed.",
    );
  return doc;
}

function containsLiteralCredential(value, path = []) {
  if (typeof value === "string") {
    const key = (path.at(-1) ?? "")
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replaceAll("-", "_")
      .toLowerCase();
    const permissionScope =
      (path.length === 2 && path[0] === "permissions") ||
      (path.length === 4 && path[0] === "jobs" && path[2] === "permissions");
    if (!permissionScope && CREDENTIAL_NAME.test(key) && value !== "") {
      const authorizationHeader =
        path.at(-2)?.toLowerCase() === "headers" &&
        (key === "authorization" || key === "proxy_authorization");
      const reference = authorizationHeader
        ? value.trim().replace(/^Bearer\s+/iu, "")
        : value.trim();
      // Keep one complete runner expression opaque, including bracket references.
      // Literal prefixes and text between separate expressions are still exposed values.
      if (!/^\$\{\{(?:(?!\$\{\{|\}\})[\s\S])+\}\}$/u.test(reference)) return true;
    }
    if (value.trim().startsWith("{")) {
      try {
        return containsLiteralCredential(JSON.parse(value), path);
      } catch {
        return false;
      }
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsLiteralCredential(item, path));
  if (value && typeof value === "object")
    return Object.entries(value).some(([name, entry]) =>
      containsLiteralCredential(entry, [...path, name]),
    );
  return false;
}

function actionSteps(doc) {
  const jobs = doc.get("jobs", true);
  const result = [];
  if (!isMap(jobs)) return result;
  for (const pair of jobs.items) {
    const jobId = String(pair.key?.value ?? "");
    if (!isMap(pair.value)) continue;
    const steps = pair.value.get("steps", true);
    if (!isSeq(steps)) continue;
    for (const [index, step] of steps.items.entries()) {
      if (!isMap(step)) continue;
      const uses = step.get("uses");
      if (typeof uses !== "string" || !uses.startsWith(ACTION)) continue;
      const inputsNode = step.get("with", true);
      const inputs = Object.create(null);
      let reason;
      if (inputsNode !== undefined && !isMap(inputsNode))
        reason = "Aliased or non-mapping Action inputs cannot be safely edited.";
      if (isMap(inputsNode)) {
        for (const input of inputsNode.items) {
          const name = String(input.key?.value ?? "");
          if (name === "<<" || isAlias(input.value) || !isScalar(input.value)) {
            reason =
              "Merged, aliased or structured Action inputs require manual resolution in the YAML editor.";
            continue;
          }
          inputs[name] = String(input.value.value ?? "");
        }
      }
      result.push({
        id: `${jobId}:${index}`,
        jobId,
        index,
        uses,
        inputs,
        editable: reason === undefined,
        ...(reason ? { reason } : {}),
        node: step,
      });
    }
  }
  return result;
}

export function inspectWorkflow(source) {
  try {
    const doc = documentFor(source);
    if (containsLiteralCredential(doc.toJS({ maxAliasCount: 100 })))
      return {
        editable: false,
        sensitive: true,
        reason:
          "Literal credentials were found. This file is hidden and will not be overwritten. Replace credentials with GitHub Secret references before reopening it.",
        steps: [],
      };
    const steps = actionSteps(doc).map(({ id, jobId, index, uses, inputs, editable, reason }) => ({
      id,
      jobId,
      index,
      uses,
      inputs,
      editable,
      ...(reason ? { reason } : {}),
    }));
    return {
      editable: steps.length > 0,
      ...(steps.length ? {} : { reason: "No DeepSeek Harness Action step in this workflow." }),
      steps,
    };
  } catch (error) {
    return { editable: false, reason: error.message, steps: [] };
  }
}

export function editWorkflow({ source, stepId, inputs, upgradeAction = false }, releaseSha) {
  const inspected = inspectWorkflow(source);
  if (!inspected.editable || inspected.sensitive) throw new Error(inspected.reason);
  const doc = documentFor(source);
  const previousSteps = actionSteps(doc);
  const selected = previousSteps.find(({ id }) => id === stepId);
  if (!selected?.editable)
    throw new Error(selected?.reason ?? "The selected Action step no longer exists.");
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
    throw new Error("Action inputs must be a name-to-string mapping.");
  for (const [name, value] of Object.entries(inputs)) {
    if (!knownInputs.has(name)) throw new Error(`Unknown Action input: ${name}`);
    if (typeof value !== "string") throw new Error(`Input ${name} must be text.`);
  }
  let withNode = selected.node.get("with", true);
  if (!withNode) {
    selected.node.set("with", doc.createNode({}));
    withNode = selected.node.get("with", true);
  }
  for (const pair of [...withNode.items]) {
    const name = String(pair.key.value);
    if (!Object.hasOwn(inputs, name)) withNode.delete(name);
  }
  for (const [name, value] of Object.entries(inputs)) {
    if (selected.inputs[name] !== value) withNode.set(name, value);
  }
  if (upgradeAction) selected.node.set("uses", `${ACTION}${releaseSha}`);
  updateJobActorGate(
    doc,
    selected.jobId,
    previousSteps.filter((step) => step.jobId === selected.jobId),
    previousSteps
      .filter((step) => step.jobId === selected.jobId)
      .map((step) => (step.id === selected.id ? { ...step, inputs } : step)),
  );
  const next = doc.toString({ lineWidth: 0 });
  const checked = inspectWorkflow(next);
  if (checked.sensitive) throw new Error(checked.reason);
  return { source: next, ...checked };
}

export async function presetWorkflow(templateDirectory, kind, dshMode) {
  if (!["review", "commands", "session", "automation"].includes(kind))
    throw new Error("Unknown workflow preset.");
  if (!["controlled", "native"].includes(dshMode)) throw new Error("Choose Controlled or Native.");
  const templateKind = kind === "automation" ? "review" : kind;
  const file = `dsh-${templateKind}${dshMode === "native" ? "-native" : ""}.yml`;
  let source = await readFile(join(templateDirectory, file), "utf8");
  const doc = documentFor(source);
  const steps = actionSteps(doc);
  if (steps.length !== 1 || !new RegExp(`^${ACTION}[a-f0-9]{40}$`, "u").test(steps[0].uses))
    throw new Error("Installer template is not bound to an immutable Action release.");
  if (kind === "automation") {
    doc.set("name", "DSH automation");
    doc.set(
      "on",
      doc.createNode({
        workflow_dispatch: {
          inputs: {
            prompt: {
              description: "Task instructions",
              required: true,
              type: "string",
              default: "Summarize this repository.",
            },
          },
        },
      }),
    );
    doc.set("permissions", doc.createNode({ contents: "read" }));
    doc.delete("concurrency");
    const job = doc.getIn(["jobs", "review"], true);
    job.delete("if");
    const checkout = job.get("steps", true).items[0];
    checkout.setIn(["with", "ref"], "${{ github.sha }}");
    const step = steps[0].node;
    step.setIn(["with", "command"], "task");
    step.setIn(["with", "prompt"], "${{ inputs.prompt }}");
    step.setIn(["with", "progress-comment"], "false");
    doc.setIn(["jobs", "automation"], job);
    doc.deleteIn(["jobs", "review"]);
    source = doc.toString({ lineWidth: 0 });
  }
  return {
    path: `.github/workflows/dsh-${kind}.yml`,
    hash: null,
    source,
    ...inspectWorkflow(source),
  };
}

function expressionPlaceholder(name, value) {
  if (!value.includes("${{")) return value;
  if (name === "plugin-config" || name === "allowed-tools") {
    const unwrapped = unwrapReviewGuard(
      value,
      name === "plugin-config" ? '{"schemaVersion":1}' : "[]",
    );
    if (unwrapped !== value) return unwrapped;
  }
  if (
    name === "allow-plugin-install" &&
    value === "${{ github.event.pull_request.head.repo.full_name == github.repository }}"
  )
    return "true";
  const placeholders = {
    "deepseek-api-key": "gui-static-key",
    "github-token": "gui-static-token",
    prompt: "GUI preview",
    "session-key": "gui-preview",
    "session-source-run-id": "1",
    "base-branch": "main",
    "test-commands": '[["node","--version"]]',
  };
  return placeholders[name] ?? GUI_INPUTS.find((input) => input.name === name)?.default ?? "";
}

/** Use the Action's real static validator. Expressions remain runner-time checks. */
export function validateWorkflow(source, checkConfiguration, sessionValidators) {
  const inspected = inspectWorkflow(source);
  const diagnostics = [],
    risks = [];
  if (!inspected.editable || inspected.sensitive)
    return { ok: false, diagnostics: [{ status: "failed", message: inspected.reason }], risks };
  const doc = documentFor(source);
  for (const step of inspected.steps) {
    if (!step.editable) {
      diagnostics.push({ status: "failed", message: `${step.id}: ${step.reason}` });
      continue;
    }
    const dynamic = Object.entries(step.inputs).filter(
      ([name, value]) => !credentialInputs.has(name) && value.includes("${{"),
    );
    const jobIf = doc.getIn(["jobs", step.jobId, "if"], true);
    if (
      isScalar(jobIf) &&
      jobIf.comment?.split("\n").includes(ACTOR_GUARD_MARKER) &&
      !managedActorCondition(
        jobIf,
        jobActorGate(inspected.steps.filter((other) => other.jobId === step.jobId)),
      )
    )
      diagnostics.push({
        status: "not_checked",
        message: `${step.id}: The generated actor condition was manually changed and was preserved; review the job condition in the YAML editor.`,
      });
    const inputs = Object.fromEntries(
      Object.entries(step.inputs).map(([name, value]) => [
        name,
        expressionPlaceholder(name, value),
      ]),
    );
    const sessionMode = step.inputs["session-mode"] ?? "off";
    const dynamicSessionMode = sessionMode.includes("${{");
    if (dynamicSessionMode) {
      // The mode decides which key/source combinations are valid. Check other
      // input schemas without inventing a Session mode for this expression.
      inputs["session-mode"] = "off";
      delete inputs["session-key"];
      delete inputs["session-source-run-id"];
    }
    if (!Object.hasOwn(inputs, "github-token")) inputs["github-token"] = "gui-static-token";
    const result = checkConfiguration({ schemaVersion: 1, inputs }, {});
    diagnostics.push(
      ...result.diagnostics.map(({ status, message }) => ({
        status,
        message: `${step.id}: ${message}`,
      })),
    );
    if (dynamicSessionMode) {
      diagnostics.push({
        status: "not_checked",
        message: `${step.id}: Session workflow structure and mode/key/source combinations cannot be checked for a dynamic session-mode; the Action validates the resolved mode on the runner.`,
      });
    } else if (["auto", "save", "resume"].includes(sessionMode)) {
      try {
        if (!sessionValidators?.assertSessionWorkflowPolicy || !sessionValidators.sessionKeyHash)
          throw new Error("Session workflow validation is unavailable; rebuild the installer.");
        const keyHash =
          sessionMode === "auto"
            ? sessionValidators.sessionKeyHash((inputs["session-key"] ?? "").toLowerCase())
            : undefined;
        const policy = sessionValidators.assertSessionWorkflowPolicy(source, step.jobId, keyHash);
        diagnostics.push({
          status: "passed",
          message: `${step.id}: Session workflow structure, producer and concurrency bindings are valid.`,
        });
        if (policy.singlePendingSlot)
          diagnostics.push({
            status: "warning",
            message: `${step.id}: Session concurrency has a single pending slot; queue: max preserves multiple pending follow-ups.`,
          });
      } catch (error) {
        diagnostics.push({ status: "failed", message: `${step.id}: ${error.message}` });
      }
    }
    if (dynamic.length)
      diagnostics.push({
        status: "not_checked",
        message: `${step.id}: GitHub expressions (${dynamic.map(([name]) => name).join(", ")}) use representative values for static checks; actual values are validated by the Action on the runner.${dynamic.some(([name]) => name === "allowed-actors") ? " Configure the pre-runner actor condition in the YAML editor; a dynamic allowed-actors list cannot be compiled statically." : ""}`,
      });
    if (!new RegExp(`^${ACTION}[a-f0-9]{40}$`, "u").test(step.uses))
      diagnostics.push({
        status: "warning",
        message: `${step.id}: Action reference is not an immutable commit. Select “update to this installer release” to pin it.`,
      });
    if (step.inputs["allow-write"] && step.inputs["allow-write"] !== "false") {
      risks.push(
        `${step.id}: Code writes enabled. Trusted actors, write permissions, Docker and passing project validation are required.`,
      );
      if (doc.hasIn(["on", "pull_request_target"]))
        diagnostics.push({
          status: "warning",
          message: `${step.id}: pull_request_target routes cannot write code. Use a Commands workflow for write requests.`,
        });
      if (
        result.diagnostics.some(
          ({ id, status }) => id === "conditional_write" && status === "warning",
        )
      )
        diagnostics.push({
          status: "failed",
          message: `${step.id}: Configure real test-commands and a pinned container before enabling code writes.`,
        });
    }
    if (step.inputs["dsh-mode"] === "native")
      risks.push(`${step.id}: Native uses the official DSH tool inventory and requires Docker.`);
    if (step.inputs["isolation"] === "none")
      risks.push(
        `${step.id}: Host execution has no Docker boundary; eligible operations are restricted by the Action.`,
      );
    if (step.inputs["session-mode"] && step.inputs["session-mode"] !== "off")
      risks.push(
        `${step.id}: Session requires a trusted default-branch workflow, matching concurrency/key and Actions artifact access.`,
      );
    if (step.inputs["plugin-config"] || step.inputs["mcp-config"])
      risks.push(
        `${step.id}: Extensions run on the GitHub runner. Review exact packages, tools, network access and Secret references.`,
      );
  }
  const permissionText = JSON.stringify(
    doc.get("permissions")?.toJSON?.() ?? doc.get("permissions") ?? {},
  );
  if (permissionText.includes("write"))
    risks.push(`Workflow permissions include write scopes: ${permissionText}`);
  return {
    ok: !diagnostics.some(({ status }) => status === "failed"),
    diagnostics,
    risks: [...new Set(risks)],
  };
}

/** Event subscriptions can overlap even when their custom conditions differ. */
export function overlappingWorkflowWarnings(files) {
  const subscriptions = new Map();
  for (const { path, source } of files) {
    if (typeof source !== "string" || !inspectWorkflow(source).editable) continue;
    const on = documentFor(source).get("on", true);
    const events = isMap(on)
      ? on.items.map(({ key }) => key?.value)
      : isSeq(on)
        ? on.items.map((event) => event?.value)
        : isScalar(on)
          ? [on.value]
          : [];
    for (const event of ["issue_comment", "pull_request_review", "pull_request_review_comment"]) {
      if (!events.includes(event)) continue;
      const paths = subscriptions.get(event) ?? new Set();
      paths.add(path);
      subscriptions.set(event, paths);
    }
  }
  return [...subscriptions]
    .filter(([, paths]) => paths.size > 1)
    .map(([event, paths]) => ({
      status: "warning",
      message: `Multiple DSH workflows subscribe to ${event}: ${[...paths].join(", ")}. One interaction may start multiple runs; review their job and step conditions.`,
    }));
}
