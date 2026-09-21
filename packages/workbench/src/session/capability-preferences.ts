import type {
  AgentCapability,
  AgentInfo,
  AgentRuntimePreference,
  AgentSelectionPreferences,
  PreferredAgentModel,
} from "@genehub/proto";

import {
  canStartAgent,
  resolveAgentProfile,
  resolveModeBadge,
} from "../presentation/catalog/resolve";

export const CAPABILITIES: ReadonlyArray<{
  id: AgentCapability;
  label: string;
  shortDescription: string;
}> = [
  { id: "planning", label: "规划", shortDescription: "拆解目标、比较方案与组织路径" },
  { id: "coding", label: "编码", shortDescription: "实现、修改、调试与验证代码" },
  { id: "multimodal", label: "多模态理解", shortDescription: "理解图片、视频与混合内容" },
];

export type ResolvedCapabilityRoute = {
  agent: AgentInfo;
  modelId: string | null;
  effortId: string | null;
  modeId: string | null;
  runtimeValues: Record<string, string>;
};

/**
 * Materializes a first-run proposal only while the daemon says this machine
 * has never saved capability preferences. A saved empty list stays empty.
 */
export function normalizeAgentPreferences(
  stored: AgentSelectionPreferences | null | undefined,
  agents: AgentInfo[],
): AgentSelectionPreferences {
  if (stored) {
    return {
      capabilities: {
        planning: [...stored.capabilities.planning],
        coding: [...stored.capabilities.coding],
        multimodal: [...stored.capabilities.multimodal],
      },
      selectedCapability: stored.selectedCapability,
      runtimes: { ...stored.runtimes },
    };
  }

  const ready = agents
    .filter(canStartAgent)
    .sort((left, right) => Number(right.builtin) - Number(left.builtin));
  return {
    capabilities: {
      planning: ready.flatMap((agent) => routeFor(agent, "planning")).slice(0, 5),
      coding: ready.flatMap((agent) => routeFor(agent, "coding")).slice(0, 5),
      multimodal: ready.flatMap((agent) => routeFor(agent, "multimodal")).slice(0, 5),
    },
    selectedCapability: "planning",
    runtimes: {},
  };
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
  const unique = routes.filter(
    (route, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.agentId === route.agentId && candidate.modelId === route.modelId,
      ) === index,
  );
  return {
    ...preferences,
    capabilities: { ...preferences.capabilities, [capability]: unique.slice(0, 5) },
  };
}

export function withSelectedCapability(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
): AgentSelectionPreferences {
  return { ...preferences, selectedCapability: capability };
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

/** Selects the first currently usable exact Agent + model route. */
export function resolveCapabilityRoute(
  preferences: AgentSelectionPreferences,
  capability: AgentCapability,
  agents: AgentInfo[],
): ResolvedCapabilityRoute | null {
  for (const preferred of routesForCapability(preferences, capability)) {
    const agent = agents.find(
      (candidate) => candidate.id === preferred.agentId && canStartAgent(candidate),
    );
    if (!agent) continue;
    const resolved = resolveAgentRuntime(preferences, agent, preferred.modelId);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveAgentRuntime(
  preferences: AgentSelectionPreferences,
  agent: AgentInfo,
  preferredModelId?: string | null,
): ResolvedCapabilityRoute | null {
  const models = agent.catalog.models ?? [];
  const opaque =
    models.length === 0 && resolveAgentProfile(agent.id).startWithoutModelCatalog;
  const model = preferredModelId
    ? models.find((candidate) => candidate.id === preferredModelId)
    : models.find((candidate) => candidate.id === agent.catalog.defaultModel) ??
      models[0];
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

/** Best-effort label for a historical session that stores only its exact route. */
export function capabilityForRoute(
  preferences: AgentSelectionPreferences,
  agentId: string | null,
  modelId: string | null,
): AgentCapability {
  const ordered = [
    preferences.selectedCapability,
    ...CAPABILITIES.map((candidate) => candidate.id).filter(
      (capability) => capability !== preferences.selectedCapability,
    ),
  ];
  for (const capability of ordered) {
    if (
      routesForCapability(preferences, capability).some(
        (route) =>
          route.agentId === agentId &&
          (route.modelId === modelId || route.modelId === undefined || modelId === null),
      )
    ) {
      return capability;
    }
  }
  return preferences.selectedCapability;
}

export function capabilityLabel(capability: AgentCapability): string {
  return CAPABILITIES.find((candidate) => candidate.id === capability)?.label ?? capability;
}

function routeFor(agent: AgentInfo, capability: AgentCapability): PreferredAgentModel[] {
  const models = agent.catalog.models ?? [];
  if (models.length === 0) return [{ agentId: agent.id }];
  const defaultModel =
    models.find((model) => model.id === agent.catalog.defaultModel) ?? models[0];
  const model =
    capability === "planning"
      ? models.find((candidate) => candidate.reasoning) ?? defaultModel
      : capability === "multimodal"
        ? models.find(
            (candidate) =>
              candidate.inputModalities?.includes("image") ||
              candidate.inputModalities?.includes("video"),
          )
        : defaultModel;
  return model ? [{ agentId: agent.id, modelId: model.id }] : [];
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
    modes.find((mode) => mode.id === agent.catalog.defaultMode)?.id ??
    modes[0]?.id ??
    null
  );
}
