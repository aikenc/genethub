import type { AgentInfo } from "@genehub/proto";

import { agentAssets, type AgentAssetId } from "../../assets/agents";
import agentConfig from "./agents.json";
import modelConfig from "./model-aliases.json";
import badgeConfig from "./runtime-badges.json";
import type {
  AgentAssetVariants,
  AgentVisualRule,
  ModelAliasRule,
  PermissionBadge,
  RuntimeBadge,
} from "./types";

export type AgentPresentation =
  | { kind: "icon"; label: string; asset: AgentAssetVariants }
  | { kind: "glyph"; label: string; glyph: string }
  | { kind: "text"; label: string };

export interface AgentAvailability {
  shortLabel: "未安装" | "不可用" | "待配置" | "未认证";
  fullLabel: string;
}

export type AgentModeKind = "permission" | "workflow" | "unknown";

const agentRules = agentConfig.agents as AgentVisualRule[];
const modelRules = modelConfig.exact as ModelAliasRule[];

export function resolveAgentPresentation(
  agent: Pick<AgentInfo, "id" | "label">,
): AgentPresentation {
  const rule = agentRules.find((candidate) => candidate.ids.includes(agent.id));
  const label = agent.label.trim() || rule?.label || agent.id;
  if (rule?.assetId && isAssetId(rule.assetId)) {
    return { kind: "icon", label, asset: agentAssets[rule.assetId] };
  }
  if (rule?.glyph) return { kind: "glyph", label, glyph: rule.glyph };
  return { kind: "text", label };
}

/** Runtime behavior that cannot be inferred safely from the generic capability
 * flags. ACP's `permissions` flag says it can ask permission; it does not make
 * Cursor's `agent / plan / ask` workflow selector a permission policy. */
export function resolveAgentProfile(agentId: string): {
  modeKind: AgentModeKind;
  startWithoutModelCatalog: boolean;
} {
  const rule = agentRules.find((candidate) => candidate.ids.includes(agentId));
  return {
    modeKind: rule?.modeKind ?? "unknown",
    // Every configured ACP Agent owns its runtime defaults even when discovery
    // returned no catalog. Unknown non-ACP Agents remain conservative.
    startWithoutModelCatalog:
      rule?.startWithoutModelCatalog ?? agentId.startsWith("acp:"),
  };
}

export function resolveAgentAvailability(
  agent: Pick<AgentInfo, "id" | "probe" | "catalog" | "auth">,
): AgentAvailability | null {
  // An agent its own CLI reports as signed out is never startable, whatever
  // the rest says: offering it would hand the first turn to a process that
  // can only fail. `unknown` is deliberately not this case — a CLI that
  // publishes no status stays usable, because guessing would hide working
  // installs.
  if (agent.auth === "unauthenticated") {
    const reason = agent.probe.state === "unavailable" ? agent.probe.reason.trim() : "";
    return {
      shortLabel: "未认证",
      fullLabel: reason || "未认证：请先完成登录或配置密钥",
    };
  }
  if (agent.probe.state === "ready") {
    return canStartAgent(agent)
      ? null
      : { shortLabel: "待配置", fullLabel: "待配置：请先配置模型服务" };
  }
  if (agent.probe.state === "notInstalled") {
    return { shortLabel: "未安装", fullLabel: "未安装" };
  }
  const reason = agent.probe.reason.trim();
  return {
    shortLabel: "不可用",
    fullLabel: reason ? `不可用：${reason}` : "不可用",
  };
}

/** A ready probe means the executable exists. Starting a turn additionally
 * needs its own sign-in intact (when the CLI will say) and either a concrete
 * catalog or an Agent whose own runtime owns defaults. */
export function canStartAgent(
  agent: Pick<AgentInfo, "id" | "probe" | "catalog" | "auth">,
): boolean {
  return (
    agent.probe.state === "ready" &&
    agent.auth !== "unauthenticated" &&
    (agent.catalog.models.length > 0 || resolveAgentProfile(agent.id).startWithoutModelCatalog)
  );
}

