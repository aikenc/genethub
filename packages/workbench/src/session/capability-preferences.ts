import type {
  AgentCostLevel,
  AgentInfo,
  AgentModelProfile,
  AgentRuntimePreference,
  AgentSelectionPreferences,
  AgentTagGroup,
  ModelInfo,
  SessionAgentTarget,
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
export const BUILTIN_TAG_GROUP: AgentTagGroup = {
  id: "builtin-intelligence",
  label: "智能档位",
  tags: ["Max", "Pro", "Flush"],
};

export const COST_LEVELS: ReadonlyArray<{ id: AgentCostLevel; label: string }> = [
  { id: "veryLow", label: "超低" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "veryHigh", label: "超高" },
];

export type ResolvedCapabilityRoute = {
  agent: AgentInfo;
  modelId: string | null;
  effortId: string | null;
  fast?: boolean | null;
  modeId: string | null;
  runtimeValues: Record<string, string>;
};

export type ConfiguredModelRoute = ResolvedCapabilityRoute & {
  profile: AgentModelProfile;
};

export type MediaInputModality = "image" | "video";
export type MediaInputSupport = Record<MediaInputModality, boolean>;

/** Exact machine-global model list with deterministic first-run defaults. */
export function normalizeAgentPreferences(
  stored: AgentSelectionPreferences | null | undefined,
  agents: AgentInfo[],
): AgentSelectionPreferences {
  const groups = normalizeTagGroups(stored?.tagGroups ?? []);
  const saved = stored?.modelProfiles ?? [];
  const disabledAgentIds = normalizeAgentIds(stored?.disabledAgentIds ?? []);
  const disabled = new Set(disabledAgentIds.map((agentId) => agentId.toLocaleLowerCase()));
  const discovered = agents.filter(canStartAgent).flatMap((agent) => {
    if (disabled.has(agent.id.toLocaleLowerCase())) return [];
    const models: Array<ModelInfo | null> = agent.catalog.models.length
      ? agent.catalog.models.filter((model) => !isAutoModel(model))
      : resolveAgentProfile(agent.id).startWithoutModelCatalog
        ? [null]
        : [];
    const savedForAgent = saved.filter((profile) => profile.agentId === agent.id);
    const configured = models.filter((model) =>
      savedForAgent.some(
        (profile) =>
          profile.agentId === agent.id && (profile.modelId ?? null) === (model?.id ?? null),
      ),
    );
    const selected = savedForAgent.length > 0 ? configured : models.slice(0, 3);
    return selected.map((model) => {
      const override = saved.find((profile) =>
        profile.agentId === agent.id && (profile.modelId ?? null) === (model?.id ?? null));
      const inferred = inferredModelProfile(agent, model);
      const displayName = override?.displayName?.trim();
      return {
        ...inferred,
        ...override,
        ...(displayName ? { displayName } : { displayName: undefined }),
        tags: normalizeGroupedTags(
          override?.tags?.length ? override.tags : inferred.tags,
          groups,
        ),
        cost: override?.cost ?? inferred.cost,
      };
    });
  });
  return {
    runtimes: { ...(stored?.runtimes ?? {}) },
    modelProfiles: discovered,
    ...(disabledAgentIds.length > 0 ? { disabledAgentIds } : {}),
    tagGroups: groups,
    selectedTags: normalizeGroupedTags(
      stored?.selectedTags?.length ? stored.selectedTags : ["Flush"],
      groups,
    ),
  };
}

export function isAutoModel(model: Pick<ModelInfo, "id" | "label">): boolean {
  return [model.id, model.label].some((value) =>
    value
      .trim()
      .toLocaleLowerCase()
      .split(/[^a-z0-9]+/u)
      .includes("auto"),
  );
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

export function normalizeTagGroups(groups: readonly AgentTagGroup[]): AgentTagGroup[] {
  const usedIds = new Set<string>([BUILTIN_TAG_GROUP.id.toLocaleLowerCase()]);
  const usedTags = new Set(BUILTIN_TAGS.map((tag) => tag.toLocaleLowerCase()));
  return groups.flatMap((group) => {
    const id = group.id.trim();
    const label = group.label.trim();
    if (!id || !label || usedIds.has(id.toLocaleLowerCase())) return [];
    const tags = normalizeTags(group.tags).filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (usedTags.has(key)) return false;
      usedTags.add(key);
      return true;
    });
    usedIds.add(id.toLocaleLowerCase());
    return [{ id, label, tags }];
  });
}

export function effectiveTagGroups(
  preferencesOrGroups: AgentSelectionPreferences | readonly AgentTagGroup[],
): AgentTagGroup[] {
  const groups: readonly AgentTagGroup[] = Array.isArray(preferencesOrGroups)
    ? preferencesOrGroups
    : (preferencesOrGroups as AgentSelectionPreferences).tagGroups ?? [];
  return [BUILTIN_TAG_GROUP, ...normalizeTagGroups(groups)];
}

/** De-duplicates tags and keeps at most one value from every exclusive group. */
export function normalizeGroupedTags(
  tags: readonly string[],
  preferencesOrGroups: AgentSelectionPreferences | readonly AgentTagGroup[],
): string[] {
  const groups = effectiveTagGroups(preferencesOrGroups);
  const claimed = new Set<string>();
  return normalizeTags(tags).filter((tag) => {
    const group = groups.find((candidate) =>
      candidate.tags.some((member) => tagKey(member) === tagKey(tag)),
    );
    if (!group) return true;
    if (claimed.has(group.id)) return false;
    claimed.add(group.id);
    return true;
  });
}

