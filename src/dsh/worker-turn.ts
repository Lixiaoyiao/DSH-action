import type { ModelUsage } from "./usage.js";
import { join } from "node:path";
import * as core from "@actions/core";

import { PolicyDeniedError } from "../errors.js";
import {
  assertNoSecretOutput,
  assertSecretAbsent,
  buildDshWorkerEnvironment,
  redactKnownSecrets,
} from "../security/env.js";
import { inspectStoredSession } from "../session/checkpoint.js";
import { collectWorkerSession } from "../session/worker.js";
import { dockerWorkerSpec } from "./docker-policy.js";
import {
  DshConfigurationError,
  DshError,
  DshIsolationUnavailableError,
  DshMalformedOutputError,
  DshProcessError,
  DshProxyError,
  DshSpawnError,
} from "./errors.js";
import { HeadlessOutputDecoder } from "./headless-output.js";
import { repairDshOutput } from "./output-repair.js";
import { executeBoundedDshProcess, type DshProcessResult, type DshProcessSpec } from "./process.js";
import { startDeepSeekProxy, type DeepSeekProxyHandle } from "./proxy.js";
import type { DshRunContext } from "./runner-context.js";
import {
  assertWorkerLaunchHasNoControllerCredentials,
  isolationReport,
  runtimeExtensionAudit,
  withheldControllerSecrets,
} from "./runner-policy.js";
import type { DshRunDependencies, DshRunResult } from "./runner-types.js";
import type { DshRunScope } from "./run-scope.js";
import { withDshRuntimeActivity, type DshRuntime } from "./runtime.js";
import {
  prepareWorkerRuntime,
  type DshProcessExecutor,
  type PreparedWorkerRuntime,
} from "./runtime-preparation.js";
import { parseDshOutput, type DshOutput } from "./schema.js";
import { DshTurnEvidence } from "./turn-evidence.js";

/** Own worker preparation and terminal/evidence processing behind one run interface. */
export class DshWorker {
  private readonly context: DshRunContext;
  private readonly runtime: DshRuntime;
  private readonly scope: DshRunScope;
  private readonly dependencies: DshRunDependencies;
  private usage: ModelUsage | undefined;

  public constructor(
    context: DshRunContext,
    runtime: DshRuntime,
    scope: DshRunScope,
    dependencies: DshRunDependencies,
  ) {
    this.context = context;
    this.runtime = runtime;
    this.scope = scope;
    this.dependencies = dependencies;
  }

  private async acquireProxy(prepared: PreparedWorkerRuntime): Promise<DeepSeekProxyHandle> {
    const { context, scope, dependencies } = this;
    const { request } = context;
    const docker = request.isolation === "docker";
    if (docker && prepared.network === undefined)
      throw new DshConfigurationError("Docker worker has no inspected proxy gateway");
    const proxyAddress = prepared.network?.gateway ?? "127.0.0.1";
    const proxy = await scope.setup(
      async () => {
        try {
          return await (dependencies.startProxy ?? startDeepSeekProxy)({
            apiKey: request.apiKey,
            baseUrl: request.baseUrl,
            ...(context.webSearchEnabled ? { webSearchBaseUrl: request.webSearchBaseUrl } : {}),
            allowWebSearch:
              context.webSearchEnabled &&
              (context.composition.toolPolicyOwner === "dsh" ||
                context.nativeTools.includes("native.web-search")),
            allowWebFetch:
              context.webSearchEnabled &&
              (context.composition.toolPolicyOwner === "dsh" ||
                context.nativeTools.includes("native.web-fetch")),
            bindHost: proxyAddress,
            workerHost: proxyAddress,
            requestTimeoutMs: Math.max(1, scope.deadlineMs - scope.now()),
            deadlineMs: scope.deadlineMs,
            ...(dependencies.diagnostics === undefined
              ? {}
              : { diagnostics: dependencies.diagnostics }),
            maxResponseBytes: request.maxOutputBytes,
          });
        } catch (error: unknown) {
          if (
            docker &&
            error instanceof DshProxyError &&
            typeof error.cause === "object" &&
            error.cause !== null &&
            "code" in error.cause &&
            error.cause.code === "EADDRNOTAVAIL"
          ) {
            throw new DshIsolationUnavailableError(
              "Docker credential proxy requires a local Linux Docker bridge gateway; remote Docker and Docker Desktop gateways are unsupported",
              { cause: error },
            );
          }
          throw error;
        }
      },
      async (lateProxy) => lateProxy.close(),
    );
    scope.own("proxy", async () => proxy.close());
    if (
      context.webSearchEnabled &&
      (context.composition.toolPolicyOwner === "dsh" ||
        context.nativeTools.includes("native.web-search")) &&
      proxy.workerWebSearchBaseUrl === undefined
    ) {
      throw new DshConfigurationError(
        "The Controller proxy did not expose the required mediated web-search route",
      );
    }
    return proxy;
  }

