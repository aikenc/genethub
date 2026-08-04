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
  shortLabel: "未安装" | "不可用";
  fullLabel: string;
}

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

export function resolveAgentAvailability(
  agent: Pick<AgentInfo, "probe">,
): AgentAvailability | null {
  if (agent.probe.state === "ready") return null;
  if (agent.probe.state === "notInstalled") {
    return { shortLabel: "未安装", fullLabel: "未安装" };
  }
  const reason = agent.probe.reason.trim();
  return {
    shortLabel: "不可用",
    fullLabel: reason ? `不可用：${reason}` : "不可用",
  };
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
    emoji: "🧠",
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
