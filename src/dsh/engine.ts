import type { ActionInputs } from "../inputs.js";
import { runDsh, type DshRunResult, type DshRuntime } from "./runner.js";
import type { SecurityPolicy } from "../security/policy.js";
import { removeMarkdownImages } from "../security/redaction.js";
import type {
  AgentEngine,
  AgentToolManifest,
  AgentTurnRequest,
  ToolProvider,
} from "../agent/contracts.js";
import type { ExtensionPlan } from "../extensions/plan.js";
import { nativeToolSchema, type NativeToolId } from "../tools/schema.js";
import type { DshComposition } from "./composition.js";
import { selectDshComposition } from "./select-composition.js";
import { DshAbortedError, DshConfigurationError } from "./errors.js";

export function partitionDshToolPlanes(tools: readonly AgentToolManifest[]): {
  readonly nativeTools: readonly NativeToolId[];
  readonly controllerTools: readonly AgentToolManifest[];
  readonly extensionTools: readonly AgentToolManifest[];
} {
  const nativeTools: NativeToolId[] = [];
  const controllerTools: AgentToolManifest[] = [];
  const extensionTools: AgentToolManifest[] = [];
  for (const tool of tools) {
    if (tool.provider === "command" || tool.provider === "github") {
      controllerTools.push(tool);
      continue;
    }
    if (tool.provider === "mcp" || tool.provider === "plugin") {
      extensionTools.push(tool);
      continue;
    }
    const parsed = nativeToolSchema.safeParse(tool.id);
    if (!parsed.success) throw new Error(`Unsupported native DSH tool id: ${tool.id}`);
    nativeTools.push(parsed.data);
  }
  return { nativeTools, controllerTools, extensionTools };
}

/** Own DSH turn execution and shutdown while retaining the complete worker result. */
export class DshAgentEngine implements AgentEngine<DshRunResult> {
  public readonly id = "dsh";
  public readonly version: string;
  private readonly composition: DshComposition;
  private activeRun:
    { readonly controller: AbortController; readonly settled: Promise<void> } | undefined;
  private closing = false;
  private disposal: Promise<void> | undefined;

  public constructor(
    private readonly inputs: ActionInputs,
    private readonly policy: SecurityPolicy,
    private readonly runtime?: DshRuntime,
    private readonly extensions?: ExtensionPlan,
    composition?: DshComposition,
    private readonly controllerTools?: ToolProvider,
  ) {
    this.version = inputs.dshVersion;
    this.composition = composition ?? selectDshComposition(inputs.dshMode).create();
  }

  public async runTurn(request: AgentTurnRequest) {
    if (this.closing)
      throw new DshConfigurationError("A disposed DSH engine cannot start another turn");
    if (this.activeRun !== undefined)
      throw new DshConfigurationError(
        "A DSH engine cannot run overlapping turns against its runtime",
      );
    const controller = new AbortController();
    const signal =
      request.signal === undefined
        ? controller.signal
        : AbortSignal.any([request.signal, controller.signal]);
    const running = this.executeTurn({ ...request, signal });
    const active = {
      controller,
      settled: running.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.activeRun = active;
    try {
      return await running;
    } finally {
      if (this.activeRun === active) this.activeRun = undefined;
    }
  }

  /** Cancel active turns and await their cleanup; the runtime owner separately drains late activity leases. */
  public dispose(): Promise<void> {
    this.closing = true;
    this.activeRun?.controller.abort(new DshAbortedError());
    this.disposal ??= this.activeRun?.settled ?? Promise.resolve();
    return this.disposal;
  }

  private async executeTurn(request: AgentTurnRequest) {
    const { nativeTools, extensionTools } = partitionDshToolPlanes(request.tools);
    const actualExtensionIds = extensionTools.map(({ id }) => id).sort();
    if (this.extensions?.profileName === "github-action") {
      const plannedExtensionIds = this.extensions.manifests.map(({ id }) => id).sort();
      if (JSON.stringify(actualExtensionIds) !== JSON.stringify(plannedExtensionIds)) {
        throw new Error("DSH extension manifest set does not match the Controller plan");
      }
    } else if (actualExtensionIds.length > 0) {
      throw new Error("Native DSH extensions must not be represented as Controller manifests");
    }
    return await runDsh(
      {
        operation: request.operation,
        prompt: JSON.stringify(request.context, (_key, value: unknown) =>
          typeof value === "string" ? removeMarkdownImages(value) : value,
        ),
        trustedInstructions: removeMarkdownImages(request.instructions),
        workspacePath: request.workspacePath,
        ...(this.controllerTools === undefined ? {} : { controllerTools: this.controllerTools }),
        nativeTools,
        ...(request.operation !== "task" || this.inputs.taskOutputSchema === undefined
          ? {}
          : { taskOutputSchema: this.inputs.taskOutputSchema }),
        ...(this.extensions === undefined ? {} : { extensions: this.extensions }),
        trust: this.policy.trust,
        isolation: this.inputs.isolation,
        deadlineMs: request.deadlineMs,
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        maxOutputBytes: 2 * 1024 * 1024,
        apiKey: this.inputs.deepseekApiKey,
        controllerCredentials: [this.inputs.githubToken],
        baseUrl: this.inputs.baseUrl,
        webSearchBaseUrl: this.inputs.webSearchBaseUrl,
        dshVersion: this.inputs.dshVersion,
        ...(this.inputs.dshExecutable === "" ? {} : { dshExecutable: this.inputs.dshExecutable }),
        containerImage: this.inputs.containerImage,
      },
      {
        composition: this.composition,
        ...(this.runtime === undefined ? {} : { runtime: this.runtime }),
      },
    );
  }
}
