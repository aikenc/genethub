import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { Plus, Tags, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  availableAgentTags,
  BUILTIN_TAGS,
  COST_LEVELS,
  inferredModelProfile,
  isAutoModel,
  normalizeAgentPreferences,
  normalizeGroupedTags,
  toggleGroupedTag,
  withModelProfile,
  withoutModelProfile,
  withTagGroups,
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

/** Machine-global exact model, cost and tag configuration. */
export function RuntimeSettings({
  agents,
  preferences,
  disabled,
  onSave,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  disabled?: boolean;
  onSave(preferences: AgentSelectionPreferences): Promise<void> | void;
}) {
  const [draft, setDraft] = useState(() => normalizeAgentPreferences(preferences, agents));
  const [customTag, setCustomTag] = useState<Record<string, string>>({});
  const [addingAgent, setAddingAgent] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(normalizeAgentPreferences(preferences, agents)), [preferences, agents]);
  const tags = useMemo(() => availableAgentTags(draft), [draft]);
  const customTags = tags.filter(
    (tag) => !BUILTIN_TAGS.some((builtin) => builtin.toLocaleLowerCase() === tag.toLocaleLowerCase()),
  );
  const rows = draft.modelProfiles ?? [];

  const assignTagGroup = (tag: string, groupId: string) => {
    const groups = (draft.tagGroups ?? []).map((group) => ({
      ...group,
      tags: group.tags.filter((member) => member.toLocaleLowerCase() !== tag.toLocaleLowerCase()),
    }));
    const next = groupId
      ? groups.map((group) => group.id === groupId ? { ...group, tags: [...group.tags, tag] } : group)
      : groups;
    setDraft(withTagGroups(draft, next));
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <details className="rounded-xl border border-line bg-raised/25 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-fg">标签组</summary>
        <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-fg">智能档位</span>
            <span className="text-faint">Max · Pro · Flush（单选）</span>
          </div>
          {(draft.tagGroups ?? []).map((group) => (
            <div key={group.id} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-fg">{group.label}</span>
              <span className="truncate text-[10px] text-faint">{group.tags.join(" · ") || "尚未分配标签"}</span>
              <button
                type="button"
                aria-label={`删除标签组 ${group.label}`}
                disabled={disabled}
                className="text-faint hover:text-danger disabled:opacity-40"
                onClick={() => setDraft(withTagGroups(draft, (draft.tagGroups ?? []).filter((item) => item.id !== group.id)))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              aria-label="新标签组名称"
              value={newGroup}
              maxLength={40}
              placeholder="新建标签组"
              disabled={disabled}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
              onChange={(event) => setNewGroup(event.currentTarget.value)}
            />
            <button
              type="button"
              disabled={disabled || !newGroup.trim()}
              className="h-8 rounded-lg border border-line px-3 text-xs text-accent disabled:opacity-40"
              onClick={() => {
                const label = newGroup.trim();
                if (!label) return;
                setDraft(withTagGroups(draft, [
                  ...(draft.tagGroups ?? []),
                  { id: `custom-${Date.now().toString(36)}`, label, tags: [] },
                ]));
                setNewGroup("");
              }}
            >
              添加
            </button>
          </div>
          {customTags.length > 0 ? (
            <div className="space-y-1.5 border-t border-line pt-2">
              {customTags.map((tag) => {
                const owner = (draft.tagGroups ?? []).find((group) =>
                  group.tags.some((member) => member.toLocaleLowerCase() === tag.toLocaleLowerCase()),
                );
                return (
                  <label key={tag} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-fg">{tag}</span>
                    <select
                      aria-label={`${tag} 标签组`}
                      value={owner?.id ?? ""}
                      disabled={disabled}
                      className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
                      onChange={(event) => assignTagGroup(tag, event.currentTarget.value)}
                    >
                      <option value="">不分组</option>
                      {(draft.tagGroups ?? []).map((group) => (
                        <option key={group.id} value={group.id}>{group.label}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          ) : null}
        </div>
      </details>

      <div className="space-y-3" aria-label="Agent 与模型配置">
        {agents.map((agent) => {
          const agentRows = rows.filter((profile) => profile.agentId === agent.id);
          const remaining = agent.catalog.models.filter(
            (model) =>
              !isAutoModel(model) &&
              !agentRows.some((profile) => profile.modelId === model.id),
          );
          if (agentRows.length === 0 && remaining.length === 0) return null;
          const agentLabel = resolveAgentPresentation(agent).label;
          return (
            <section key={agent.id} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h3 className="truncate text-xs font-medium text-fg">{agentLabel}</h3>
                <span className="text-[10px] text-faint">{agentRows.length} 个模型</span>
              </div>
              <div role="list" className="space-y-2">
                {agentRows.map((profile) => {
                  const key = `${profile.agentId}\u0000${profile.modelId ?? ""}`;
                  const model = agent.catalog.models.find((candidate) => candidate.id === profile.modelId);
                  const modelLabel = profile.modelId
                    ? resolveModelPresentation({
                        agentId: profile.agentId,
                        modelId: profile.modelId,
                        modelLabel: model?.label,
                      }).fullLabel
                    : "Agent 默认";
                  const selected = normalizeGroupedTags(profile.tags, draft);
                  const updateTags = (next: string[]) => {
                    const normalized = normalizeGroupedTags(next, draft).slice(0, 4);
                    if (normalized.length === 0) return;
                    setDraft((current) => withModelProfile(current, { ...profile, tags: normalized }));
                  };
                  return (
                    <article key={key} role="listitem" className="rounded-xl border border-line bg-raised/35 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{modelLabel}</div>
                        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-faint">
                          <span>成本</span>
                          <select
                            aria-label={`${agentLabel} ${modelLabel} 成本`}
                            value={profile.cost ?? "medium"}
                            disabled={disabled}
                            className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
                            onChange={(event) => {
                              const cost = event.currentTarget.value as NonNullable<typeof profile.cost>;
                              setDraft((current) => withModelProfile(current, { ...profile, cost }));
                            }}
                          >
                            {COST_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                          </select>
                        </label>
                        <button
                          type="button"
                          aria-label={`移除 ${agentLabel} ${modelLabel}`}
                          title={agentRows.length === 1 ? "每个 Agent 至少保留一个模型" : "移除模型"}
                          disabled={disabled || agentRows.length === 1}
                          className="text-faint hover:text-danger disabled:opacity-25"
                          onClick={() => setDraft((current) => withoutModelProfile(current, profile.agentId, profile.modelId))}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1" aria-label={`${agentLabel} ${modelLabel} 标签`}>
                        {tags.map((tag) => {
                          const checked = selected.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase());
                          return (
                            <button
                              key={tag}
                              type="button"
                              aria-pressed={checked}
                              disabled={disabled || (checked && selected.length === 1) || (!checked && selected.length >= 4)}
                              onClick={() => updateTags(toggleGroupedTag(selected, tag, draft))}
                              className={`rounded-full border px-2 py-1 text-[10px] disabled:opacity-35 ${checked ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-faint hover:text-fg"}`}
                            >
                              {tag}
                            </button>
                          );
                        })}
                        <span className="flex h-7 items-center rounded-full border border-dashed border-line px-1">
                          <input
                            aria-label={`${agentLabel} ${modelLabel} 自定义标签`}
                            value={customTag[key] ?? ""}
                            disabled={disabled || selected.length >= 4}
                            placeholder="自定义"
                            maxLength={40}
                            className="w-14 bg-transparent px-1 text-[10px] text-fg outline-none placeholder:text-faint"
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setCustomTag((current) => ({ ...current, [key]: value }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return;
                              event.preventDefault();
                              const value = customTag[key]?.trim();
                              if (!value) return;
                              updateTags([...selected, value]);
                              setCustomTag((current) => ({ ...current, [key]: "" }));
                            }}
                          />
                          <button
                            type="button"
                            aria-label="添加自定义标签"
                            disabled={disabled || selected.length >= 4 || !customTag[key]?.trim()}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-faint hover:text-accent disabled:opacity-30"
                            onClick={() => {
                              const value = customTag[key]?.trim();
                              if (!value) return;
                              updateTags([...selected, value]);
                              setCustomTag((current) => ({ ...current, [key]: "" }));
                            }}
                          >
                            <Plus size={11} />
                          </button>
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>

              {remaining.length > 0 ? (
                <div>
                  <button
                    type="button"
                    aria-expanded={addingAgent === agent.id}
                    disabled={disabled}
                    className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-accent hover:bg-raised disabled:opacity-40"
                    onClick={() => setAddingAgent((current) => current === agent.id ? null : agent.id)}
                  >
                    <Plus size={13} /> 添加模型
                  </button>
                  {addingAgent === agent.id ? (
                    <div className="mt-1 grid grid-cols-1 gap-1 rounded-xl border border-line p-1 sm:grid-cols-2">
                      {remaining.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          className="truncate rounded-lg px-2 py-2 text-left text-xs text-muted hover:bg-raised hover:text-fg"
                          onClick={() => {
                            setDraft((current) => withModelProfile(current, inferredModelProfile(agent, model)));
                            setAddingAgent(null);
                          }}
                        >
                          {resolveModelPresentation({ agentId: agent.id, modelId: model.id, modelLabel: model.label }).fullLabel}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-3 py-8 text-center text-xs text-faint">
            <Tags size={18} /> 当前没有可配置的 Agent 与模型
          </div>
        ) : null}
      </div>

      <div className="sticky bottom-0 flex justify-end border-t border-line bg-surface pt-3">
        <button
          type="button"
          disabled={disabled || saving || rows.length === 0 || rows.some((row) => row.tags.length === 0)}
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

function effortLabel(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized === "low" || normalized === "minimal") return "低";
  if (normalized === "medium") return "中";
  if (normalized === "high") return "高";
  if (normalized === "xhigh" || normalized === "max") return "超高";
  return id;
}
