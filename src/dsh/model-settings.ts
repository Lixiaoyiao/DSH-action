/** Maintainer-selected defaults for the official Headless Agent. */
export interface DshModelSettings {
  readonly model?: string;
  readonly reasoningEffort?: "off" | "low" | "high" | "max";
}

/** Patch DSH's public default-selection service; omission preserves its defaults. */
export function modelSettingsPatch(settings: DshModelSettings): readonly Record<string, unknown>[] {
  if (settings.model === undefined && settings.reasoningEffort === undefined) return [];
  return [
    {
      id: "agent-default-model",
      config: {
        // Cordis replaces config as a whole. Preserve the pinned base bundle's
        // required provider/model pair when only effort is selected.
        provider: "deepseek-official",
        model: settings.model ?? "deepseek-flash",
        ...(settings.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: settings.reasoningEffort }),
      },
    },
  ];
}
