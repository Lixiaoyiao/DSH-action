import * as core from "@actions/core";
import { join } from "node:path";
import type { AgentToolManifest } from "../agent/contracts.js";
import { mentionBody } from "../commands/router.js";
import { prepareGitHubImages, type GitHubImage } from "../github/images.js";
import { assertWriteTaskConfiguration } from "../configuration-check.js";
import type { DshComposition } from "../dsh/composition.js";
import { PolicyDeniedError } from "../errors.js";
import {
  resolveExtensionPlan,
  resolveNativeExtensionPlan,
  type ExtensionPlan,
} from "../extensions/plan.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { buildControllerToolPolicyAudit, buildPermissionAudit } from "../permissions/profile.js";
import { buildAuthorityAudit } from "../security/authority.js";
import { redactKnownSecrets } from "../security/env.js";
import {
  CommandToolProvider,
  resolveEffectiveTools,
  type EffectiveTools,
} from "../tools/registry.js";
import { ToolRouter } from "../tools/router.js";
import { buildContextPacket, taskIdentity } from "./context.js";
import { createGitHubToolBinding } from "./github-authority.js";
import { createPublication, type Publication } from "./operation-finalizer.js";
import type { RunFacts } from "../result.js";
import type { RunLifecycle } from "./lifecycle.js";
import type { AuthorizedRun } from "./prepare.js";
import type { PreparedWorkspace } from "./workspace.js";

type ContextPacket = Awaited<ReturnType<typeof buildContextPacket>> & {
  readonly images?: readonly GitHubImage[];
};

export interface PreparedExecution {
  readonly publication: Publication;
  readonly contextPacket: ContextPacket;
  readonly imageFiles?: { readonly directory: string; readonly files: readonly string[] };
  readonly tools: EffectiveTools & {
    readonly extensions: ExtensionPlan;
    readonly manifests: readonly AgentToolManifest[];
  };
  readonly toolProvider?: ToolRouter;
  readonly extensions: ExtensionPlan;
  readonly selectedComposition: DshComposition;
  readonly redact: (value: string) => string;
}

/** Prepare capabilities and keep their observations local to this phase. */
export class ExecutionPreparation {
  private readonly facts: {
    -readonly [K in "permission" | "toolPolicy" | "authority" | "textSources"]?: RunFacts[K];
  } = {};
  private publication: Publication | undefined;
  public constructor(
    private readonly options: {
      readonly lifecycle: RunLifecycle;
      readonly composition: DshComposition;
      readonly authorized: AuthorizedRun;
      readonly workspace: PreparedWorkspace;
      readonly inputs: ActionInputs;
      readonly deadlineMs: number;
      readonly signal: AbortSignal;
    },
  ) {}
  public snapshot() {
    return { ...this.facts, ...this.publication?.facts };
  }

