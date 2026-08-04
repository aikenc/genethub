export interface AgentVisualRule {
  ids: string[];
  label: string;
  assetId?: string;
  glyph?: string;
  /** Whether a mode picker changes access policy or the Agent's workflow. */
  modeKind?: "permission" | "workflow" | "unknown";
  /** Some CLIs own their model choice and deliberately expose no pre-session catalog. */
  startWithoutModelCatalog?: boolean;
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
