import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { isScalar, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { checkConfiguration } from "../src/configuration-check.js";
import { assertSessionWorkflowPolicy } from "../src/session/workflow-policy.js";
import { sessionKeyHash } from "../src/session/contracts.js";
import {
  readWorkflow,
  saveWorkflowChanges,
  workflowHash,
  workflowPath,
} from "../packages/create-deepseek-harness-action/src/gui/files.mjs";
import {
  editWorkflow,
  inspectWorkflow,
  presetWorkflow,
  validateWorkflow,
} from "../packages/create-deepseek-harness-action/src/gui/workflows.mjs";
import {
  guiLocalPlugins,
  guiPluginInputs,
  unwrapReviewGuard,
} from "../packages/create-deepseek-harness-action/src/gui/plugins.mjs";
import {
  startGuiServer,
  type GuiSession,
} from "../packages/create-deepseek-harness-action/src/gui/server.mjs";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const action = `Lixiaoyiao/deepseek-harness-action@${releaseSha}`;
const workflowName = ".github/workflows/dsh-review.yml";
let suiteRoot: string;
let templates: string;
let assets: string;
const sessions: GuiSession[] = [];
const externalFixtures: string[] = [];
const sessionValidators = { assertSessionWorkflowPolicy, sessionKeyHash };

beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), "dsh-installer-gui-"));
  templates = join(suiteRoot, "templates");
  assets = join(suiteRoot, "ui");
  await mkdir(templates);
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Local GUI fixture</title>");
  const sourceTemplates = join(
    process.cwd(),
    "packages/create-deepseek-harness-action/src/templates",
  );
  for (const file of await readdir(sourceTemplates)) {
    if (!file.endsWith(".yml")) continue;
    const source = (await readFile(join(sourceTemplates, file), "utf8"))
      .replaceAll("__DSH_ACTION_RELEASE_SHA__", releaseSha)
      .replaceAll("# __DSH_MODE_INPUT__", 'dsh-mode: "controlled"');
    await writeFile(join(templates, file), source);
    if (!file.endsWith("-native.yml"))
      await writeFile(
        join(templates, file.replace(".yml", "-native.yml")),
        source.replace('dsh-mode: "controlled"', 'dsh-mode: "native"'),
      );
  }
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
  await Promise.all(externalFixtures.map((path) => rm(path, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(join(suiteRoot, "project-"));
  await mkdir(join(root, ".git"));
  return root;
}
async function start(root: string) {
  const session = await startGuiServer({
    cwd: root,
    templateDirectory: templates,
    uiDirectory: assets,
    checkConfiguration,
    ...sessionValidators,
    env: {},
  });
  sessions.push(session);
  return session;
}
async function api(
  session: GuiSession,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${session.origin}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      Origin: session.origin,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  return { response, body: z.record(z.string(), z.unknown()).parse(value) };
}
async function preview(session: GuiSession, source: string, expectedHash: string | null = null) {
  return await api(session, "preview", { changes: [{ path: workflowName, source, expectedHash }] });
}
async function writeWorkflow(root: string, source: string, name = workflowName) {
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, name), source);
}
function simpleWorkflow(extra = "") {
  return `name: Test\non: workflow_dispatch\njobs:\n  task:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${action}\n        with:\n          deepseek-api-key: \${{ secrets.DEEPSEEK_API_KEY }}\n          command: task\n          prompt: Explain this repository\n${extra}`;
}

function editActors(source: string, actors: string, index = 0) {
  const selected = inspectWorkflow(source).steps[index];
  if (!selected) throw new Error("Missing Action step");
  return editWorkflow(
    { source, stepId: selected.id, inputs: { ...selected.inputs, "allowed-actors": actors } },
    releaseSha,
  ).source;
}