  public async run(): Promise<PreparedExecution> {
    const { lifecycle, composition, authorized, workspace, inputs, deadlineMs, signal } =
      this.options;
    const state = this.facts;
    const { client, context, command, snapshot, policy } = authorized;
    if (command.requestedAccess === "write") assertWriteTaskConfiguration(inputs);
    const { agentWorkspace } = workspace;
    const baseContextPacket = await buildContextPacket(
      client,
      context,
      command,
      snapshot,
      inputs,
      workspace.boundWriteSha,
    );
    throwIfCancelled(signal);
    if (command.instructionFile !== undefined || baseContextPacket.textFiles !== undefined) {
      state.textSources = {
        ...(command.instructionFile === undefined ? {} : { instruction: command.instructionFile }),
        contexts: (baseContextPacket.textFiles ?? []).map(
          ({ repository, sourceSha, path, blobSha, bytes }) => ({
            repository,
            sourceSha,
            path,
            blobSha,
            bytes,
          }),
        ),
      };
    }
    const trustedGitHubBinding = createGitHubToolBinding(context, snapshot);
    const resolvedTools = resolveEffectiveTools(inputs.allowedTools, inputs.toolConfig, policy, {
      permissionProfile: inputs.permissionProfile,
      disallowedTools: inputs.disallowedTools,
      isolation: inputs.isolation,
      ...(trustedGitHubBinding === undefined ? {} : { githubBinding: trustedGitHubBinding }),
      allowWrite: inputs.allowWrite,
    });
    const imageDirectory = join(workspace.tempRoot, "github-images");
    const imageAssets = await prepareGitHubImages({
      texts: [
        inputs.prompt,
        command.instructions,
        mentionBody(context) ?? "",
        ...(snapshot === undefined
          ? []
          : [snapshot.body, ...snapshot.comments.map(({ body }) => body)]),
      ],
      directory: imageDirectory,
      token: inputs.githubToken,
      enabled: inputs.isolation === "docker" && resolvedTools.workspace.includes("workspace.read"),
      signal,
    });
    for (const image of imageAssets.images) {
      if (image.status !== "ready")
        core.warning(`GitHub image: ${image.reason ?? image.status} (${image.source})`);
    }
    const contextPacket: ContextPacket = {
      ...baseContextPacket,
      ...(imageAssets.images.length === 0 ? {} : { images: imageAssets.images }),
    };
    const deniedTools = new Set(resolvedTools.permission.disallowedTools);
    const extensionAllowedTools = resolvedTools.permission.requestedTools.filter(
      (id) => !deniedTools.has(id),
    );
    const extensions =
      inputs.dshMode === "native"
        ? resolveNativeExtensionPlan({
            mcp: inputs.mcpConfig,
            plugins: inputs.pluginConfig,
            allowPluginInstall: inputs.allowPluginInstall,
            policy,
          })
        : resolveExtensionPlan({
            allowedTools: extensionAllowedTools,
            mcp: inputs.mcpConfig,
            plugins: inputs.pluginConfig,
            allowPluginInstall: inputs.allowPluginInstall,
            policy,
          });
    const extensionManifests =
      extensions.profileName === "github-action" ? extensions.manifests : [];
    const tools = {
      ...resolvedTools,
      extensions,
      manifests: [...resolvedTools.manifests, ...extensionManifests],
    };
    if (
      extensions.profileName === "github-action" &&
      extensions.network &&
      tools.native.includes("native.bash")
    ) {
      throw new PolicyDeniedError(
        "native.bash cannot share a worker with a bridge-networked extension; use mediated web-search or remove Bash",
      );
    }
    if (command.requestedAccess === "write" && !tools.workspace.includes("workspace.edit")) {
      throw new PolicyDeniedError(
        "Write tasks require effective workspace.edit permission; select standard or allow it in custom after all trust gates pass",
      );
    }

    const redact = (value: string): string =>
      redactKnownSecrets(value, [inputs.deepseekApiKey, inputs.githubToken]);
    const commandToolProvider =
      tools.commands.length === 0
        ? undefined
        : new CommandToolProvider({
            definitions: tools.commands,
            workspacePath: agentWorkspace,
            containerImage: inputs.containerImage,
            redact,
          });
    const permission = buildPermissionAudit({
      resolution: resolvedTools.permission,
      manifests: tools.manifests,
      additionalDenials: resolvedTools.permissionDenials,
      ...(composition.actionManagedExtensionProfile || extensions.audit.entries.length > 0
        ? { extensions: extensions.audit }
        : {}),
      mediatedWeb: composition.requiresWebSearchProxy(tools.native),
    });
    state.permission = permission;
    if (composition.toolPolicyOwner === "controller") {
      state.toolPolicy = buildControllerToolPolicyAudit(permission, composition.toolPolicyOwner);
    }
    const operationIdentity = taskIdentity(
      command,
      inputs,
      extensions.digest,
      permission.digest,
      contextPacket.textFiles,
    );

    const publication = createPublication({
      authorized,
      inputs,
      workspace,
      lifecycle,
      deadlineMs,
      signal,
      taskIdentity: operationIdentity,
      githubTools: tools.github,
      ...(trustedGitHubBinding === undefined ? {} : { githubBinding: trustedGitHubBinding }),
    });
    this.publication = publication;
    const controllerProviders = [commandToolProvider, publication.tools].filter(
      (provider) => provider !== undefined,
    );
    const toolProvider =
      controllerProviders.length === 0 ? undefined : new ToolRouter(controllerProviders);
    const agentTools = {
      ...tools,
      manifests: [
        ...tools.manifests.filter(
          ({ provider }) => provider !== "command" && provider !== "github",
        ),
        ...(toolProvider?.manifest() ?? []),
      ],
    };
    state.authority = buildAuthorityAudit(extensions);
    const selectedComposition = composition;

    return {
      publication,
      contextPacket,
      ...(imageAssets.files.length === 0
        ? {}
        : { imageFiles: { directory: imageDirectory, files: imageAssets.files } }),
      tools: agentTools,
      ...(toolProvider === undefined ? {} : { toolProvider }),
      extensions,
      selectedComposition,
      redact,
    };
  }
}
