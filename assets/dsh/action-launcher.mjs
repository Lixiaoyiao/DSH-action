import {
  composeActionProfile,
  admittedExtensionSelectors,
  requireAdmittedExtensions,
} from "./profile-runtime.mjs";
import {
  boot,
  createRuntimeResolution,
  installFailLoud,
  loadProfileDirectory,
  PluginPackages,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";
import { createRequire } from "node:module";
import { join } from "node:path";

const NAME = "dsh-action";
const PROFILE = "github-action";
const PROFILE_ROOT_FILENAME = "action-root.yml";
const INSTALL_ANCHOR = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json");

function inheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
}

async function main() {
  const sessionEnabled = process.argv.length === 4 && process.argv[3] === "--action-session";
  const task = sessionEnabled ? process.argv[2] : process.argv.slice(2).join(" ");
  if (task.trim() === "") throw new Error("a non-empty headless task is required");
  const dshHome = process.env.DSH_HOME;
  if (dshHome === undefined || dshHome.trim() === "") {
    throw new Error("DSH_HOME must identify the Controller-owned runtime home");
  }
  const sessionModule = sessionEnabled ? await import("./action-session.mjs") : undefined;
  const sessionPlan = sessionModule?.readSessionPlan(
    join(dshHome, "action-state", "session-plan.json"),
    dshHome,
  );

  // loadProfile and boot are the official 0.2.1-rc.2 Profile/Bundle and Cordis
  // entrypoints. The Action deliberately omits the product CLI's layered .env,
  // home patch, and live user-patch watchers because workflow inputs — not the
  // checked-out repository or model output — are the authorization boundary.
  const profile = loadProfileDirectory(NAME, join(dshHome, "profiles", PROFILE), INSTALL_ANCHOR);
  if (profile.skippedBundles.length !== 0) {
    throw new Error(
      `Profile Bundle compatibility/resolution failed: ${profile.skippedBundles.map((bundle) => `${bundle.packageName}: ${bundle.reason}`).join("; ")}`,
    );
  }
  const resolution = await createRuntimeResolution({
    installAnchor: INSTALL_ANCHOR,
    profile,
    home: dshHome,
  });
  const patches = [
    ...composeActionProfile(profile, "controlled", process.env, task),
    ...(sessionPlan === undefined
      ? []
      : [
          sessionModule.sessionHeadlessPatch(sessionPlan, task),
          {
            id: "session-persistence-jsonl",
            config: { root: join(dshHome, "sessions"), compression: "none" },
          },
        ]),
  ];
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
  const environment = createLaunchEnvironmentSnapshot([
    { source: "process", values: inheritedEnvironment() },
  ]);

  let root;
  let disposePromise;
  let exitStarted = false;
  let resolveExit;
  const exitRequested = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const disposeOnce = () => {
    if (root === undefined) return Promise.resolve();
    disposePromise ??= root.fiber.dispose();
    return disposePromise;
  };
  const requestExit = (code) => {
    if (exitStarted) return;
    exitStarted = true;
    if (!Number.isSafeInteger(code) || code < 0 || code > 255) {
      const invalidCode = new Error("appExit supplied an invalid process exit code");
      void disposeOnce().then(
        () => resolveExit({ error: invalidCode }),
        (error) => resolveExit({ error }),
      );
      return;
    }
    void disposeOnce().then(
      () => resolveExit({ code }),
      (error) => resolveExit({ error }),
    );
  };
  let signalHandlers;
  const uninstallFailLoud = installFailLoud(NAME, process, async () => {
    await disposeOnce();
  });

  try {
    const context = await boot(
      NAME,
      rootConfig,
      globalThis.structuredClone(patches),
      async (host) => {
        root = host;
        if (sessionPlan !== undefined)
          sessionModule.installSessionAdmission(host, sessionPlan, {
            auditPath: join(dshHome, "action-state", "session-admission.json"),
          });
        host.provide(
          "profileContext",
          Object.freeze({
            name: PROFILE,
            dir: profile.dir,
            patchPath: profile.patchPath,
            installAnchor: INSTALL_ANCHOR,
            cwd: process.env.DSH_ACTION_WORKSPACE ?? process.cwd(),
            home: dshHome,
            startedBundles: profile.layers.map((layer) => layer.packageName),
            overlays: [],
            telemetryDisabledEnv: "1",
          }),
        );
        await host.plugin(PluginPackages, { resolution });
        requireAdmittedExtensions(host, admittedExtensionSelectors(profile));
        host.on(
          "agent/created",
          () => {
            if (process.env.DSH_ACTION_DIAGNOSTICS && process.env.DSH_ACTION_DIAGNOSTICS !== "off")
              process.stderr.write('DSH_DIAGNOSTIC {"phase":"loader.ready"}\n');
          },
          { prepend: true },
        );
        const signal = (code) => {
          if (exitStarted) process.exit(code);
          requestExit(code);
        };
        signalHandlers = {
          sigterm: () => signal(0),
          sigint: () => signal(130),
        };
        process.on("SIGTERM", signalHandlers.sigterm);
        process.on("SIGINT", signalHandlers.sigint);
        host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
        provideCmdline(host, {
          args:
            sessionPlan?.sessionId === undefined
              ? ["--json", "--", task]
              : ["--json", "--session-id", sessionPlan.sessionId, "--", task],
          exit: requestExit,
        });
      },
    );
    root = context;
    const outcome = await exitRequested;
    if (outcome.error !== undefined) throw outcome.error;
    process.exitCode = outcome.code;
  } finally {
    if (signalHandlers !== undefined) {
      process.off("SIGTERM", signalHandlers.sigterm);
      process.off("SIGINT", signalHandlers.sigint);
    }
    uninstallFailLoud();
    if (root !== undefined) await disposeOnce();
  }
}

main().catch((error) => {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