/** Toggle helper shared by tag assignment and selector filters. */
export function toggleGroupedTag(
  tags: readonly string[],
  tag: string,
  preferencesOrGroups: AgentSelectionPreferences | readonly AgentTagGroup[],
): string[] {
  const selected = normalizeGroupedTags(tags, preferencesOrGroups);
  const groups = effectiveTagGroups(preferencesOrGroups);
  const group = groups.find((candidate) =>
    candidate.tags.some((member) => tagKey(member) === tagKey(tag)),
  );
  const checked = selected.some((candidate) => tagKey(candidate) === tagKey(tag));
  if (checked) return selected.filter((candidate) => tagKey(candidate) !== tagKey(tag));
  const withoutGroup = group
    ? selected.filter((candidate) =>
        !group.tags.some((member) => tagKey(member) === tagKey(candidate)),
      )
    : selected;
  return normalizeGroupedTags([...withoutGroup, tag], preferencesOrGroups).slice(0, 4);
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
  return {
    ...preferences,
    selectedTags: normalizeGroupedTags(tags, preferences).slice(0, 4),
  };
}

export function withModelProfile(
  preferences: AgentSelectionPreferences,
  profile: AgentModelProfile,
): AgentSelectionPreferences {
  const next = {
    ...profile,
    tags: normalizeGroupedTags(profile.tags, preferences).slice(0, 4),
  };
  const rows = [...(preferences.modelProfiles ?? [])];
  const index = rows.findIndex(
    (row) =>
      row.agentId === next.agentId && (row.modelId ?? null) === (next.modelId ?? null),
  );
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  return {
    ...preferences,
    modelProfiles: rows,
    disabledAgentIds: (preferences.disabledAgentIds ?? []).filter(
      (agentId) => agentId.toLocaleLowerCase() !== next.agentId.toLocaleLowerCase(),
    ),
  };
}

export function withoutModelProfile(
  preferences: AgentSelectionPreferences,
  agentId: string,
  modelId?: string | null,
): AgentSelectionPreferences {
  const modelProfiles = (preferences.modelProfiles ?? []).filter(
    (profile) =>
      profile.agentId !== agentId || (profile.modelId ?? null) !== (modelId ?? null),
  );
  const hasAgentProfile = modelProfiles.some((profile) => profile.agentId === agentId);
  return {
    ...preferences,
    modelProfiles,
    disabledAgentIds: hasAgentProfile
      ? preferences.disabledAgentIds ?? []
      : normalizeAgentIds([...(preferences.disabledAgentIds ?? []), agentId]),
  };
}

export function withTagGroups(
  preferences: AgentSelectionPreferences,
  groups: readonly AgentTagGroup[],
): AgentSelectionPreferences {
  const tagGroups = normalizeTagGroups(groups);
  const basis = { ...preferences, tagGroups };
  return {
    ...basis,
    selectedTags: normalizeGroupedTags(preferences.selectedTags ?? [], tagGroups),
    modelProfiles: (preferences.modelProfiles ?? []).map((profile) => ({
      ...profile,
      tags: normalizeGroupedTags(profile.tags, tagGroups),
    })),
  };
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

/** Every live configured route matching all filter tags, cheapest first. */
export function matchingTagRoutes(
  preferences: AgentSelectionPreferences,
  tags: readonly string[],
  agents: AgentInfo[],
): ConfiguredModelRoute[] {
  const required = normalizeGroupedTags(tags, preferences);
  return (preferences.modelProfiles ?? [])
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
      return runtime ? [{ ...runtime, profile }] : [];
    })
    .sort(
      (left, right) =>
        costRank(left.profile.cost) - costRank(right.profile.cost) ||
        left.profile.agentId.localeCompare(right.profile.agentId) ||
        (left.profile.modelId ?? "").localeCompare(right.profile.modelId ?? ""),
    );
}

/** Lowest-cost route whose configured tags contain every requested tag. */
export function resolveTagRoute(
  preferences: AgentSelectionPreferences,
  tags: readonly string[],
  agents: AgentInfo[],
): ResolvedCapabilityRoute | null {
  return matchingTagRoutes(preferences, tags, agents)[0] ?? null;
}

export function routeTarget(route: ResolvedCapabilityRoute): SessionAgentTarget {
  return {
    agentId: route.agent.id,
    ...(route.modelId ? { modelId: route.modelId } : {}),
    ...(route.modeId ? { modeId: route.modeId } : {}),
    ...(route.effortId ? { effortId: route.effortId } : {}),
    ...(route.fast ? { fast: true } : {}),
    runtimeValues: route.runtimeValues,
  };
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

export function configuredMediaInputSupport(
  preferences: AgentSelectionPreferences,
  agentId: string | null | undefined,
  modelId: string | null | undefined,
): MediaInputSupport {
  const profile = (preferences.modelProfiles ?? []).find(
    (candidate) =>
      candidate.agentId === agentId && (candidate.modelId ?? null) === (modelId ?? null),
  );
  return {
    image: profile?.tags.some((tag) => tagKey(tag) === tagKey(IMAGE_TAG)) ?? false,
    video: profile?.tags.some((tag) => tagKey(tag) === tagKey(VIDEO_TAG)) ?? false,
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
  const fast = model?.supportsFast ? (remembered?.fast ?? false) : false;
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
    fast,
    modeId,
    runtimeValues,
  };
}

function costRank(cost: AgentCostLevel | undefined): number {
  const rank = COST_LEVELS.findIndex((entry) => entry.id === (cost ?? "medium"));
  return rank < 0 ? 2 : rank;
}

function normalizeAgentIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  return agentIds.flatMap((raw) => {
    const agentId = raw.trim();
    const key = agentId.toLocaleLowerCase();
    if (!agentId || seen.has(key)) return [];
    seen.add(key);
    return [agentId];
  });
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

const tagKey = (tag: string): string => tag.toLocaleLowerCase();