function isAssetId(value: string): value is AgentAssetId {
  return Object.prototype.hasOwnProperty.call(agentAssets, value);
}

export interface ModelPresentation {
  modelId: string;
  fullLabel: string;
  shortLabel: string;
  source: "scoped-map" | "global-map" | "label" | "id";
}

export function resolveModelPresentation({
  agentId,
  modelId,
  modelLabel,
}: {
  agentId: string | null;
  modelId: string;
  modelLabel?: string | null;
}): ModelPresentation {
  const scoped = modelRules.find(
    (rule) => rule.agentId === agentId && rule.modelId === modelId,
  );
  const global = modelRules.find(
    (rule) => rule.agentId === undefined && rule.modelId === modelId,
  );
  const fullLabel = modelLabel?.trim() || basename(modelId) || modelId;
  const matched = scoped ?? global;
  if (matched) {
    return {
      modelId,
      fullLabel,
      shortLabel: matched.shortLabel,
      source: scoped ? "scoped-map" : "global-map",
    };
  }
  return {
    modelId,
    fullLabel,
    shortLabel: truncateGraphemes(
      fullLabel,
      modelConfig.fallback.maxGraphemes,
      modelConfig.fallback.ellipsis,
    ),
    source: modelLabel?.trim() ? "label" : "id",
  };
}

export function resolveEffortBadge(effortId?: string | null): RuntimeBadge {
  const id = effortId?.trim() || "default";
  const efforts = badgeConfig.efforts as Record<
    string,
    { shortLabel: string; fullLabel: string }
  >;
  const known = efforts[id];
  return {
    emoji: "🤔",
    shortLabel: known?.shortLabel ?? truncateGraphemes(id, 2, ""),
    fullLabel: known?.fullLabel ?? id,
  };
}

export function resolveModeBadge({
  agentId,
  permissions,
  modeId,
  modeLabel,
}: {
  agentId: string | null;
  permissions: boolean;
  modeId?: string | null;
  modeLabel?: string | null;
}): PermissionBadge {
  const fullLabel = modeLabel?.trim() || modeId?.trim() || "默认";
  if (!permissions) {
    return {
      emoji: "⚙️",
      shortLabel: truncateGraphemes(fullLabel, 3, ""),
      fullLabel,
      risk: "unknown",
    };
  }
  const normalizedAgent = agentId?.toLocaleLowerCase() ?? "";
  const normalized = modeId?.toLocaleLowerCase() ?? "";
  const rule = badgeConfig.permissions.find(
    (candidate) =>
      candidate.agentIds.some((id) => id.toLocaleLowerCase() === normalizedAgent) &&
      candidate.ids.some((id) => id.toLocaleLowerCase() === normalized),
  );
  if (!rule) {
    return {
      emoji: "🛡️",
      shortLabel: truncateGraphemes(fullLabel, 3, ""),
      fullLabel,
      risk: "unknown",
    };
  }
  return {
    emoji: rule.emoji,
    shortLabel: rule.shortLabel,
    fullLabel: rule.fullLabel,
    risk: rule.risk as PermissionBadge["risk"],
  };
}

export function truncateGraphemes(value: string, max: number, ellipsis = "…"): string {
  const segments = segment(value);
  if (segments.length <= max) return value;
  return `${segments.slice(0, max).join("")}${ellipsis}`;
}

function segment(value: string): string[] {
  type Segmenter = {
    segment(input: string): Iterable<{ segment: string }>;
  };
  type SegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: "grapheme" },
  ) => Segmenter;
  const constructor = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!constructor) return [...value];
  return Array.from(new constructor(undefined, { granularity: "grapheme" }).segment(value), (part) =>
    part.segment,
  );
}

function basename(id: string): string {
  return id.split("/").filter(Boolean).at(-1) ?? id;
}