it("compiles an actor job filter with exact normalized names and workflow_run identities", () => {
  const source = editActors(simpleWorkflow(), " @Alice, release[bot], Alice ");
  const condition = String(parseDocument(source).getIn(["jobs", "task", "if"]));
  const names = z
    .array(z.string())
    .parse(JSON.parse(/fromJSON\('([^']+)'\)/u.exec(condition)?.[1] ?? "null"));
  expect(names).toEqual(["alice", "alice[bot]", "release", "release[bot]"]);
  expect(names.includes("ali")).toBe(false);
  expect(names.includes("malice")).toBe(false);
  expect(condition).toContain("contains(fromJSON(");
  expect(condition).toContain(", github.actor)");
  for (const actor of ["actor", "triggering_actor"])
    expect(condition).toContain(`!github.event.workflow_run.${actor}.login || (`);
  expect(condition).not.toContain("github.triggering_actor");
  expect(source).toContain("dsh-allowed-actors:v1");
});

it("rejects an actor job filter that exceeds GitHub's expression limit for a valid list", () => {
  const actors = Array.from(
    { length: 100 },
    (_, index) => `actor${String(index).padStart(3, "0")}${"x".repeat(31)}`,
  ).join(",");
  const doc = parseDocument(simpleWorkflow());
  doc.setIn(["jobs", "task", "steps", 0, "with", "allowed-actors"], actors);
  const source = doc.toString();
  expect(Buffer.byteLength(actors)).toBe(3999);
  expect(validateWorkflow(source, checkConfiguration).ok).toBe(true);
  expect(() => editActors(source, actors)).toThrow("21000-character expression limit");
});

it.each([
  "github.ref == 'refs/heads/main' || always()",
  "${{ github.ref == 'refs/heads/main' || always() }}",
])("preserves %s while replacing an actor job filter on repeated edits", (custom) => {
  const doc = parseDocument(simpleWorkflow());
  doc.setIn(["jobs", "task", "if"], custom);
  const first = editActors(doc.toString(), "alice");
  const second = editActors(first, "bob");
  const condition = String(parseDocument(second).getIn(["jobs", "task", "if"]));
  expect(condition).toContain("(github.ref == 'refs/heads/main' || always()) && (");
  expect(condition).toContain('["bob","bob[bot]"]');
  expect(condition).not.toContain("alice");
  expect(second.match(/dsh-allowed-actors:v1/gu)).toHaveLength(1);
  expect(editActors(second, "bob")).toBe(second);
  expect(parseDocument(editActors(second, "*")).getIn(["jobs", "task", "if"])).toBe(
    "github.ref == 'refs/heads/main' || always()",
  );
});

it("keeps default wildcard, bot wildcard and empty actor job filter semantics", () => {
  for (const unrestricted of ["*", "", "   "])
    expect(
      parseDocument(editActors(simpleWorkflow(), unrestricted)).hasIn(["jobs", "task", "if"]),
    ).toBe(false);
  const bots = String(
    parseDocument(editActors(simpleWorkflow(), "*[bot]")).getIn(["jobs", "task", "if"]),
  );
  expect(bots).toContain("endsWith(github.actor, '[bot]')");
  expect(bots).not.toContain("fromJSON");
  const empty = editActors(simpleWorkflow(), ", ,");
  expect(String(parseDocument(empty).getIn(["jobs", "task", "if"]))).toContain("(false)");
  expect(parseDocument(editActors(empty, "*")).hasIn(["jobs", "task", "if"])).toBe(false);
});

it("removes a stale actor job filter for dynamic lists without guessing their values", () => {
  const doc = parseDocument(simpleWorkflow());
  doc.setIn(["jobs", "task", "if"], "github.ref == 'refs/heads/main'");
  const source = editActors(editActors(doc.toString(), "alice"), "${{ vars.DSH_ACTORS }}");
  expect(parseDocument(source).getIn(["jobs", "task", "if"])).toBe(
    "github.ref == 'refs/heads/main'",
  );
  expect(inspectWorkflow(source).steps[0]?.inputs["allowed-actors"]).toBe("${{ vars.DSH_ACTORS }}");
  expect(source).not.toContain("dsh-allowed-actors:v1");
  expect(
    validateWorkflow(source, checkConfiguration).diagnostics.some(
      ({ status, message }) =>
        status === "not_checked" &&
        message.includes("a dynamic allowed-actors list cannot be compiled statically"),
    ),
  ).toBe(true);
});

it("combines same-job actor job filters with OR and leaves other jobs unchanged", () => {
  const doc = parseDocument(simpleWorkflow());
  const steps: unknown = doc.getIn(["jobs", "task", "steps"], true);
  if (!isSeq(steps)) throw new Error("Missing steps");
  steps.add(doc.createNode({ uses: action, with: { "allowed-actors": "bob" } }));
  doc.setIn(
    ["jobs", "other"],
    doc.createNode({ "runs-on": "ubuntu-latest", if: "always()", steps: [{ run: "echo other" }] }),
  );
  const originalOther = String(doc.getIn(["jobs", "other"]));
  const source = editActors(doc.toString(), "alice");
  const updated = parseDocument(source);
  const condition = String(updated.getIn(["jobs", "task", "if"]));
  expect(condition).toContain('["alice","alice[bot]"]');
  expect(condition).toContain('["bob","bob[bot]"]');
  expect(condition).toContain(") || (");
  expect(String(updated.getIn(["jobs", "other"]))).toBe(originalOther);
  expect(
    parseDocument(editActors(source, "${{ vars.OTHER_ACTORS }}", 1)).hasIn(["jobs", "task", "if"]),
  ).toBe(false);
});

it("preserves a manually changed actor job filter instead of replacing its condition", () => {
  const doc = parseDocument(editActors(simpleWorkflow(), "alice"));
  const node: unknown = doc.getIn(["jobs", "task", "if"], true);
  if (!isScalar(node)) throw new Error("Missing condition");
  node.value = "${{ github.ref == 'refs/heads/manual' }}";
  const source = editActors(doc.toString(), "bob");
  expect(parseDocument(source).getIn(["jobs", "task", "if"])).toBe(node.value);
  expect(
    validateWorkflow(source, checkConfiguration).diagnostics.some(
      ({ status, message }) =>
        status === "not_checked" && message.includes("manually changed and was preserved"),
    ),
  ).toBe(true);
});

it.each(["directory", "worktree-file"])(
  "opens the repository root from a nested directory with a .git %s marker",
  async (marker) => {
    const root = await project();
    if (marker === "worktree-file") {
      await rm(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git"), "gitdir: /not-read-by-the-gui\n");
    }
    const nested = join(root, "packages", "example");
    await mkdir(nested, { recursive: true });
    const original = simpleWorkflow();
    await writeWorkflow(root, original);
    const session = await start(nested);
    const state = await api(session, "state");
    expect(state.body.repositoryRoot).toBe(await realpath(root));
    expect(state.body.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: workflowName, source: original })]),
    );
    const changed = original.replace("Explain this repository", "Explain the root repository");
    const planned = await preview(session, changed, workflowHash(original));
    expect(planned.body.ok).toBe(true);
    expect(
      (await api(session, "save", { previewId: planned.body.id, confirm: true })).response.status,
    ).toBe(200);
    expect(await readFile(join(root, workflowName), "utf8")).toBe(changed);
    await expect(readdir(join(nested, ".github"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("uses the selected directory when there is no Git ancestor", async () => {
  // Windows user homes can themselves be repositories. Public is outside that
  // tree, so this fixture exercises the absence of a Git marker.
  const base = process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir();
  const root = await mkdtemp(join(base, "dsh-gui-no-git-"));
  externalFixtures.push(root);
  const session = await start(root);
  expect((await api(session, "state")).body.repositoryRoot).toBe(await realpath(root));
  const planned = await preview(session, simpleWorkflow());
  expect(planned.body.ok).toBe(true);
  expect(
    (await api(session, "save", { previewId: planned.body.id, confirm: true })).body.saved,
  ).toEqual([workflowName]);
  expect(await readFile(join(root, workflowName), "utf8")).toBe(simpleWorkflow());
});

it("serves an authenticated loopback session without cross-origin access", async () => {
  const session = await start(await project());
  expect(session.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  expect(session.url).toBe(`${session.origin}/#token=${session.token}`);
  const anonymous = await fetch(`${session.origin}/api/state`);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.has("access-control-allow-origin")).toBe(false);
  const page = await fetch(session.origin);
  expect(page.status).toBe(200);
  expect(await page.text()).not.toContain(session.token);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await api(session, "state")).response.status).toBe(200);
  const changedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${session.origin}/api/state`,
      {
        headers: { Host: "attacker.example", Authorization: `Bearer ${session.token}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once("error", reject);
    request.end();
  });
  expect(changedHostStatus).toBe(403);
  expect(
    (await api(session, "state", undefined, { Origin: "https://attacker.example" })).response
      .status,
  ).toBe(403);
  expect(
    (await api(session, "state", undefined, { "Sec-Fetch-Site": "cross-site" })).response.status,
  ).toBe(403);
  const csrf = await fetch(`${session.origin}/api/preset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "review", dshMode: "controlled" }),
  });
  expect(csrf.status).toBe(403);
});

it("previews first installation without writes, requires confirmation, and reopens for updates", async () => {
  const root = await project();
  const session = await start(root);
  const preset = await presetWorkflow(templates, "review", "controlled");
  const validation = validateWorkflow(preset.source, checkConfiguration);
  expect(validation.ok, JSON.stringify(validation.diagnostics)).toBe(true);
  const first = await preview(session, preset.source);
  expect(first.body.ok).toBe(true);
  expect(await readdir(root)).toEqual([".git"]);
  expect((await api(session, "save", { previewId: first.body.id })).response.status).toBe(400);
  expect(
    (await api(session, "save", { previewId: first.body.id, confirm: true })).body.saved,
  ).toEqual([workflowName]);
  const stored = await readWorkflow(root, workflowName);
  expect(stored.source).toBe(preset.source);
  const reopened = await start(root);
  const state = await api(reopened, "state");
  expect(state.body.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: workflowName, hash: stored.hash, editable: true }),
    ]),
  );
  const selected = inspectWorkflow(stored.source).steps[0];
  if (!selected) throw new Error("Missing preset Action");
  const updated = editWorkflow(
    {
      source: stored.source,
      stepId: selected.id,
      inputs: { ...selected.inputs, "max-turns": "4" },
    },
    releaseSha,
  );
  const next = await preview(reopened, updated.source, stored.hash);
  expect(next.body.ok).toBe(true);
  expect(
    (await api(reopened, "save", { previewId: next.body.id, confirm: true })).response.status,
  ).toBe(200);
  expect((await readWorkflow(root, workflowName)).source).toBe(updated.source);
  expect(
    (await api(reopened, "save", { previewId: next.body.id, confirm: true })).response.status,
  ).toBe(400);
});

it("refuses a stale preview instead of overwriting a concurrent local edit", async () => {
  const root = await project();
  const session = await start(root);
  const original = simpleWorkflow();
  await writeWorkflow(root, original);
  const planned = await preview(
    session,
    original.replace("Explain this repository", "Explain changes"),
    workflowHash(original),
  );
  expect(planned.body.ok, JSON.stringify(planned.body)).toBe(true);
  const concurrent = `${original}# Concurrent user edit\n`;
  await writeWorkflow(root, concurrent);
  const saved = await api(session, "save", { previewId: planned.body.id, confirm: true });
  expect(saved.response.status).toBe(400);
  expect(saved.body.error).toMatch(/changed since preview/u);
  expect((await readWorkflow(root, workflowName)).source).toBe(concurrent);
});

