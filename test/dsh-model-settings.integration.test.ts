import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { readProjectProfile } from "../src/dsh/project-profile.js";
import { prepareControlledProfile } from "../src/dsh/controlled-profile.js";
import { writeNativeProfile } from "../src/dsh/native-composition.js";
import { resolveExtensionPlan, resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { sendMessagesSse } from "./fixtures/messages-sse.mjs";
import { pullRequestContext } from "./helpers.js";
import { fixtureObjects, readJsonFixture } from "./helpers/json-fixture.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const requestSchema = z.looseObject({
  model: z.string(),
  thinking: z.object({ type: z.enum(["enabled", "disabled"]) }),
  output_config: z.object({ effort: z.string() }).optional(),
  tools: z.array(z.unknown()).optional(),
});

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new TypeError("Expected a byte request");
  }
  return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

describe.each(["controlled", "native"] as const)("%s model settings through pinned DSH", (mode) => {
  it.each(
    [
      { label: "defaults", model: undefined, effort: undefined },
      { label: "model only", model: "deepseek-v4-pro", effort: undefined },
      { label: "effort only", model: undefined, effort: "high" as const },
      ...(["off", "low", "max"] as const).map((effort) => ({
        label: effort,
        model: "deepseek-v4-pro",
        effort,
      })),
    ]
      .map(
        (
          item,
        ): {
          label: string;
          model: string | undefined;
          effort: "off" | "low" | "high" | "max" | undefined;
          project: boolean;
        } => ({ ...item, project: false }),
      )
      .concat([
        {
          label: "project Profile",
          model: "deepseek-v4-pro",
          effort: "max" as const,
          project: true,
        },
      ]),
  )(
    "sends $label on the actual Messages request",
    async ({ model, effort, project }) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-model-settings-"));
      temporary.push(root);
      const dshHome = join(root, "home");
      const workspace = join(root, "workspace");
      const profileRoot = join(dshHome, "profiles", "github-action");
      const actionState = join(dshHome, "action-state");
      await Promise.all(
        [workspace, profileRoot, actionState].map((path) => mkdir(path, { recursive: true })),
      );
      const policy = evaluatePolicy({
        context: pullRequestContext(),
        operation: "review",
        allowWrite: false,
        permissions: { actors: [], allActorsHaveWrite: true, allActorsAllowedForWrite: true },
      });
      const common = {
        mcp: { schemaVersion: 1 as const, servers: [] },
        plugins: { schemaVersion: 1 as const, bundles: [], plugins: [] },
        allowPluginInstall: false,
        policy,
      };
      let projectProfile;
      if (project) {
        const directory = join(root, "source-profile");
        await mkdir(directory);
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
          }),
        );
        await writeFile(
          join(directory, "cordis.patch.yml"),
          JSON.stringify([
            {
              id: "agent-default-model",
              config: { provider: "deepseek-official", model, reasoningEffort: effort },
            },
            { id: "system-prompt", config: { personaPrefix: "PROJECT_PROMPT_PRESERVED" } },
            {
              id: "headless-runner",
              config: {
                task: "STATIC_PROFILE_TASK",
                json: false,
                sessionId: "invalid-profile-session",
              },
            },
          ]),
        );
        projectProfile = await readProjectProfile(directory, {
          path: ".dsh",
          sourceSha: "a".repeat(40),
        });
      }
      const selection =
        projectProfile !== undefined
          ? { projectProfile }
          : {
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { reasoningEffort: effort }),
            };
      const manifestBase = { name: "model-settings-fixture", private: true, dependencies: {} };
      if (mode === "controlled") {
        await prepareControlledProfile({
          ...selection,
          dshHome,
          plan: resolveExtensionPlan({ ...common, allowedTools: [] }),
          nativeTools: [],
          workspaceWrite: false,
          expectedOperation: "task",
          task: "Return MODEL_SETTINGS_OK.",
          workerWorkspacePath: workspace,
          policyPluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-policy.mjs")).href,
          workspacePluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-workspace.mjs"))
            .href,
          workerStatePath: join(actionState, "tool-counts.json"),
          workerAuditPath: join(actionState, "tool-receipts.jsonl"),
          manifestBase,
        });
      } else {
        await writeNativeProfile({
          ...selection,
          profileRoot,
          manifestBase,
          plan: resolveNativeExtensionPlan(common),
        });
        // Production mounts this path in Docker. Only its filesystem location
        // changes for the host fixture; the generated model patch is untouched.
        const patchPath = join(
          profileRoot,
          project ? ".action-runtime.patch.yml" : "cordis.patch.yml",
        );
        const patch = fixtureObjects(await readJsonFixture(patchPath));
        const attachment = patch.find(({ id }) => id === "attachment-local");
        if (attachment === undefined) throw new Error("Missing attachment provider");
        attachment.config = { dshHome: join(dshHome, "attachments") };
        await writeFile(patchPath, JSON.stringify(patch));
        await writeFile(join(actionState, "native-observed-tools.jsonl"), "");
      }
      const requests: z.infer<typeof requestSchema>[] = [];
      const server = createServer((request, response) => {
        if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
          request.resume();
          response.writeHead(404).end();
          return;
        }
        void readRequest(request)
          .then((body) => {
            requests.push(body);
            sendMessagesSse(response, { content: "MODEL_SETTINGS_OK" }, "stop");
          })
          .catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Expected TCP port");
        const launcher = mode === "controlled" ? "action-launcher.mjs" : "native-launcher.mjs";
        const result = await execFileAsync(
          process.execPath,
          [
            "--expose-internals",
            join(process.cwd(), "assets/dsh", launcher),
            "Return MODEL_SETTINGS_OK.",
          ],
          {
            cwd: workspace,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              HOME: dshHome,
              DSH_HOME: dshHome,
              DSH_TELEMETRY_DISABLED: "1",
              DSH_TOOLS_MODE: "native",
              DEEPSEEK_API_KEY: "model-settings-fixture-key",
              DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
            },
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("MODEL_SETTINGS_OK");
        // Native also generates a session title; the Agent request carries its
        // tool schemas, while that auxiliary provider request does not.
        const agentRequests = project
          ? requests.filter((request) =>
              JSON.stringify(request).includes("PROJECT_PROMPT_PRESERVED"),
            )
          : mode === "controlled"
            ? requests
            : requests.filter((request) => request.tools !== undefined);
        expect(agentRequests).toHaveLength(1);
        if (project) {
          expect(JSON.stringify(agentRequests[0])).toContain("PROJECT_PROMPT_PRESERVED");
          expect(JSON.stringify(agentRequests[0])).not.toContain("STATIC_PROFILE_TASK");
        }
        expect(agentRequests[0]).toMatchObject({
          model: model ?? "deepseek-flash",
          thinking: { type: effort === "off" ? "disabled" : "enabled" },
        });
        if (effort === "off") expect(agentRequests[0]).not.toHaveProperty("output_config");
        else expect(agentRequests[0]?.output_config).toEqual({ effort: effort ?? "high" });
        const generated = await readFile(join(profileRoot, "cordis.patch.yml"), "utf8");
        if (model === undefined && effort === undefined) {
          expect(generated).not.toContain("agent-default-model");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
    45_000,
  );
});
