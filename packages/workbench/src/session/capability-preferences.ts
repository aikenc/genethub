import type {
  AgentCapability,
  AgentCostLevel,
  AgentInfo,
  AgentModelProfile,
  AgentRuntimePreference,
  AgentSelectionPreferences,
  ModelInfo,
  PreferredAgentModel,
  TimelineItem,
} from "@genehub/proto";

import {
  canStartAgent,
  resolveAgentProfile,
  resolveModeBadge,
} from "../presentation/catalog/resolve";

export const BUILTIN_TAGS = ["Max", "Pro", "Flush", "视频理解", "图片理解"] as const;
export type BuiltinAgentTag = (typeof BUILTIN_TAGS)[number];
export const IMAGE_TAG: BuiltinAgentTag = "图片理解";
export const VIDEO_TAG: BuiltinAgentTag = "视频理解";

export const COST_LEVELS: ReadonlyArray<{ id: AgentCostLevel; label: string }> = [
  { id: "veryLow", label: "超低" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "veryHigh", label: "超高" },
];

/** Kept only for reading old drafts and role.v2-era surfaces. */
export const CAPABILITIES: ReadonlyArray<{
  id: AgentCapability;
  label: string;
  shortDescription: string;
}> = [
  { id: "planning", label: "规划", shortDescription: "" },
  { id: "coding", label: "编码", shortDescription: "" },
  { id: "multimodal", label: "多模态理解", shortDescription: "" },
];

export type ResolvedCapabilityRoute = {
  agent: AgentInfo;
  modelId: string | null;
  effortId: string | null;
  modeId: string | null;
  runtimeValues: Record<string, string>;
};

export type MediaInputModality = "image" | "video";
export type MediaInputSupport = Record<MediaInputModality, boolean>;

const EMPTY_CAPABILITIES = { planning: [], coding: [], multimodal: [] };

/** Complete machine-global Agent/model table with deterministic first-run defaults. */
export function normalizeAgentPreferences(
  stored: AgentSelectionPreferences | null | undefined,
  agents: AgentInfo[],
): AgentSelectionPreferences {
  const saved = stored?.modelProfiles ?? [];
  const discovered = agents.flatMap((agent) => {
    const models: Array<ModelInfo | null> = agent.catalog.models.length
      ? agent.catalog.models
      : resolveAgentProfile(agent.id).startWithoutModelCatalog
        ? [null]
        : [];
    return models.map((model) => {
      const override = saved.find(
        (profile) =>
          profile.agentId === agent.id && (profile.modelId ?? null) === (model?.id ?? null),
      );
      const inferred = inferredModelProfile(agent, model);
      return {
        ...inferred,
        ...override,
        tags: normalizeTags(override?.tags?.length ? override.tags : inferred.tags),
        cost: override?.cost ?? inferred.cost,
      };
    });
  });
  const stale = saved.filter(
    (profile) =>
      !discovered.some(
        (row) =>
          row.agentId === profile.agentId &&
          (row.modelId ?? null) === (profile.modelId ?? null),
      ),
  );
  return {
    capabilities: stored?.capabilities ?? EMPTY_CAPABILITIES,
    selectedCapability: stored?.selectedCapability ?? "coding",
    runtimes: { ...(stored?.runtimes ?? {}) },
    modelProfiles: [
      ...discovered,
      ...stale.map((row) => ({ ...row, tags: normalizeTags(row.tags) })),
    ],
    selectedTags: normalizeTags(stored?.selectedTags?.length ? stored.selectedTags : ["Flush"]),
  };
}

