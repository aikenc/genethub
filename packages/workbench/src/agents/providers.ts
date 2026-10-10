import type { ProviderInfo } from "@genehub/proto";

/**
 * A starting point for "添加 provider": it fills in the id, the address and the
 * protocol so nobody has to look them up, and that is all it does. What the
 * provider is stays the daemon's answer (`settings.providers`); any other id
 * works too, with an address the person types.
 *
 * Mirrors the providers the daemon ships an address for (`provider.rs`). A
 * provider added from here is sent with the same address the daemon would have
 * used, so the two cannot disagree about where a key goes.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  dialect: "openai" | "anthropic";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", dialect: "openai" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", dialect: "openai" },
  {
    id: "qwen",
    label: "千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    dialect: "openai",
  },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", dialect: "openai" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", dialect: "openai" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", dialect: "anthropic" },
];

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

/** The presets not already in the list. */
export function presetsToAdd(providers: readonly ProviderInfo[] | undefined): ProviderPreset[] {
  const taken = new Set(configuredProviders(providers).map((provider) => provider.id));
  return PROVIDER_PRESETS.filter((preset) => !taken.has(preset.id));
}
