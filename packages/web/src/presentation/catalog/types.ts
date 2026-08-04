export interface AgentVisualRule {
  ids: string[];
  label: string;
  assetId?: string;
  glyph?: string;
}

export interface AgentAssetVariants {
  default: string;
  light?: string;
  dark?: string;
  surface?: "plain" | "light";
}

export interface ModelAliasRule {
  agentId?: string;
  modelId: string;
  shortLabel: string;
}

export interface RuntimeBadge {
  emoji: string;
  shortLabel: string;
  fullLabel: string;
}

export interface PermissionBadge extends RuntimeBadge {
  risk: "restricted" | "prompted" | "write" | "unrestricted" | "unknown";
}