it("rolls back earlier batch writes when a later file changes during save", async () => {
  const root = await project();
  const second = ".github/workflows/second.yml";
  await writeWorkflow(root, "first original");
  await writeWorkflow(root, "second original", second);
  await expect(
    saveWorkflowChanges(
      root,
      [
        {
          path: workflowName,
          source: "first replacement",
          expectedHash: workflowHash("first original"),
        },
        {
          path: second,
          source: "second replacement",
          expectedHash: workflowHash("second original"),
        },
      ],
      {
        beforeWrite: async (path) => {
          if (path === second) await writeFile(join(root, second), "concurrent second");
        },
      },
    ),
  ).rejects.toThrow(/changed since preview/u);
  expect((await readWorkflow(root, workflowName)).source).toBe("first original");
  expect((await readWorkflow(root, second)).source).toBe("concurrent second");
  expect(await readdir(join(root, ".github/workflows"))).toEqual(["dsh-review.yml", "second.yml"]);
});

it.each([
  "../outside.yml",
  ".github/workflows/../../outside.yml",
  ".github/workflows/nested/file.yml",
  "C:/outside.yml",
])("rejects a workflow path outside its editable directory: %s", async (path) => {
  await expect(workflowPath(await project(), path)).rejects.toThrow(/ordinary/u);
});

