export interface GuiPluginSelection {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "bundle" | "plugin";
  readonly tools?: readonly string[];
}
export function guiLocalPlugins(
  options: { readonly dshMode: string; readonly home?: string },
  environment: NodeJS.ProcessEnv,
  defaultHome?: string,
): Promise<{
  readonly plugins: readonly {
    readonly name: string;
    readonly version: string;
    readonly reason?: string;
    readonly compatible?: boolean;
    readonly compatibility?: string;
  }[];
  readonly warnings: readonly string[];
}>;
export function guiPluginInputs(options: {
  readonly dshMode: string;
  readonly inputs: Record<string, string>;
  readonly selections: readonly GuiPluginSelection[];
  readonly source?: string;
}): { readonly inputs: Record<string, string>; readonly warnings: readonly string[] };
export function unwrapReviewGuard(value: string, fallback: string): string;
