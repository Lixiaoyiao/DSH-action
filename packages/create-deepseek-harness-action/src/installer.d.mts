import type { Readable, Writable } from "node:stream";
import type { GuiOptions, GuiSession } from "./gui/server.mjs";

export type InstallerMode = "review" | "commands" | "both" | "session";
export type InstallerDshMode = "controlled" | "native";

export interface InstallerOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly templateDirectory?: string;
  readonly guiLauncher?: (
    options: GuiOptions & {
      readonly dshMode: InstallerDshMode;
      readonly importPlugins?: boolean;
    },
  ) => Promise<GuiSession>;
}

export interface InstallerResult {
  readonly mode?: InstallerMode;
  readonly dshMode: InstallerDshMode;
  readonly createdFiles: readonly string[];
  readonly gui?: GuiSession;
}

export function parseArguments(argv: readonly string[]): {
  readonly help: boolean;
  readonly mode: InstallerMode | undefined;
  readonly dshMode: InstallerDshMode | undefined;
  readonly testCommands?: readonly (readonly string[])[];
  readonly containerImage?: string;
  readonly advanced?: boolean;
  readonly gui?: boolean;
  readonly noOpen?: boolean;
  readonly importPlugins?: boolean;
  readonly dshHome?: string;
};

export function runInstaller(options?: InstallerOptions): Promise<InstallerResult>;