it("rejects symlinked workflow parents before reading or writing outside the repository", async () => {
  const root = await project();
  const outside = await project();
  await mkdir(join(root, ".github"));
  await symlink(
    outside,
    join(root, ".github/workflows"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(readWorkflow(root, workflowName)).rejects.toThrow(/Symbolic-link/u);
  await expect(
    saveWorkflowChanges(root, [
      { path: workflowName, source: "outside write", expectedHash: null },
    ]),
  ).rejects.toThrow(/Symbolic-link/u);
  expect(await readdir(outside)).toEqual([".git"]);
});

it.each([
  "synthetic-literal-key",
  "synthetic-literal-key${{ secrets.SUFFIX }}",
  "${{ secrets.PREFIX }}synthetic-literal-key${{ secrets.SUFFIX }}",
  "Bearer ${{ secrets.DEEPSEEK_API_KEY }}",
])("hides workflows containing a literal credential: %s", async (credential) => {
  const root = await project();
  const source = simpleWorkflow().replace("${{ secrets.DEEPSEEK_API_KEY }}", credential);
  await writeWorkflow(root, source);
  const session = await start(root);
  expect(inspectWorkflow(source)).toMatchObject({ editable: false, sensitive: true, steps: [] });
  const state = await api(session, "state");
  expect(JSON.stringify(state.body)).not.toContain("synthetic-literal-key");
  expect((await preview(session, simpleWorkflow(), workflowHash(source))).response.status).toBe(
    400,
  );
});

it("preserves token counts, permission scopes and unevaluated bracket references through GUI edits", async () => {
  const root = await project();
  const keyReference = "${{ secrets['DEEPSEEK_API_KEY'] }}";
  const authorization = "Bearer ${{ secrets['SERVICE_KEY'] }}";
  const doc = parseDocument(
    simpleWorkflow().replace("${{ secrets.DEEPSEEK_API_KEY }}", keyReference),
  );
  doc.set("permissions", doc.createNode({ contents: "read", "id-token": "write" }));
  doc.set("env", doc.createNode({ MAX_TOKENS: "4096", TOKEN_LIMIT: "8192" }));
  doc.setIn(
    ["jobs", "custom"],
    doc.createNode({
      "runs-on": "ubuntu-latest",
      permissions: { "id-token": "write" },
      env: {
        MAX_TOKENS: "1024",
        SERVICE_CONFIG: JSON.stringify({ headers: { Authorization: authorization } }),
      },
      steps: [{ run: "echo custom-job" }],
    }),
  );
  const source = doc.toString();
  await writeWorkflow(root, source);
  const inspection = inspectWorkflow(source);
  expect(inspection, JSON.stringify(inspection)).toMatchObject({ editable: true });
  expect(inspection.sensitive).not.toBe(true);
  const session = await start(root);
  const state = await api(session, "state");
  expect(state.body.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: workflowName, source, editable: true }),
    ]),
  );
  const selected = inspection.steps[0];
  if (!selected) throw new Error("Missing editable Action");
  expect(selected.inputs["deepseek-api-key"]).toBe(keyReference);
  const edited = await api(session, "edit", {
    source,
    stepId: selected.id,
    inputs: { ...selected.inputs, prompt: "Updated instructions" },
  });
  expect(edited.response.status).toBe(200);
  const updated = z.string().parse(edited.body.source);
  expect(inspectWorkflow(updated).steps[0]?.inputs["deepseek-api-key"]).toBe(keyReference);
  const values = z.object({
    env: z.record(z.string(), z.string()),
    permissions: z.record(z.string(), z.string()),
    jobs: z.object({ custom: z.unknown() }),
  });
  const before: unknown = doc.toJS();
  const after: unknown = parseDocument(updated).toJS();
  expect(values.parse(after)).toEqual(values.parse(before));
  const planned = await preview(session, updated, workflowHash(source));
  expect(planned.body.ok, JSON.stringify(planned.body.diagnostics)).toBe(true);
  expect((await readWorkflow(root, workflowName)).source).toBe(source);
});