  private async validateResult(
    processResult: DshProcessResult,
    proxy: DeepSeekProxyHandle,
    secrets: readonly string[],
    decoder: HeadlessOutputDecoder,
  ): Promise<DshOutput> {
    const { context, scope, dependencies } = this;
    assertNoSecretOutput("stdout", processResult.stdout, secrets);
    assertNoSecretOutput("stderr", processResult.stderr, secrets);
    // Retain safe completed-step samples even when exit/terminal validation
    // fails. This read-only projection also checks decoded secret escapes.
    decoder.end(processResult.stdout);
    decoder.assertSafe();
    this.usage = decoder.partialUsage();
    if (processResult.exitCode !== 0 || processResult.signal !== null) {
      throw new DshProcessError(
        processResult.exitCode,
        processResult.signal,
        redactKnownSecrets(processResult.stderr.trim(), secrets),
      );
    }
    const terminal = decoder.result();
    this.usage = terminal.usage;
    const resultText = terminal.text;
    const { request } = context;
    try {
      const output = parseDshOutput(resultText, request.operation, request.taskOutputSchema);
      assertNoSecretOutput("stdout", JSON.stringify(output), secrets);
      return output;
    } catch (error: unknown) {
      if (!(error instanceof DshMalformedOutputError)) throw error;
      // The formatting request is a separate model call outside the worker's
      // step projection. Keep its reported subtotal without claiming completeness.
      if (this.usage !== undefined) this.usage = { ...this.usage, completeness: "partial" };
      const repaired = await repairDshOutput({
        raw: resultText,
        originalError: error,
        operation: request.operation,
        ...(request.taskOutputSchema === undefined
          ? {}
          : { taskOutputSchema: request.taskOutputSchema }),
        proxy,
        secrets,
        maxOutputBytes: request.maxOutputBytes,
        deadlineMs: scope.deadlineMs,
        now: scope.now,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        ...(dependencies.resultRepairFetch === undefined
          ? {}
          : { fetchImplementation: dependencies.resultRepairFetch }),
      });
      (dependencies.warning ?? core.warning)(
        `DSH final output required one tool-free formatting repair: ${error.message}`,
      );
      return repaired;
    }
  }

  private async inspectCompletedSession(): Promise<void> {
    const { runtime, context, scope } = this;
    if (runtime.session === undefined) return;
    try {
      await scope.setup(async () => collectWorkerSession(runtime, context.workspaceWrite));
      const session = runtime.session;
      const sessionId = session.sessionId;
      if (sessionId === undefined)
        throw new DshConfigurationError("Worker did not admit a Session");
      const inspection = await scope.setup(async () =>
        inspectStoredSession({
          persistenceRoot: join(runtime.dshHome, "sessions"),
          dshHome: join(runtime.dshHome, "attachments"),
          sessionId,
          workspacePath: "/workspace",
          knownSecrets: [...session.knownSecrets],
        }),
      );
      session.checkpointEventCount = inspection.eventCount;
    } catch (error: unknown) {
      if (error instanceof DshError) throw error;
      throw new DshConfigurationError(
        error instanceof PolicyDeniedError
          ? error.message
          : "Session worker admission or raw log is missing, invalid or incompatible",
        { cause: error },
      );
    }
  }

