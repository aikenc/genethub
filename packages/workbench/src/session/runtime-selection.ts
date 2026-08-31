import type { AgentInfo, ModeInfo, ModelInfo } from "@genehub/proto";

import { defaultAgent } from "./store";

export interface RuntimeSelection {
  current: AgentInfo | undefined;
  agents: AgentInfo[];
  model: ModelInfo | undefined;
  modelAvailable: boolean;
  mode: ModeInfo | undefined;
  modeAvailable: boolean;
  effortId: string | null;
  runtimeValues: Record<string, string>;
}

/** Resolve exactly what the footer and the settings panel describe.
 *
 * A historical model or mode can disappear from a dynamic catalog. Keep its
 * real id visible instead of silently presenting the new default as if the
 * session had switched itself.
 */
export function resolveRuntimeSelection({
  agents,
  agentId,
  modelId,
  modeId,
  effortId,
  runtimeValues,
}: {
  agents: AgentInfo[];
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  runtimeValues?: Record<string, string> | null;
}): RuntimeSelection {
  const ready = agents.filter((agent) => agent.probe.state === "ready");
  const selected = agents.find((agent) => agent.id === agentId);
  const removed = agentId && !selected ? removedAgent(agentId) : undefined;
  const current = selected ?? removed ?? defaultAgent(agents) ?? ready[0];
  const catalogModel = current?.catalog.models.find((candidate) => candidate.id === modelId);
  const fallbackModel =
    current?.catalog.models.find((candidate) => candidate.id === current.catalog.defaultModel) ??
    current?.catalog.models[0];
  const missingModel =
    modelId && !catalogModel
      ? { id: modelId, label: modelId, contextWindow: undefined, reasoning: false, efforts: [] }
      : undefined;
  const model = catalogModel ?? missingModel ?? fallbackModel;
  const catalogMode = current?.catalog.modes.find((candidate) => candidate.id === modeId);
  const fallbackMode =
    current?.catalog.modes.find((candidate) => candidate.id === current.catalog.defaultMode) ??
    current?.catalog.modes[0];
  const missingMode =
    modeId && !catalogMode ? { id: modeId, label: modeId, description: undefined } : undefined;
  const resolvedRuntimeValues = Object.fromEntries(
    (current?.catalog.runtimeAxes ?? []).flatMap((axis) => {
      const selectedValue = runtimeValues?.[axis.id];
      const valueId =
        (selectedValue && axis.values.some((value) => value.id === selectedValue)
          ? selectedValue
          : undefined) ??
        (axis.defaultValue && axis.values.some((value) => value.id === axis.defaultValue)
          ? axis.defaultValue
          : undefined) ??
        axis.values[0]?.id;
      return valueId ? [[axis.id, valueId]] : [];
    }),
  );

  return {
    current,
    agents: removed ? [removed, ...agents] : agents,
    model,
    modelAvailable: Boolean(catalogModel ?? (!modelId && fallbackModel)),
    mode: catalogMode ?? missingMode ?? fallbackMode,
    modeAvailable: Boolean(catalogMode ?? (!modeId && fallbackMode)),
    effortId: effortId ?? current?.catalog.defaultEffort ?? null,
    runtimeValues: resolvedRuntimeValues,
  };
}

/** Keep a historical/custom Agent honest after it has been removed from the
 * daemon configuration. Falling through to the default used to relabel old
 * sessions as Codex or Genet. */
function removedAgent(id: string): AgentInfo {
  return {
    id,
    label: id,
    builtin: false,
    probe: { state: "unavailable", reason: "已从当前 Agent 配置中移除" },
    capabilities: {
      interrupt: false,
      setModel: false,
      setEffort: false,
      setMode: false,
      permissions: false,
      resume: false,
      fork: false,
      attachments: false,
    },
    catalog: {
      models: [],
      modes: [],
      commands: [],
      runtimeAxes: undefined,
      defaultModel: undefined,
      defaultMode: undefined,
      defaultEffort: undefined,
    },
    // Gone from the daemon, so there is nothing to probe, sign in, or guide:
    // the fields below exist so the row renders, not because anyone can act.
    platform: "linux",
    version: undefined,
    auth: "unknown",
    setup: { install: [] },
  };
}