it.each(["${{ secrets['DEEPSEEK_API_KEY'] }}", "${{ inputs.key || secrets['DEEPSEEK_API_KEY'] }}"])(
  "keeps whole GitHub credential expressions unevaluated: %s",
  (reference) => {
    const source = simpleWorkflow().replace("${{ secrets.DEEPSEEK_API_KEY }}", reference);
    expect(inspectWorkflow(source)).toMatchObject({ editable: true });
    expect(inspectWorkflow(source).steps[0]?.inputs["deepseek-api-key"]).toBe(reference);
  },
);

it.each([
  { env: { API_KEY: "synthetic-private-value" } },
  { env: { AUTH_TOKEN: "synthetic-private-value" } },
  { env: { PASSWORD: "synthetic-private-value" } },
  {
    env: {
      SERVICE_CONFIG: JSON.stringify({
        headers: { Authorization: "Bearer synthetic-private-value" },
      }),
    },
  },
  {
    env: {
      SERVICE_CONFIG: JSON.stringify({
        headers: { Authorization: "Bearer synthetic-private-value${{ secrets.SUFFIX }}" },
      }),
    },
  },
])("continues hiding literal credentials in credential-bearing fields: %j", (configuration) => {
  const doc = parseDocument(simpleWorkflow());
  doc.set("env", doc.createNode(configuration.env));
  expect(inspectWorkflow(doc.toString())).toMatchObject({
    editable: false,
    sensitive: true,
    steps: [],
  });
});

