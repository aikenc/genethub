import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";

import { AgentMark } from "../presentation/AgentMark";
import {
  resolveAgentPresentation,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  COST_LEVELS,
  availableAgentTags,
  effectiveTagGroups,
  matchingTagRoutes,
  normalizeGroupedTags,
  normalizeTags,
  toggleGroupedTag,
  type ConfiguredModelRoute,
} from "./capability-preferences";

export interface ModelIdentity {
  agentId: string | null;
  modelId: string | null;
}

/** Shared exact Agent + model selector. Tags only narrow this list. */
export function ModelPicker({
  agents,
  preferences,
  filterTags,
  automaticTags = [],
  selected,
  disabled,
  onFilterTags,
  onSelect,
}: {
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  filterTags: string[];
  automaticTags?: string[];
  selected?: ModelIdentity;
  disabled?: boolean;
  onFilterTags(tags: string[]): void;
  onSelect(route: ConfiguredModelRoute): void;
}) {
  const filters = normalizeGroupedTags(filterTags, preferences);
  const automatic = normalizeTags(automaticTags);
  const required = normalizeGroupedTags([...filters, ...automatic], preferences);
  const available = availableAgentTags(preferences);
  const groups = effectiveTagGroups(preferences)
    .map((group) => ({
      ...group,
      tags: group.tags.filter((tag) => available.some((candidate) => sameTag(candidate, tag))),
    }))
    .filter((group) => group.tags.length > 0);
  const grouped = new Set(groups.flatMap((group) => group.tags.map(tagKey)));
  const independent = available.filter((tag) => !grouped.has(tagKey(tag)));
  const routes = matchingTagRoutes(preferences, required, agents);

  const tagButton = (tag: string) => {
    const checked = required.some((candidate) => sameTag(candidate, tag));
    const locked = automatic.some((candidate) => sameTag(candidate, tag));
    return (
      <button
        key={tag}
        type="button"
        aria-pressed={checked}
        aria-label={locked ? `${tag} · 自动` : tag}
        title={locked ? "由当前输入或会话中的媒体自动添加" : undefined}
        disabled={disabled || locked || (!checked && required.length >= 4)}
        onClick={() => onFilterTags(toggleGroupedTag(filters, tag, preferences))}
        className={`rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-50 ${
          checked
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-line text-muted hover:bg-raised hover:text-fg"
        }`}
      >
        {tag}{locked ? " · 自动" : ""}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2" aria-label="模型筛选">
        {groups.map((group) => (
          <div key={group.id} className="flex min-w-0 items-center gap-2">
            <span className="w-14 shrink-0 truncate text-[10px] text-faint">{group.label}</span>
            <div className="flex min-w-0 flex-wrap gap-1">{group.tags.map(tagButton)}</div>
          </div>
        ))}
        {independent.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] text-faint">标签</span>
            <div className="flex min-w-0 flex-wrap gap-1">{independent.map(tagButton)}</div>
          </div>
        ) : null}
      </div>

      <div
        role="listbox"
        aria-label="Agent 与模型"
        className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-line p-1"
      >
        {routes.map((route) => {
          const chosen =
            selected?.agentId === route.agent.id &&
            selected.modelId === route.modelId;
          const agent = resolveAgentPresentation(route.agent);
          const model = route.modelId
            ? resolveModelPresentation({
                agentId: route.agent.id,
                modelId: route.modelId,
                modelLabel: route.agent.catalog.models.find((item) => item.id === route.modelId)?.label,
              }).fullLabel
            : "Agent 默认";
          const cost = COST_LEVELS.find((level) => level.id === (route.profile.cost ?? "medium"));
          return (
            <button
              key={`${route.agent.id}\u0000${route.modelId ?? ""}`}
              type="button"
              role="option"
              aria-selected={chosen}
              disabled={disabled}
              onClick={() => onSelect(route)}
              className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left ${
                chosen
                  ? "bg-accent/10 text-fg"
                  : "text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {agent.kind !== "text" ? (
                <AgentMark agent={route.agent} className="h-6 w-6" fallbackToText={false} />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-fg">
                  {agent.label} · {model}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-faint">
                  {route.profile.tags.join(" · ")} · 成本{cost?.label ?? "中"}
                </span>
              </span>
              {chosen ? <span className="shrink-0 text-[10px] text-accent">当前</span> : null}
            </button>
          );
        })}
        {routes.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-danger">
            没有 Agent 与模型匹配全部筛选条件
          </p>
        ) : null}
      </div>
    </div>
  );
}

const tagKey = (tag: string) => tag.toLocaleLowerCase();
const sameTag = (left: string, right: string) => tagKey(left) === tagKey(right);
