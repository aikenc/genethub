import type {
  AgentCapability,
  AgentInfo,
  AgentSelectionPreferences,
  PreferredAgentModel,
} from "@genehub/proto";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  CAPABILITIES,
  routesForCapability,
  withCapabilityRoutes,
} from "./capability-preferences";
import type { RuntimeSelection } from "./runtime-selection";

export function CompactRuntimeControls({
  selection,
  disabled,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
}: {
  selection: RuntimeSelection;
  disabled?: boolean;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
  onPickRuntimeAxis(axisId: string, valueId: string): void;
}) {
  const current = selection.current;
  const efforts = selection.model?.efforts ?? [];
  const modes = current?.catalog.modes ?? [];
  const permissionAxis = Boolean(
    current?.capabilities.permissions &&
      resolveAgentProfile(current.id).modeKind === "permission",
  );
  const selectClass =
    "h-8 min-w-0 rounded-lg border border-line bg-raised px-2 text-xs text-fg outline-none focus:border-accent disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {current?.capabilities.setEffort && efforts.length > 0 ? (
        <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
          <span>思考</span>
          <select
            aria-label="思考强度"
            value={selection.effortId ?? efforts[0]}
            disabled={disabled}
            className={selectClass}
            onChange={(event) => onPickEffort(event.currentTarget.value)}
          >
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effortLabel(effort)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {current?.capabilities.setMode && modes.length > 0 ? (
        <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
          <span>{permissionAxis ? "权限" : "模式"}</span>
          <select
            aria-label={permissionAxis ? "权限" : "模式"}
            value={selection.mode?.id ?? modes[0]?.id}
            disabled={disabled}
            className={selectClass}
            onChange={(event) => onPickMode(event.currentTarget.value)}
          >
            {modes.map((mode) => {
              const badge = resolveModeBadge({
                agentId: current.id,
                permissions: permissionAxis,
                modeId: mode.id,
                modeLabel: mode.label,
              });
              return (
                <option key={mode.id} value={mode.id}>
                  {badge.emoji} {badge.fullLabel}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}

      {(current?.catalog.runtimeAxes ?? []).map((axis) =>
        axis.values.length > 0 ? (
          <label key={axis.id} className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
            <span>{axis.label}</span>
            <select
              aria-label={axis.label}
              title={axis.description}
              value={selection.runtimeValues[axis.id] ?? axis.values[0]?.id}
              disabled={disabled}
              className={selectClass}
              onChange={(event) => onPickRuntimeAxis(axis.id, event.currentTarget.value)}
            >
              {axis.values.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
        ) : null,
      )}
    </div>
  );
}

/** Ordered Agent + model routes for the three built-in capabilities. */
export function RuntimeSettings({
  agents,
  preferences,
  disabled,
  initialCapability,
  onSave,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  disabled?: boolean;
  initialCapability: AgentCapability;
  onSave(preferences: AgentSelectionPreferences): Promise<void> | void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [capability, setCapability] = useState(initialCapability);
  const [dragging, setDragging] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(preferences), [preferences]);
  const routes = routesForCapability(draft, capability);
  const update = (next: PreferredAgentModel[]) =>
    setDraft((current) => withCapabilityRoutes(current, capability, next));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= routes.length || from === to) return;
    const next = [...routes];
    const [route] = next.splice(from, 1);
    if (!route) return;
    next.splice(to, 0, route);
    update(next);
  };
  const add = () => {
    if (routes.length >= 5) return;
    const agent =
      agents.find(
        (candidate) =>
          !routes.some(
            (route) => route.agentId === candidate.id && route.modelId === modelFor(candidate),
          ),
      ) ?? agents[0];
    if (!agent) return;
    const modelId = modelFor(agent);
    update([...routes, { agentId: agent.id, ...(modelId ? { modelId } : {}) }]);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div role="tablist" aria-label="内置能力" className="grid grid-cols-3 gap-1 rounded-xl bg-raised p-1">
        {CAPABILITIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={capability === item.id}
            onClick={() => setCapability(item.id)}
            className={`min-w-0 rounded-lg px-2 py-2 text-xs ${
              capability === item.id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
            }`}
          >
            <span className="block truncate">{item.label}</span>
            <span className="mt-0.5 block text-[10px] text-faint">
              {draft.capabilities[item.id].length}/5
            </span>
          </button>
        ))}
      </div>

      <div>
        <p className="text-xs text-muted">
          {CAPABILITIES.find((item) => item.id === capability)?.shortDescription}
        </p>
        <p className="mt-0.5 text-[11px] text-faint">按顺序尝试第一组可用的 Agent 与模型。</p>
      </div>

      <div className="space-y-1.5" role="list" aria-label={`${capability} 首选列表`}>
        {routes.map((route, index) => {
          const agent = agents.find((candidate) => candidate.id === route.agentId);
          const models = agent?.catalog.models ?? [];
          return (
            <div
              key={`${route.agentId}:${route.modelId ?? "default"}:${index}`}
              role="listitem"
              draggable={!disabled}
              onDragStart={() => setDragging(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
              className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-xl border border-line bg-raised/45 p-1.5"
            >
              <span className="flex items-center gap-1 text-[10px] text-faint" title="拖动排序">
                <GripVertical size={14} />
                {index + 1}
              </span>
              <label className="min-w-0">
                <span className="sr-only">第 {index + 1} 项 Agent</span>
                <select
                  aria-label={`第 ${index + 1} 项 Agent`}
                  value={route.agentId}
                  disabled={disabled}
                  className="h-9 w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
                  onChange={(event) => {
                    const nextAgent = agents.find(
                      (candidate) => candidate.id === event.currentTarget.value,
                    );
                    if (!nextAgent) return;
                    const next = [...routes];
                    const modelId = modelFor(nextAgent);
                    next[index] = {
                      agentId: nextAgent.id,
                      ...(modelId ? { modelId } : {}),
                    };
                    update(next);
                  }}
                >
                  {!agent ? <option value={route.agentId}>{route.agentId}（已移除）</option> : null}
                  {agents.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {resolveAgentPresentation(candidate).label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="sr-only">第 {index + 1} 项模型</span>
                <select
                  aria-label={`第 ${index + 1} 项模型`}
                  value={route.modelId ?? ""}
                  disabled={disabled || !agent}
                  className="h-9 w-full min-w-0 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
                  onChange={(event) => {
                    const next = [...routes];
                    next[index] = {
                      agentId: route.agentId,
                      ...(event.currentTarget.value ? { modelId: event.currentTarget.value } : {}),
                    };
                    update(next);
                  }}
                >
                  {models.length === 0 ? <option value="">Agent 默认</option> : null}
                  {route.modelId && !models.some((model) => model.id === route.modelId) ? (
                    <option value={route.modelId}>{route.modelId}（不可用）</option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {resolveModelPresentation({
                        agentId: agent?.id ?? null,
                        modelId: model.id,
                        modelLabel: model.label,
                      }).fullLabel}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={`上移第 ${index + 1} 项`}
                  title="上移"
                  disabled={disabled || index === 0}
                  className="h-8 w-7 rounded text-xs text-muted hover:bg-raised disabled:opacity-25"
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`下移第 ${index + 1} 项`}
                  title="下移"
                  disabled={disabled || index === routes.length - 1}
                  className="h-8 w-7 rounded text-xs text-muted hover:bg-raised disabled:opacity-25"
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`删除第 ${index + 1} 项`}
                  title="删除"
                  disabled={disabled}
                  className="flex h-8 w-7 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-25"
                  onClick={() => update(routes.filter((_, candidate) => candidate !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}
        {routes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-xs text-faint">
            此能力还没有首选项；聊天框会提示先完成配置。
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={disabled || routes.length >= 5 || agents.length === 0}
          onClick={add}
          className="flex h-9 items-center gap-1 rounded-lg border border-line px-3 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
        >
          <Plus size={14} /> 添加首选项
        </button>
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => {
            setSaving(true);
            Promise.resolve(onSave(draft)).finally(() => setSaving(false));
          }}
          className="h-9 rounded-lg bg-accent px-4 text-xs font-medium text-on-accent disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存到这台机器"}
        </button>
      </div>
    </div>
  );
}

function modelFor(agent: AgentInfo): string | undefined {
  return (
    agent.catalog.models.find((model) => model.id === agent.catalog.defaultModel)?.id ??
    agent.catalog.models[0]?.id
  );
}

function effortLabel(id: string): string {
  const labels: Record<string, string> = {
    off: "关闭",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "很高",
    max: "最高",
    ultra: "极致",
  };
  return labels[id] ?? id;
}
