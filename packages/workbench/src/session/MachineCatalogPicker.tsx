import type {
  AgentInfo,
  AgentSelectionPreferences,
  WorkspaceInfo,
} from "@genehub/proto";
import { useEffect, useRef, useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import { resolveAgentPresentation } from "../presentation/catalog/resolve";
import { WorkspaceIcon } from "../workspace/WorkspaceIcon";
import { buildAgentSpaceTree, flattenAgentSpaceTree } from "../workspace/agent-space-tree";
import {
  availableAgentTags,
  normalizeAgentPreferences,
  normalizeTags,
  resolveTagRoute,
  type ResolvedCapabilityRoute,
} from "./capability-preferences";

export interface MachineOption {
  /** Daemon identity. Unlike routeId, this is stable across connection paths. */
  id: string;
  /** Host-owned locator used to open the machine. */
  routeId: string;
  label: string;
  kind: "local" | "remote";
  online?: boolean;
}

export interface MachineCatalog {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  /** Machine-global routing belongs to the target machine, never the workspace. */
  agentPreferences?: AgentSelectionPreferences | null;
}

/** Stand-in for the machine on screen when the host cannot name others. */
export const CURRENT_MACHINE: MachineOption = {
  id: "current",
  routeId: "current",
  label: "当前机器",
  kind: "local",
  online: true,
};

/**
 * The machine + workspace + tag picking state shared by Fork and Forward:
 * the machine grid drives a catalog load, and switching machines re-seeds the
 * workspace/tag choices from what the target actually has. Presentational
 * pieces below stay dumb so each dialog composes only the fieldsets it needs.
 */
export function useMachineCatalog({
  sourceMachine,
  sourceCatalog,
  sourceWorkspaceId,
  sourceTags,
  listMachines,
  loadCatalog,
}: {
  sourceMachine: MachineOption;
  sourceCatalog: MachineCatalog;
  sourceWorkspaceId: string;
  sourceTags?: string[];
  listMachines?(): Promise<MachineOption[]>;
  loadCatalog?(machine: MachineOption): Promise<MachineCatalog>;
}) {
  const [machines, setMachines] = useState([sourceMachine]);
  const [selectedMachineId, setSelectedMachineId] = useState(sourceMachine.id);
  const [catalog, setCatalog] = useState<MachineCatalog>(sourceCatalog);
  const [workspaceId, setWorkspaceId] = useState(sourceWorkspaceId);
  const sourcePreferences = normalizeAgentPreferences(
    sourceCatalog.agentPreferences,
    sourceCatalog.agents,
  );
  const [tags, setTags] = useState<string[]>(
    normalizeTags(sourceTags?.length ? sourceTags : sourcePreferences.selectedTags ?? ["Flush"]),
  );
  const [loadingMachines, setLoadingMachines] = useState(Boolean(listMachines));
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const catalogRequest = useRef(0);

  useEffect(() => {
    if (!listMachines) return;
    let cancelled = false;
    void listMachines()
      .then((found) => {
        if (cancelled) return;
        const byId = new Map(found.map((machine) => [machine.id, machine]));
        byId.set(sourceMachine.id, {
          ...byId.get(sourceMachine.id),
          ...sourceMachine,
        });
        setMachines([...byId.values()]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(message(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingMachines(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listMachines, sourceMachine]);

  const pickMachine = (machine: MachineOption) => {
    if (machine.id === selectedMachineId || machine.online === false) return;
    setSelectedMachineId(machine.id);
    setProblem(null);
    const request = ++catalogRequest.current;
    if (machine.id === sourceMachine.id) {
      setCatalog(sourceCatalog);
      setWorkspaceId(sourceWorkspaceId);
      setTags(
        normalizeTags(sourceTags?.length ? sourceTags : sourcePreferences.selectedTags ?? ["Flush"]),
      );
      setLoadingCatalog(false);
      return;
    }
    if (!loadCatalog) return;
    setLoadingCatalog(true);
    setCatalog({ agents: [], workspaces: [], agentPreferences: null });
    void loadCatalog(machine)
      .then((loaded) => {
        if (catalogRequest.current !== request) return;
        setCatalog(loaded);
        setWorkspaceId(
          loaded.workspaces.some((workspace) => workspace.id === sourceWorkspaceId)
            ? sourceWorkspaceId
            : (loaded.workspaces[0]?.id ?? ""),
        );
        setTags(
          normalizeAgentPreferences(loaded.agentPreferences, loaded.agents).selectedTags ?? ["Flush"],
        );
      })
      .catch((error: unknown) => {
        if (catalogRequest.current === request) setProblem(message(error));
      })
      .finally(() => {
        if (catalogRequest.current === request) setLoadingCatalog(false);
      });
  };

  const selectedMachine =
    machines.find((machine) => machine.id === selectedMachineId) ?? sourceMachine;
  const preferences = normalizeAgentPreferences(catalog.agentPreferences, catalog.agents);
  const route = resolveTagRoute(preferences, tags, catalog.agents);

  return {
    machines,
    selectedMachine,
    catalog,
    workspaceId,
    setWorkspaceId,
    tags,
    setTags,
    preferences,
    route,
    loadingMachines,
    loadingCatalog,
    problem,
    setProblem,
    pickMachine,
  };
}

export function MachineGrid({
  machines,
  selectedMachineId,
  sourceMachineId,
  disabled,
  onPick,
  loading,
}: {
  machines: MachineOption[];
  selectedMachineId: string;
  sourceMachineId: string;
  disabled?: boolean;
  onPick(machine: MachineOption): void;
  loading?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标机器</legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {machines.map((machine) => (
          <label
            key={machine.id}
            className="flex min-h-14 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
          >
            <input
              type="radio"
              name="machine-catalog-machine"
              value={machine.id}
              aria-label={`${machine.label}${machine.online === false ? " 离线" : ""}`}
              checked={machine.id === selectedMachineId}
              disabled={machine.online === false}
              onChange={() => onPick(machine)}
              className="sr-only"
            />
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${machine.online === false ? "bg-faint" : "bg-ok"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg">{machine.label}</span>
              <span className="block text-[10px] text-faint">
                {machine.id === sourceMachineId ? "当前机器" : machine.online === false ? "离线" : "可连接"}
              </span>
            </span>
          </label>
        ))}
      </div>
      {loading ? <p className="mt-2 text-xs text-faint">正在读取机器列表…</p> : null}
    </fieldset>
  );
}

export function WorkspaceList({
  workspaces,
  selectedWorkspaceId,
  disabled,
  loading,
  onSelect,
}: {
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect(workspaceId: string): void;
}) {
  const tree = buildAgentSpaceTree(workspaces);
  const ordered = flattenAgentSpaceTree(tree);
  return (
    <fieldset disabled={disabled}>
      <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标项目</legend>
      {loading ? (
        <p className="mt-2 text-xs text-faint">正在读取目标机器…</p>
      ) : workspaces.length > 0 ? (
        <div
          role="listbox"
          aria-label="目标项目"
          className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line p-1"
        >
          {ordered.map((workspace) => {
            const selected = workspace.id === selectedWorkspaceId;
            return (
              <button
                key={workspace.id}
                type="button"
                role="option"
                aria-selected={selected}
                title={workspace.root}
                onClick={() => onSelect(workspace.id)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                  selected
                    ? "bg-accent/10 text-fg"
                    : "text-muted hover:bg-raised hover:text-fg"
                }`}
              >
                <WorkspaceIcon workspace={workspace} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">
                    {tree.breadcrumbById[workspace.id] ?? workspace.name}
                  </span>
                  <span className="block truncate text-[10px] text-faint">{workspace.root}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          目标机器没有可用项目。
        </p>
      )}
    </fieldset>
  );
}

export function TagGrid({
  agents,
  preferences,
  selectedTags,
  disabled,
  onSelect,
  currentTags,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  selectedTags: string[];
  disabled?: boolean;
  onSelect(tags: string[]): void;
  /** Shown when the source session uses this exact tag contract. */
  currentTags?: string[];
}) {
  const selected = normalizeTags(selectedTags);
  const available = availableAgentTags(preferences);
  const route = resolveTagRoute(preferences, selected, agents);
  const presentation = route ? resolveAgentPresentation(route.agent) : null;
  const modelLabel = route ? resolveModelLabel(route) : null;
  const isCurrent =
    currentTags !== undefined &&
    normalizeTags(currentTags).map(tagKey).sort().join("\u0000") ===
      selected.map(tagKey).sort().join("\u0000");
  return (
    <fieldset disabled={disabled}>
      <legend className="text-xs font-medium uppercase tracking-wide text-faint">目标标签</legend>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="目标标签">
        {available.map((tag) => {
          const checked = selected.some((candidate) => tagKey(candidate) === tagKey(tag));
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={checked}
              disabled={(checked && selected.length === 1) || (!checked && selected.length >= 4)}
              onClick={() =>
                onSelect(
                  checked
                    ? selected.filter((candidate) => tagKey(candidate) !== tagKey(tag))
                    : [...selected, tag],
                )
              }
              className={`rounded-full border px-3 py-1.5 text-xs disabled:opacity-40 ${
                checked
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-line text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
      <div className={`mt-2 flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
        route ? "border-line bg-raised/50" : "border-danger/30 bg-danger/10"
      }`}>
        {route && presentation?.kind !== "text" ? (
          <AgentMark agent={route.agent} className="h-6 w-6" fallbackToText={false} />
        ) : null}
        <span className={`min-w-0 flex-1 truncate ${route ? "text-fg" : "text-danger"}`}>
          {route
            ? `${presentation?.label ?? route.agent.label}${modelLabel ? ` · ${modelLabel}` : ""}${isCurrent ? " · 当前" : ""}`
            : `没有 Agent 与模型同时匹配${selected.length ? `「${selected.join(" + ")}」` : "当前标签"}`}
        </span>
      </div>
    </fieldset>
  );
}

function resolveModelLabel(route: ResolvedCapabilityRoute): string | null {
  if (!route.modelId) return null;
  return (
    route.agent.catalog.models.find((model) => model.id === route.modelId)?.label ??
    route.modelId
  );
}

const tagKey = (tag: string) => tag.toLocaleLowerCase();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
