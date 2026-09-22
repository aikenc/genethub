import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { Plus, Tags } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  availableAgentTags,
  COST_LEVELS,
  normalizeAgentPreferences,
  normalizeTags,
  withModelProfile,
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

/** Flat machine-global Agent + model configuration; there is no route order. */
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
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(normalizeAgentPreferences(preferences, agents)), [preferences, agents]);
  const tags = useMemo(() => availableAgentTags(draft), [draft]);
  const rows = draft.modelProfiles ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="space-y-2" role="list" aria-label="Agent 与模型配置">
        {rows.map((profile) => {
          const key = `${profile.agentId}\u0000${profile.modelId ?? ""}`;
          const agent = agents.find((candidate) => candidate.id === profile.agentId);
          const model = agent?.catalog.models.find((candidate) => candidate.id === profile.modelId);
          const agentLabel = agent ? resolveAgentPresentation(agent).label : profile.agentId;
          const modelLabel = profile.modelId
            ? resolveModelPresentation({
                agentId: profile.agentId,
                modelId: profile.modelId,
                modelLabel: model?.label,
              }).fullLabel
            : "Agent 默认";
          const selected = normalizeTags(profile.tags);
          const updateTags = (next: string[]) => {
            const normalized = normalizeTags(next).slice(0, 4);
            if (normalized.length === 0) return;
            setDraft((current) => withModelProfile(current, { ...profile, tags: normalized }));
          };
          return (
            <article
              key={key}
              role="listitem"
              className="rounded-xl border border-line bg-raised/35 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-fg">{agentLabel}</div>
                  <div className="truncate text-[11px] text-faint">{modelLabel}</div>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-faint">
                  <span>成本</span>
                  <select
                    aria-label={`${agentLabel} ${modelLabel} 成本`}
                    value={profile.cost ?? "medium"}
                    disabled={disabled}
                    className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-fg"
                    onChange={(event) => {
                      const cost = event.currentTarget.value as NonNullable<typeof profile.cost>;
                      setDraft((current) =>
                        withModelProfile(current, {
                          ...profile,
                          cost,
                        }),
                      );
                    }}
                  >
                    {COST_LEVELS.map((level) => (
                      <option key={level.id} value={level.id}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-2 flex flex-wrap gap-1" aria-label={`${agentLabel} ${modelLabel} 标签`}>
                {tags.map((tag) => {
                  const checked = selected.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={checked}
                      disabled={
                        disabled ||
                        (!checked && selected.length >= 4) ||
                        (checked && selected.length === 1)
                      }
                      onClick={() =>
                        updateTags(
                          checked ? selected.filter((candidate) => candidate !== tag) : [...selected, tag],
                        )
                      }
                      className={`rounded-full border px-2 py-1 text-[10px] disabled:opacity-35 ${
                        checked
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-line text-faint hover:text-fg"
                      }`}
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
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-3 py-8 text-center text-xs text-faint">
            <Tags size={18} /> 当前没有可配置的 Agent 与模型
          </div>
        ) : null}
      </div>

      <div className="sticky bottom-0 flex justify-end border-t border-line bg-surface pt-3">
        <button
          type="button"
          disabled={disabled || saving || rows.some((row) => row.tags.length === 0)}
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
