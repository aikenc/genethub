import type { AgentInfo, ModelInfo } from "@genehub/proto";

import { agentAssets, type AgentAssetId } from "../../assets/agents";
import agentConfig from "./agents.json";
import modelConfig from "./model-aliases.json";
import badgeConfig from "./runtime-badges.json";
import type {
  AgentAssetVariants,
  AgentVisualRule,
  EffortBadge,
  EffortLevel,
  ModelAliasRule,
  ModelFamilyRule,
  PermissionBadge,
} from "./types";

export type AgentPresentation =
  | { kind: "icon"; label: string; asset: AgentAssetVariants }
  | { kind: "glyph"; label: string; glyph: string }
  | { kind: "text"; label: string };

export interface AgentAvailability {
  shortLabel: "未安装" | "不可用" | "待配置";
  fullLabel: string;
}

export type AgentModeKind = "permission" | "workflow" | "unknown";

const agentRules = agentConfig.agents as AgentVisualRule[];
const modelRules = modelConfig.exact as ModelAliasRule[];
const modelFamilies = (modelConfig.families ?? []) as ModelFamilyRule[];
const ignorePrefixes = (modelConfig.ignorePrefixes ?? []) as string[];

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
  agent: Pick<AgentInfo, "id" | "probe" | "catalog">,
): AgentAvailability | null {
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
 * needs either a concrete catalog or an Agent whose own runtime owns defaults. */
export function canStartAgent(
  agent: Pick<AgentInfo, "id" | "probe" | "catalog">,
): boolean {
  return (
    agent.probe.state === "ready" &&
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
  source: "scoped-map" | "global-map" | "family-map" | "label" | "id";
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
  const idKey = basename(modelId);
  const scoped = modelRules.find(
    (rule) =>
      rule.agentId === agentId && (rule.modelId === modelId || rule.modelId === idKey),
  );
  const global = modelRules.find(
    (rule) =>
      rule.agentId === undefined && (rule.modelId === modelId || rule.modelId === idKey),
  );
  const fullLabel = modelLabel?.trim() || idKey || modelId;
  const matched = scoped ?? global;
  if (matched) {
    return {
      modelId,
      fullLabel,
      shortLabel: matched.shortLabel,
      source: scoped ? "scoped-map" : "global-map",
    };
  }
  const familyLabel = resolveFamilyShortLabel(modelId);
  if (familyLabel) {
    return {
      modelId,
      fullLabel,
      shortLabel: familyLabel,
      source: "family-map",
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

/**
 * Compact chip text for a well-known family, regardless of which Agent listed
 * it. Vendor prefixes and a trailing `[1m]` window stay out of the chip; the
 * wire id is unchanged.
 */
export function resolveFamilyShortLabel(modelId: string): string | null {
  let name = basename(modelId);
  const window = takeWindowMarker(name);
  if (window) name = window.body;
  name = stripIgnorePrefix(name);
  const tokens = name.split(/[-_]/).filter(Boolean);
  if (tokens.length === 0) return null;
  const matched = matchFamily(tokens[0]!);
  if (!matched) return null;
  const rest = matched.rest.length > 0 ? matched.rest : tokens.slice(1);
  let label = matched.shortLabel;
  if (matched.attached && rest.length > 0) {
    const head = rest[0]!;
    const tail = rest.slice(1);
    label = `${matched.shortLabel}${isVersionPart(head) ? head : titleModelToken(head)}`;
    if (tail.length > 0) {
      label += tail.every(isVersionPart)
        ? ` ${tail.join(".")}`
        : ` ${tail.map(titleModelToken).join(" ")}`;
    }
  } else if (rest.length > 0) {
    label += rest.every(isVersionPart)
      ? ` ${rest.join(".")}`
      : ` ${rest.map(titleModelToken).join(" ")}`;
  }
  return window ? `${label} · ${window.marker}` : label;
}

function matchFamily(
  first: string,
): { shortLabel: string; rest: string[]; attached: boolean } | null {
  const lower = first.toLocaleLowerCase();
  const exact = modelFamilies.find((family) => family.id === lower);
  if (exact) return { shortLabel: exact.shortLabel, rest: [], attached: false };
  const attached = modelFamilies.find((family) => {
    if (!family.attached || !lower.startsWith(family.id) || lower.length <= family.id.length) {
      return false;
    }
    return /^\d/.test(lower.slice(family.id.length));
  });
  if (!attached) return null;
  return {
    shortLabel: attached.shortLabel,
    rest: [first.slice(attached.id.length)],
    attached: true,
  };
}

function stripIgnorePrefix(name: string): string {
  const lower = name.toLocaleLowerCase();
  const prefix = ignorePrefixes.find((candidate) =>
    lower.startsWith(`${candidate.toLocaleLowerCase()}-`),
  );
  return prefix ? name.slice(prefix.length + 1) : name;
}

function takeWindowMarker(name: string): { body: string; marker: string } | null {
  const match = /\[([\d.]+)([mk])\]$/i.exec(name);
  if (!match || match.index === undefined) return null;
  return {
    body: name.slice(0, match.index),
    marker: `${match[1]}${match[2]!.toUpperCase()}`,
  };
}

function isVersionPart(token: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(token);
}

function titleModelToken(token: string): string {
  if (/^v\d/i.test(token) || (/^[a-z]\d/i.test(token) && token.length <= 4)) {
    return token.toUpperCase();
  }
  return `${token.charAt(0).toUpperCase()}${token.slice(1).toLocaleLowerCase()}`;
}

export function resolveEffortBadge(effortId?: string | null): EffortBadge {
  const id = effortId?.trim() || "default";
  const efforts = badgeConfig.efforts as Record<
    string,
    { shortLabel: string; fullLabel: string; level: EffortLevel }
  >;
  const known = efforts[id];
  return {
    level: known?.level ?? "auto",
    shortLabel: known?.shortLabel ?? truncateGraphemes(id, 2, ""),
    fullLabel: known?.fullLabel ?? id,
  };
}

export interface ModelTraits {
  reasoning: boolean;
  /** Whether images can go into this model's context. */
  multimodal: boolean;
}

/**
 * The two things about a model that a one-line row can still show.
 *
 * `reasoning` is the model's own answer, carried on `ModelInfo`. Vision is not
 * on the wire at all — no provider list says it, and neither Claude Code nor
 * Codex reports it through their catalogs — so it is read from the model's
 * name against a curated list of families that have it. The list is only ever
 * allowed to add the icon: an unlisted model shows nothing, which reads as
 * "not known to take images" rather than as a promise that it cannot.
 */
export function resolveModelTraits(
  model: Pick<ModelInfo, "id" | "label" | "reasoning">,
): ModelTraits {
  const hints = modelConfig.multimodalHints as string[];
  const haystack = `${model.id} ${model.label ?? ""}`.toLocaleLowerCase();
  return {
    reasoning: model.reasoning,
    multimodal: hints.some((hint) => haystack.includes(hint)),
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
