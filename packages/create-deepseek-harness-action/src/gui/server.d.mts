import type { GuiConfigurationCheck, GuiSessionValidators } from "./workflows.mjs";
export interface GuiSession {
  readonly origin: string;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}
export interface GuiOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly templateDirectory?: string;
  readonly uiDirectory?: string;
  readonly dshHome?: string;
  readonly checkConfiguration?: GuiConfigurationCheck;
  readonly assertSessionWorkflowPolicy?: GuiSessionValidators["assertSessionWorkflowPolicy"];
  readonly sessionKeyHash?: GuiSessionValidators["sessionKeyHash"];
  readonly openBrowser?: boolean;
  readonly browserOpener?: (url: string) => Promise<void>;
  readonly output?: { write(text: string): unknown };
}
export function startGuiServer(options: GuiOptions): Promise<GuiSession>;
export function openLocalBrowser(
  url: string,
  options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): Promise<void>;
export function runLocalGui(options?: Partial<GuiOptions>): Promise<GuiSession>;