it("preserves unrelated YAML comments, jobs, anchors and other Action steps", () => {
  const source = `# Custom workflow comment\nname: Custom\non: workflow_dispatch\nenv: &shared\n  FEATURE: enabled # Keep this comment\njobs:\n  other:\n    runs-on: ubuntu-latest\n    env: *shared\n    steps:\n      - run: echo custom\n  first:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${action}\n        with:\n          deepseek-api-key: \${{ secrets.DEEPSEEK_API_KEY }}\n          prompt: Original one # First prompt\n      - uses: ${action}\n        with:\n          deepseek-api-key: \${{ secrets.OTHER_KEY }}\n          prompt: Original two\n`;
  const inspected = inspectWorkflow(source);
  expect(inspected.steps).toHaveLength(2);
  const step = inspected.steps[0];
  if (!step) throw new Error("Missing Action");
  const result = editWorkflow(
    { source, stepId: step.id, inputs: { ...step.inputs, prompt: "Changed one" } },
    releaseSha,
  );
  expect(result.source).toContain("# Custom workflow comment");
  expect(result.source).toContain("# Keep this comment");
  expect(result.source).toContain("&shared");
  expect(result.source).toContain("*shared");
  const before: unknown = parseDocument(source).getIn(["jobs", "other"]);
  const after: unknown = parseDocument(result.source).getIn(["jobs", "other"]);
  expect(after).toEqual(before);
  expect(result.steps[0]?.inputs.prompt).toBe("Changed one");
  expect(result.steps[1]?.inputs.prompt).toBe("Original two");
});

it("uses the full Action validator and refuses invalid previews", async () => {
  const session = await start(await project());
  const invalid = simpleWorkflow('          timeout-minutes: "invalid"\n');
  const result = await preview(session, invalid);
  expect(result.body.ok).toBe(false);
  expect(result.body.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
  );
  expect(
    (await api(session, "save", { previewId: result.body.id, confirm: true })).response.status,
  ).toBe(400);
  expect(
    validateWorkflow(
      simpleWorkflow('          allow-write: "true"\n          task-access: write\n'),
      checkConfiguration,
    ).ok,
  ).toBe(false);
  expect(
    validateWorkflow(simpleWorkflow("          invented-input: value\n"), checkConfiguration).ok,
  ).toBe(false);
  expect(
    validateWorkflow(simpleWorkflow('          github-token: ""\n'), checkConfiguration).ok,
  ).toBe(false);
});

it("discovers local plugin metadata without executing code or importing private settings", async () => {
  const home = await project();
  const profile = join(home, "profiles/default");
  const plugin = join(profile, "node_modules/example-bundle");
  await mkdir(plugin, { recursive: true });
  const sentinel = join(home, "executed");
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "example-bundle": "1.2.3" },
      dsh: { profile: { bundles: ["example-bundle"] } },
      token: "synthetic-local-private-setting",
    }),
  );
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "example-bundle",
      version: "1.2.3",
      main: "index.js",
      dsh: { bundle: { patch: "patch.json" } },
    }),
  );
  await writeFile(
    join(plugin, "index.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw new Error('must not execute');`,
  );
  await writeFile(
    join(plugin, "patch.json"),
    JSON.stringify({ token: "synthetic-patch-private-setting" }),
  );
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const found = await guiLocalPlugins({ dshMode: "controlled", home }, {});
  expect(found.plugins).toEqual([
    expect.objectContaining({ name: "example-bundle", version: "1.2.3" }),
  ]);
  expect(JSON.stringify(found)).not.toContain("private-setting");
  expect(await readdir(home)).not.toContain("executed");
  expect(network).not.toHaveBeenCalled();
});

it.each(["controlled", "native"])(
  "imports only explicit exact plugin selections without granting %s writes",
  (dshMode) => {
    const original = { "allow-write": "false", "task-access": "read" };
    const result = guiPluginInputs({
      dshMode,
      inputs: original,
      selections: [
        {
          id: "example",
          name: "example-bundle",
          version: "1.2.3",
          kind: "bundle",
          tools: ["plugin__example__read"],
        },
      ],
    });
    expect(original).toEqual({ "allow-write": "false", "task-access": "read" });
    expect(result.inputs).toMatchObject(original);
    const configuration: unknown = JSON.parse(result.inputs["plugin-config"] ?? "null");
    expect(configuration).toMatchObject({
      bundles: [
        {
          id: "example",
          package: "example-bundle",
          source: "1.2.3",
          network: false,
          ...(dshMode === "native"
            ? { workspaceWrite: false }
            : { tools: [{ permissions: ["read"] }] }),
        },
      ],
    });
    expect(() =>
      guiPluginInputs({
        dshMode,
        inputs: original,
        selections: [{ id: "example", name: "file:local", version: "latest", kind: "bundle" }],
      }),
    ).toThrow();
  },
);