export function inferredModelProfile(
  agent: AgentInfo,
  model: ModelInfo | null,
): AgentModelProfile {
  const identity = `${agent.id} ${agent.label} ${model?.id ?? ""} ${model?.label ?? ""}`.toLowerCase();
  const tags: string[] = [
    identity.includes("max") ? "Max" : identity.includes("pro") ? "Pro" : "Flush",
  ];
  if (agent.capabilities?.attachments && model?.inputModalities?.includes("image")) {
    tags.push(IMAGE_TAG);
  }
  if (agent.capabilities?.attachments && model?.inputModalities?.includes("video")) {
    tags.push(VIDEO_TAG);
  }
  return {
    agentId: agent.id,
    ...(model ? { modelId: model.id } : {}),
    tags,
    cost: identity.includes("flush") || identity.includes("flash") ? "low" : "medium",
  };
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags.flatMap((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const builtin = BUILTIN_TAGS.find(
      (candidate) => candidate.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
    );
    const tag = builtin ?? trimmed;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
}

/** Media tags are daemon-owned routing requirements, but the composer mirrors
 * them before send so its affordances describe the route that will actually
 * be selected. Unknown MIME types deliberately add no capability claim. */
export function mediaTagsForMimes(mimes: readonly string[]): string[] {
  const lower = mimes.map((mime) => mime.toLocaleLowerCase());
  return [
    ...(lower.some((mime) => mime.startsWith("image/")) ? [IMAGE_TAG] : []),
    ...(lower.some((mime) => mime.startsWith("video/")) ? [VIDEO_TAG] : []),
  ];
}

/** Reconstructs automatic media requirements from the visible timeline. The
 * Session summary remains the durable source for history outside this window. */
export function mediaTagsForTimeline(items: readonly TimelineItem[]): string[] {
  return mediaTagsForMimes(
    items.flatMap((item) => {
      if (item.type === "userMessage") {
        return item.attachments.map((attachment) => attachment.mime);
      }
      if (item.type === "toolCall") {
        return item.images.map((image) => image.mime);
      }
      return [];
    }),
  );
}

/** Converts protocol maps (whose generated index values are optional) into
 * the exact in-memory runtime map used by the Workbench. */
export function definedRuntimeValues(
  values: Record<string, string | undefined> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function availableAgentTags(preferences: AgentSelectionPreferences): string[] {
  return normalizeTags([
    ...BUILTIN_TAGS,
    ...(preferences.modelProfiles ?? []).flatMap((profile) => profile.tags),
  ]);
}

export function withSelectedTags(
  preferences: AgentSelectionPreferences,
  tags: readonly string[],
): AgentSelectionPreferences {
  return { ...preferences, selectedTags: normalizeTags(tags).slice(0, 4) };
}

export function withModelProfile(
  preferences: AgentSelectionPreferences,
  profile: AgentModelProfile,
): AgentSelectionPreferences {
  const next = { ...profile, tags: normalizeTags(profile.tags).slice(0, 4) };
  const rows = [...(preferences.modelProfiles ?? [])];
  const index = rows.findIndex(
    (row) =>
      row.agentId === next.agentId && (row.modelId ?? null) === (next.modelId ?? null),
  );
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  return { ...preferences, modelProfiles: rows };
}

export function withRuntimePreference(
  preferences: AgentSelectionPreferences,
  agentId: string,
  change: Partial<AgentRuntimePreference>,
): AgentSelectionPreferences {
  const before = preferences.runtimes[agentId] ?? { runtimeValues: {} };
  return {
    ...preferences,
    runtimes: {
      ...preferences.runtimes,
      [agentId]: {
        ...before,
        ...change,
        runtimeValues: change.runtimeValues
          ? { ...before.runtimeValues, ...change.runtimeValues }
          : before.runtimeValues,
      },
    },
  };
}

/** Lowest-cost route whose configured tags contain every requested tag. */
export function resolveTagRoute(
  preferences: AgentSelectionPreferences,
  tags: readonly string[],
  agents: AgentInfo[],
): ResolvedCapabilityRoute | null {
  const required = normalizeTags(tags);
  const candidates = (preferences.modelProfiles ?? [])
    .flatMap((profile) => {
      const agent = agents.find(
        (candidate) => candidate.id === profile.agentId && canStartAgent(candidate),
      );
      if (!agent) return [];
      if (
        !required.every((tag) =>
          profile.tags.some(
            (offered) => offered.toLocaleLowerCase() === tag.toLocaleLowerCase(),
          ),
        )
      ) {
        return [];
      }
      const runtime = resolveAgentRuntime(preferences, agent, profile.modelId);
      return runtime ? [{ profile, runtime }] : [];
    })
    .sort(
      (left, right) =>
        costRank(left.profile.cost) - costRank(right.profile.cost) ||
        left.profile.agentId.localeCompare(right.profile.agentId) ||
        (left.profile.modelId ?? "").localeCompare(right.profile.modelId ?? ""),
    );
  return candidates[0]?.runtime ?? null;
}

export function tagMediaInputSupport(
  preferences: AgentSelectionPreferences,
  tags: readonly string[],
  agents: AgentInfo[],
): MediaInputSupport {
  return {
    image: Boolean(resolveTagRoute(preferences, [...tags, IMAGE_TAG], agents)),
    video: Boolean(resolveTagRoute(preferences, [...tags, VIDEO_TAG], agents)),
  };
}

/** Unknown third-party modality declarations remain unsupported. */
export function mediaInputSupport(
  agent: AgentInfo | null | undefined,
  modelId?: string | null,
): MediaInputSupport {
  if (!agent?.capabilities?.attachments) return { image: false, video: false };
  const model = modelId
    ? agent.catalog.models.find((candidate) => candidate.id === modelId)
    : agent.catalog.models.find((candidate) => candidate.id === agent.catalog.defaultModel) ??
      agent.catalog.models[0];
  return {
    image: model?.inputModalities?.includes("image") ?? false,
    video: model?.inputModalities?.includes("video") ?? false,
  };
}

export function resolveAgentRuntime(
  preferences: AgentSelectionPreferences,
  agent: AgentInfo,
  preferredModelId?: string | null,
): ResolvedCapabilityRoute | null {
  const models = agent.catalog.models ?? [];
  const opaque = models.length === 0 && resolveAgentProfile(agent.id).startWithoutModelCatalog;
  const model = preferredModelId
    ? models.find((candidate) => candidate.id === preferredModelId)
    : models.find((candidate) => candidate.id === agent.catalog.defaultModel) ?? models[0];
  if (!opaque && !model) return null;
  if (preferredModelId && !opaque && model?.id !== preferredModelId) return null;

  const remembered = preferences.runtimes[agent.id];
  const effortId = validEffort(remembered?.effortId, model?.efforts ?? []);
  const modeId = validMode(agent, remembered?.modeId);
  const runtimeValues = Object.fromEntries(
    (agent.catalog.runtimeAxes ?? []).flatMap((axis) => {
      const rememberedValue = remembered?.runtimeValues[axis.id];
      const valueId =
        (rememberedValue && axis.values.some((value) => value.id === rememberedValue)
          ? rememberedValue
          : undefined) ??
        (axis.defaultValue && axis.values.some((value) => value.id === axis.defaultValue)
          ? axis.defaultValue
          : undefined) ??
        axis.values[0]?.id;
      return valueId ? [[axis.id, valueId]] : [];
    }),
  );
  return {
    agent,
    modelId: model?.id ?? preferredModelId ?? null,
    effortId,
    modeId,
    runtimeValues,
  };
}

// Compatibility adapters for old surfaces while stored capability drafts are
// migrated to their equivalent built-in tag. Ordered lists are never used.
export function resolveCapabilityRoute(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
  agents: AgentInfo[],
  requiredMedia: readonly MediaInputModality[] = [],
): ResolvedCapabilityRoute | null {
  return resolveTagRoute(
    preferences,
    [
      legacyTag(capability),
      ...requiredMedia.map((medium) => (medium === "image" ? IMAGE_TAG : VIDEO_TAG)),
    ],
    agents,
  );
}

export function capabilityMediaInputSupport(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
  agents: AgentInfo[],
): MediaInputSupport {
  return tagMediaInputSupport(preferences, [legacyTag(capability)], agents);
}

export function routesForCapability(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
): PreferredAgentModel[] {
  return preferences.capabilities[capability];
}

export function withCapabilityRoutes(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
  routes: PreferredAgentModel[],
): AgentSelectionPreferences {
  return {
    ...preferences,
    capabilities: { ...preferences.capabilities, [capability]: routes.slice(0, 5) },
  };
}

export function withSelectedCapability(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
): AgentSelectionPreferences {
  return { ...preferences, selectedCapability: capability, selectedTags: [legacyTag(capability)] };
}

export function capabilityForRoute(
  preferences: AgentSelectionPreferences,
  agentId: string | null,
  modelId: string | null,
): AgentCapability {
  const profile = (preferences.modelProfiles ?? []).find(
    (row) => row.agentId === agentId && (row.modelId ?? null) === modelId,
  );
  if (profile?.tags.some((tag) => tag === IMAGE_TAG || tag === VIDEO_TAG)) return "multimodal";
  if (profile?.tags.includes("Pro") || profile?.tags.includes("Max")) return "planning";
  return "coding";
}

export function capabilityLabel(capability: AgentCapability): string {
  return CAPABILITIES.find((candidate) => candidate.id === capability)?.label ?? capability;
}

function legacyTag(capability: AgentCapability): BuiltinAgentTag {
  if (capability === "planning") return "Pro";
  if (capability === "multimodal") return IMAGE_TAG;
  return "Flush";
}

function costRank(cost: AgentCostLevel | undefined): number {
  const rank = COST_LEVELS.findIndex((entry) => entry.id === (cost ?? "medium"));
  return rank < 0 ? 2 : rank;
}

function validEffort(remembered: string | undefined, efforts: string[]): string | null {
  if (remembered && efforts.includes(remembered)) return remembered;
  if (efforts.includes("high")) return "high";
  if (efforts.length === 0) return null;
  const upperMiddle = Math.min(efforts.length - 1, Math.floor((efforts.length * 2) / 3));
  return efforts[upperMiddle] ?? null;
}

function validMode(agent: AgentInfo, remembered: string | undefined): string | null {
  const modes = agent.catalog.modes ?? [];
  if (remembered && modes.some((mode) => mode.id === remembered)) return remembered;
  const permissionAxis =
    Boolean(agent.capabilities?.permissions) &&
    resolveAgentProfile(agent.id).modeKind === "permission";
  if (permissionAxis) {
    const unrestricted = modes.find(
      (mode) =>
        resolveModeBadge({
          agentId: agent.id,
          permissions: true,
          modeId: mode.id,
          modeLabel: mode.label,
        }).risk === "unrestricted",
    );
    if (unrestricted) return unrestricted.id;
  }
  return (
    modes.find((mode) => mode.id === agent.catalog.defaultMode)?.id ?? modes[0]?.id ?? null
  );
}