  /** Execute one worker turn, inspect terminal data, then attach bounded evidence. */
  public async run(): Promise<DshRunResult> {
    const { context, runtime, scope, dependencies } = this;
    const execute: DshProcessExecutor =
      dependencies.executeProcess ??
      ((spec, limits) => executeBoundedDshProcess(spec, limits, context.platform));
    const trace = dependencies.diagnostics;
    trace?.resetStream();
    const prepared = await prepareWorkerRuntime(context, runtime, scope, execute);
    const proxy = await this.acquireProxy(prepared);
    const secrets = [
      ...context.secrets,
      proxy.workerToken,
      ...Object.values(context.request.workerEnv ?? {}),
    ];
    trace?.addSecrets(secrets);
    for (const secret of secrets) runtime.session?.knownSecrets.add(secret);
    const { request } = context;
    const decoder = new HeadlessOutputDecoder(secrets, (event) => trace?.observeHeadless(event));
    const evidence = new DshTurnEvidence(prepared.composition, scope, secrets);
    try {
      const workerEnvironment = buildDshWorkerEnvironment({
        source: context.environment,
        dshHome: runtime.dshHome,
        permissionMode: context.workspaceWrite ? "workspace-write" : "read-only",
        proxyBaseUrl: proxy.workerBaseUrl,
        proxyToken: proxy.workerToken,
        realDeepSeekApiKey: request.apiKey,
      });
      Object.assign(workerEnvironment, request.workerEnv ?? {});
      assertSecretAbsent(workerEnvironment, request.apiKey, "real DeepSeek API key");
      await evidence.begin();
      const composition = prepared.composition;
      let spec: DshProcessSpec;
      if (composition.isolation === "docker") {
        if (prepared.network === undefined)
          throw new DshConfigurationError("Docker worker has no inspected network");
        spec = dockerWorkerSpec({
          containerImage: request.containerImage,
          ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
          workspace: context.workspace,
          dshHome: runtime.dshHome,
          packageRoot: runtime.packageRoot,
          launchPlan: composition.launchPlan,
          networkName: prepared.network.name,
          hostGateway: prepared.network.gateway,
          environment: context.environment,
          workerEnvironment,
          proxy,
          workspaceWrite: context.workspaceWrite,
          workerNetwork: request.workerNetwork !== false,
          diagnosticLevel: trace?.level ?? "off",
          extraEnvironmentNames: Object.keys(request.workerEnv ?? {}),
        });
      } else spec = { ...composition.launchPlan, env: workerEnvironment };
      assertWorkerLaunchHasNoControllerCredentials(
        spec,
        withheldControllerSecrets(request, context.environment),
      );
      const remainingMs = scope.remaining(request.timeoutMs);
      let processResult: DshProcessResult | undefined;
      let output: DshOutput | undefined;
      let failure: unknown;
      try {
        trace?.event("worker.start");
        processResult = await withDshRuntimeActivity(runtime, async () =>
          execute(spec, {
            timeoutMs: remainingMs,
            phase: "worker",
            onStdout: (chunk: Buffer) => decoder.write(chunk),
            onStderr: (chunk: Buffer) => trace?.stderr(chunk),
            maxStdoutBytes: request.maxOutputBytes,
            maxStderrBytes: Math.min(request.maxOutputBytes, 2 * 1024 * 1024),
            maxCombinedBytes: request.maxOutputBytes,
            ...(scope.signal === undefined ? {} : { signal: scope.signal }),
          }),
        );
        trace?.event("worker.exit");
        output = await this.validateResult(processResult, proxy, secrets, decoder);
        trace?.event("output.validated");
      } catch (error: unknown) {
        failure =
          request.isolation === "docker" && error instanceof DshSpawnError
            ? new DshIsolationUnavailableError("Docker could not be started", { cause: error })
            : error;
      }
      if (failure !== undefined) {
        trace?.event("worker.error");
        decoder.end();
        try {
          decoder.assertSafe();
        } catch (error) {
          failure = error;
        }
        this.usage = decoder.partialUsage();
      }
      failure = await evidence.collect(failure);
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new DshConfigurationError("DSH execution failed with a non-Error value");
      if (processResult === undefined || output === undefined)
        throw new DshConfigurationError("DSH execution produced no process result");
      await this.inspectCompletedSession();
      const extensionAudit = runtimeExtensionAudit(
        request,
        context.extensions,
        runtime,
        context.composition,
      );
      return {
        output,
        rawStdout: processResult.stdout,
        ...(this.usage === undefined ? {} : { usage: this.usage }),
        durationMs: Math.max(0, scope.now() - scope.startedAt),
        isolationReport: isolationReport(request, context.composition),
        ...(extensionAudit === undefined ? {} : { extensionAudit }),
        ...evidence.fields(),
      };
    } catch (error: unknown) {
      if (error instanceof DshError)
        error.attachTelemetry({
          durationMs: Math.max(0, scope.now() - scope.startedAt),
          isolationReport: isolationReport(request, context.composition),
          ...evidence.fields(),
          ...(this.usage === undefined ? {} : { usage: this.usage }),
        });
      throw error;
    }
  }
}