it.each(["controlled", "native"])(
  "keeps Review plugins restricted to the same repository when appending a %s selection",
  async (dshMode) => {
    const preset = await presetWorkflow(templates, "review", dshMode);
    const selected = preset.steps[0];
    if (!selected) throw new Error("Missing Review Action");
    const sameRepository = "github.event.pull_request.head.repo.full_name == github.repository";
    const first = guiPluginInputs({
      dshMode,
      source: preset.source,
      inputs: selected.inputs,
      selections: [
        {
          id: "first",
          name: "first-bundle",
          version: "1.2.3",
          kind: "bundle",
          tools: ["plugin__first__read"],
        },
      ],
    });
    expect(first.inputs["plugin-config"]).toContain(`\${{ ${sameRepository} && '`);
    expect(first.inputs["plugin-config"]).toContain(`' || '{"schemaVersion":1}' }}`);
    expect(first.inputs["allow-plugin-install"]).toBe(`\${{ ${sameRepository} }}`);
    if (dshMode === "controlled") expect(first.inputs["allowed-tools"]).toContain(`' || '[]' }}`);
    const updated = editWorkflow(
      { source: preset.source, stepId: selected.id, inputs: first.inputs },
      releaseSha,
    );
    const firstValidation = validateWorkflow(updated.source, checkConfiguration);
    expect(firstValidation.ok, JSON.stringify(firstValidation.diagnostics)).toBe(true);
    const second = guiPluginInputs({
      dshMode,
      source: updated.source,
      inputs: first.inputs,
      selections: [
        {
          id: "second",
          name: "second-bundle",
          version: "2.0.0",
          kind: "bundle",
          tools: ["plugin__second__read"],
        },
      ],
    });
    const configuration: unknown = JSON.parse(
      unwrapReviewGuard(second.inputs["plugin-config"] ?? "", '{"schemaVersion":1}'),
    );
    expect(configuration).toMatchObject({
      bundles: [
        { id: "first", source: "1.2.3", network: false },
        { id: "second", source: "2.0.0", network: false },
      ],
    });
    expect(second.inputs["plugin-config"]).toContain(`\${{ ${sameRepository} && '`);
    expect(second.inputs["allow-write"]).toBe("false");
    if (dshMode === "controlled") {
      const tools: unknown = JSON.parse(
        unwrapReviewGuard(second.inputs["allowed-tools"] ?? "", "[]"),
      );
      expect(tools).toEqual(["plugin.first.read", "plugin.second.read"]);
    }
  },
);

it("leaves inputs and permissions unchanged when no plugins are selected", () => {
  const inputs = {
    "plugin-config": "${{ vars.CUSTOM_PLUGINS }}",
    "allowed-tools": "${{ vars.CUSTOM_TOOLS }}",
    "allow-plugin-install": "false",
    "allow-write": "false",
  };
  const result = guiPluginInputs({ dshMode: "controlled", inputs, selections: [] });
  expect(result.inputs).toEqual(inputs);
  expect(inputs["allow-plugin-install"]).toBe("false");
  expect(() =>
    guiPluginInputs({
      dshMode: "controlled",
      inputs,
      selections: [
        {
          id: "example",
          name: "example-bundle",
          version: "1.0.0",
          kind: "bundle",
          tools: ["plugin__example__read"],
        },
      ],
    }),
  ).toThrow(/Advanced/u);
});

it("validates controlled plugin definitions inside its generated Review guard", async () => {
  const preset = await presetWorkflow(templates, "review", "controlled");
  const selected = preset.steps[0];
  if (!selected) throw new Error("Missing Review Action");
  const configured = guiPluginInputs({
    dshMode: "controlled",
    source: preset.source,
    inputs: selected.inputs,
    selections: [
      {
        id: "example",
        name: "example-bundle",
        version: "1.0.0",
        kind: "bundle",
        tools: ["plugin__example__read"],
      },
    ],
  });
  const malformed = configured.inputs["plugin-config"]?.replace(
    '"permissions":["read"]',
    '"permissions":["execute"]',
  );
  if (!malformed || malformed === configured.inputs["plugin-config"])
    throw new Error("Missing controlled permission fixture");
  const edited = editWorkflow(
    {
      source: preset.source,
      stepId: selected.id,
      inputs: { ...configured.inputs, "plugin-config": malformed },
    },
    releaseSha,
  );
  const checked = validateWorkflow(edited.source, checkConfiguration);
  expect(checked.ok).toBe(false);
  expect(
    checked.diagnostics.some(
      ({ status, message }) => status === "failed" && /plugin/iu.test(message),
    ),
  ).toBe(true);
});

