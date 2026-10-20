import type { Context } from "@deepseek-ai/cordis";
import type * as McpClient from "@deepseek-ai/dsh-mcp-client";
export const name: "dsh-action-controller";
export const inject: readonly ["tools"];
export interface ControllerBootstrap {
  readonly url: string;
  readonly token: string;
  readonly tools: readonly string[];
  readonly timeoutMs: number;
}
export function parseControllerBootstrap(raw: string): ControllerBootstrap;
export function consumeControllerBootstrap(): Promise<ControllerBootstrap>;
export function controllerBridgePatches(bootstrap: ControllerBootstrap | undefined): unknown[];
export function installControllerBootstrap(
  host: Context,
  bootstrap: ControllerBootstrap | undefined,
  client: typeof McpClient,
): void;
export function apply(ctx: Context): Promise<void>;
