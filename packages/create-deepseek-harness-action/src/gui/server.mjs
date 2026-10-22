import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepositoryRoot, runProcess } from "../process.mjs";
import { GUI_INPUTS, GUI_GROUPS } from "./contract.generated.mjs";
import {
  inspectWorkflow,
  editWorkflow,
  presetWorkflow,
  validateWorkflow,
  overlappingWorkflowWarnings,
} from "./workflows.mjs";
import { listWorkflows, readWorkflow, saveWorkflowChanges, workflowDiff } from "./files.mjs";
import { guiLocalPlugins, guiPluginInputs } from "./plugins.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ...["app", "api", "state", "components", "views"].map((name) => [
    `/${name}.mjs`,
    [`${name}.mjs`, "text/javascript; charset=utf-8"],
  ]),
  ...["tokens", "styles"].map((name) => [
    `/${name}.css`,
    [`${name}.css`, "text/css; charset=utf-8"],
  ]),
]);

function headers(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new Error("Configuration requests require application/json.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Configuration request exceeds 2 MiB.");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid JSON request.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Expected a JSON object.");
  return body;
}

export async function openLocalBrowser(url, options = {}) {
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = await runProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("The system browser opener did not complete.");
}

/** One authenticated loopback session. YAML is the only persistent configuration. */
export async function startGuiServer(options) {
  const root = await resolveRepositoryRoot(options.cwd);
  const environment = options.env ?? process.env;
  const templateDirectory =
    options.templateDirectory ?? fileURLToPath(new URL("../templates/", import.meta.url));
  const uiDirectory = options.uiDirectory ?? fileURLToPath(new URL("./ui/", import.meta.url));
  const bundledValidation =
    options.checkConfiguration && options.assertSessionWorkflowPolicy && options.sessionKeyHash
      ? options
      : await import("./config-validation.mjs");
  const checkConfiguration = options.checkConfiguration ?? bundledValidation.checkConfiguration;
  const sessionValidators = {
    assertSessionWorkflowPolicy:
      options.assertSessionWorkflowPolicy ?? bundledValidation.assertSessionWorkflowPolicy,
    sessionKeyHash: options.sessionKeyHash ?? bundledValidation.sessionKeyHash,
  };
  const base = await presetWorkflow(templateDirectory, "review", "controlled");
  const releaseSha = base.steps[0].uses.split("@").at(-1);
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const previews = new Map();
  let origin;
  let saving = false;
  const server = createServer(async (request, response) => {
    headers(response);
    try {
      if (request.headers.host !== new URL(origin).host)
        return json(response, 403, { error: "Unrecognized local host." });
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith("/api/")) {
        const asset = staticFiles.get(url.pathname);
        if (request.method !== "GET" || !asset) return json(response, 404, { error: "Not found." });
        response.writeHead(200, { "Content-Type": asset[1] });
        response.end(await readFile(join(uiDirectory, asset[0])));
        return;
      }
      const authorization = Buffer.from(request.headers.authorization ?? "");
      if (
        authorization.length !== expectedAuthorization.length ||
        !timingSafeEqual(authorization, expectedAuthorization)
      )
        return json(response, 401, {
          error: "Open the private URL printed by the installer to connect.",
        });
      const requestOrigin = request.headers.origin;
      const site = request.headers["sec-fetch-site"];
      if (
        (requestOrigin !== undefined && requestOrigin !== origin) ||
        (site !== undefined && site !== "same-origin" && site !== "none") ||
        (request.method === "POST" && requestOrigin !== origin)
      )
        return json(response, 403, {
          error: "Configuration requests must originate from this local GUI.",
        });
      if (request.method === "GET" && url.pathname === "/api/state") {
        const files = (await listWorkflows(root)).map((file) => {
          if (file.source === undefined) return file;
          const inspected = inspectWorkflow(file.source);
          return {
            ...file,
            ...inspected,
            ...(!inspected.editable || inspected.sensitive ? { source: undefined } : {}),
          };
        });
        return json(response, 200, {
          repository: basename(root),
          repositoryRoot: root,
          releaseSha,
          inputs: GUI_INPUTS,
          groups: GUI_GROUPS,
          files,
          initialDshMode: options.dshMode ?? "controlled",
          initialSection: options.importPlugins ? "plugins" : "overview",
        });
      }
      if (request.method !== "POST") return json(response, 405, { error: "Method not allowed." });
      const body = await requestBody(request);
      if (url.pathname === "/api/inspect") return json(response, 200, inspectWorkflow(body.source));
      if (url.pathname === "/api/edit") return json(response, 200, editWorkflow(body, releaseSha));
      if (url.pathname === "/api/preset")
        return json(
          response,
          200,
          await presetWorkflow(templateDirectory, body.kind, body.dshMode),
        );
      if (url.pathname === "/api/plugins")
        return json(response, 200, await guiLocalPlugins(body, environment, options.dshHome));
      if (url.pathname === "/api/plugin-inputs") return json(response, 200, guiPluginInputs(body));
      if (url.pathname === "/api/preview") {
        if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > 16)
          throw new Error("Preview 1–16 workflow files at a time.");
        const paths = new Set();
        const changes = [],
          diagnostics = [],
          risks = [];
        for (const change of body.changes) {
          if (paths.has(change.path))
            throw new Error("Each workflow can appear only once in a preview.");
          paths.add(change.path);
          const original = await readWorkflow(root, change.path);
          if (original.hash !== change.expectedHash)
            throw new Error(`${change.path} changed on disk. Reload before previewing.`);
          if (original.hash !== null) {
            const inspected = inspectWorkflow(original.source);
            if (!inspected.editable || inspected.sensitive) throw new Error(inspected.reason);
          }
          const checked = validateWorkflow(change.source, checkConfiguration, sessionValidators);
          diagnostics.push(
            ...checked.diagnostics.map((item) => ({
              ...item,
              message: `${change.path}: ${item.message}`,
            })),
          );
          risks.push(...checked.risks);
          if (change.source !== original.source)
            changes.push({
              path: change.path,
              expectedHash: change.expectedHash,
              source: change.source,
              diff: workflowDiff(change.path, original.source, change.source),
            });
        }
        const proposed = new Map((await listWorkflows(root)).map((file) => [file.path, file]));
        for (const change of body.changes) proposed.set(change.path, change);
        diagnostics.push(...overlappingWorkflowWarnings([...proposed.values()]));
        const ok = !diagnostics.some(({ status }) => status === "failed") && changes.length > 0;
        if (!changes.length)
          diagnostics.push({ status: "warning", message: "No changes to save." });
        previews.clear();
        const id = randomBytes(24).toString("hex");
        if (ok) previews.set(id, changes);
        return json(response, 200, {
          id,
          ok,
          changes: changes.map(({ path, diff }) => ({ path, diff })),
          diagnostics,
          risks: [...new Set(risks)],
        });
      }
      if (url.pathname === "/api/save") {
        if (body.confirm !== true) throw new Error("Review the diff and confirm before saving.");
        if (saving) throw new Error("A save is already in progress.");
        const changes = previews.get(body.previewId);
        if (!changes)
          throw new Error("Preview expired or invalid. Preview the current configuration again.");
        previews.delete(body.previewId);
        saving = true;
        try {
          const warnings = [];
          const saved = await saveWorkflowChanges(root, changes, {
            onCleanupWarning: (path) =>
              warnings.push(`Saved successfully; a local backup could not be removed: ${path}`),
          });
          return json(response, 200, { saved, warnings });
        } finally {
          saving = false;
        }
      }
      if (url.pathname === "/api/shutdown") {
        if (saving) throw new Error("Wait for the current save to finish.");
        json(response, 200, { closed: true });
        previews.clear();
        server.close();
        return;
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent)
        json(response, 400, { error: error.message ?? "Configuration request failed." });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    token,
    url: `${origin}/#token=${token}`,
    close: () =>
      new Promise((done) => {
        previews.clear();
        server.close(done);
        server.closeIdleConnections();
      }),
  };
}

export async function runLocalGui(options = {}) {
  const session = await startGuiServer({ ...options, cwd: options.cwd ?? process.cwd() });
  const output = options.output ?? process.stdout;
  output.write(
    `\nDeepSeek Harness configuration\n${session.url}\n\nKeep this terminal open. The GUI only saves local workflow files; it never commits or pushes.\n`,
  );
  if (options.openBrowser !== false) {
    try {
      await (
        options.browserOpener ??
        ((url) => openLocalBrowser(url, { cwd: options.cwd, env: options.env }))
      )(session.url);
    } catch {
      output.write("The browser could not open automatically. Open the private local URL above.\n");
    }
  }
  return session;
}