it.each(["auto", "save", "resume"])(
  "validates the %s Session workflow with the existing offline policy",
  async (mode) => {
    const preset = await presetWorkflow(templates, "session", "controlled");
    const doc = parseDocument(preset.source);
    const step = preset.steps[0];
    if (!step) throw new Error("Missing Session Action");
    doc.setIn(["jobs", step.jobId, "steps", step.index, "with", "session-mode"], mode);
    if (mode !== "auto") doc.setIn(["concurrency", "group"], "dsh-session");
    if (mode === "resume")
      doc.setIn(["jobs", step.jobId, "steps", step.index, "with", "session-source-run-id"], "123");
    const checked = validateWorkflow(doc.toString(), checkConfiguration, sessionValidators);
    expect(checked.ok, JSON.stringify(checked.diagnostics)).toBe(true);
    expect(
      checked.diagnostics.some(
        ({ status, message }) =>
          status === "passed" && message.includes("Session workflow structure"),
      ),
    ).toBe(true);
  },
);

it("refuses a Session preview with cancellation enabled or a mismatched literal key", async () => {
  const session = await start(await project());
  const preset = await presetWorkflow(templates, "session", "controlled");
  const doc = parseDocument(preset.source);
  doc.setIn(["concurrency", "cancel-in-progress"], true);
  const invalid = await preview(session, doc.toString());
  expect(invalid.body.ok).toBe(false);
  expect(
    (await api(session, "save", { previewId: invalid.body.id, confirm: true })).response.status,
  ).toBe(400);
  const literal = preset.source.replaceAll("${{ inputs.session_key }}", "maintained");
  expect(validateWorkflow(literal, checkConfiguration, sessionValidators).ok).toBe(true);
  const changed = literal.replace("session-key: maintained", "session-key: different");
  expect(changed).not.toBe(literal);
  const checked = validateWorkflow(changed, checkConfiguration, sessionValidators);
  expect(checked.ok).toBe(false);
  expect(
    checked.diagnostics.some(
      ({ status, message }) => status === "failed" && message.includes("Session"),
    ),
  ).toBe(true);
});

it("reports dynamic Session mode as not checked instead of passing its workflow policy", async () => {
  const preset = await presetWorkflow(templates, "session", "controlled");
  const dynamic = preset.source.replace("session-mode: auto", "session-mode: ${{ inputs.mode }}");
  const checked = validateWorkflow(dynamic, checkConfiguration, sessionValidators);
  expect(checked.ok, JSON.stringify(checked.diagnostics)).toBe(true);
  expect(
    checked.diagnostics.some(
      ({ status, message }) =>
        status === "not_checked" && message.includes("Session workflow structure"),
    ),
  ).toBe(true);
  expect(
    checked.diagnostics.some(
      ({ status, message }) =>
        status === "passed" && message.includes("Session workflow structure"),
    ),
  ).toBe(false);
});

it("warns when loaded and proposed workflows share an interactive event without changing YAML", async () => {
  const root = await project();
  const existing = simpleWorkflow().replace("on: workflow_dispatch", "on: issue_comment");
  await writeWorkflow(root, existing);
  const session = await start(root);
  const proposedPath = ".github/workflows/dsh-commands.yml";
  const result = await api(session, "preview", {
    changes: [{ path: proposedPath, source: existing, expectedHash: null }],
  });
  expect(result.body.ok).toBe(true);
  const diagnostics = z
    .array(z.object({ status: z.string(), message: z.string() }))
    .parse(result.body.diagnostics);
  expect(
    diagnostics.some(
      ({ status, message }) =>
        status === "warning" && /issue_comment.*multiple runs/u.test(message),
    ),
  ).toBe(true);
  expect((await readWorkflow(root, workflowName)).source).toBe(existing);
  expect((await readWorkflow(root, proposedPath)).hash).toBeNull();
  const replaced = await api(session, "preview", {
    changes: [
      { path: workflowName, source: simpleWorkflow(), expectedHash: workflowHash(existing) },
      { path: proposedPath, source: existing, expectedHash: null },
    ],
  });
  expect(replaced.body.ok).toBe(true);
  expect(JSON.stringify(replaced.body.diagnostics)).not.toContain("multiple runs");
});
