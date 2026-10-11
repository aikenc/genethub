import type { ProviderInfo, ProviderPreset } from "@genehub/proto";

export const DIALECT_LABEL: Record<string, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic 兼容",
};

/**
 * Whether a provider is something the person set up. The daemon keeps an
 * entry for a shipped provider whose key was cleared; listing it would bring
 * back the clutter of a row for every vendor.
 */
export function isConfiguredProvider(provider: ProviderInfo): boolean {
  return provider.custom || provider.hasApiKey;
}

export function configuredProviders(providers: readonly ProviderInfo[] | undefined): ProviderInfo[] {
  return (providers ?? []).filter(isConfiguredProvider);
}

/**
 * The presets not already in the list. The presets themselves come from the
 * daemon (`settings.presets`): choosing one only fills in the add form, and
 * the address it fills in is the one the daemon would have used anyway.
 */
export function presetsToAdd(
  providers: readonly ProviderInfo[] | undefined,
  presets: readonly ProviderPreset[] | undefined,
): ProviderPreset[] {
  const taken = new Set(configuredProviders(providers).map((provider) => provider.id));
  return (presets ?? []).filter((preset) => !taken.has(preset.id));
}
