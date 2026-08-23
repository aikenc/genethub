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

/**
 * Where a thinking level sits on the dial, rather than which emoji it gets.
 *
 * `auto` is the Agent's own default and any level we have never heard of:
 * both are levels we cannot place, and guessing a position for them would
 * claim knowledge the catalog does not have. `off` is a placed level — the
 * bottom of the dial — and reads differently from not knowing.
 */
export type EffortLevel = "auto" | "off" | 1 | 2 | 3 | 4 | 5;

export interface EffortBadge {
  level: EffortLevel;
  shortLabel: string;
  fullLabel: string;
}
