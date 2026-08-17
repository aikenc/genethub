import type { AgentInfo, ModeInfo, ModelInfo } from "@genehub/proto";
import { Eye, Info, Sparkles } from "lucide-react";
import { useId, useState } from "react";

import { AgentMark } from "../presentation/AgentMark";
import { EffortMeter } from "../presentation/EffortMeter";
import {
  canStartAgent,
  resolveAgentAvailability,
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
  resolveModelTraits,
} from "../presentation/catalog/resolve";
import type { RuntimeSelection } from "./runtime-selection";

/**
 * How many models a catalog shows before the rest are folded away.
 *
 * A Genet install with an OpenAI key lists dozens, and the panel is opened to
 * change one setting, not to read a provider's inventory. Four is two rows of
 * the two-column grid.
 */
export const RUNTIME_MODEL_PREVIEW_LIMIT = 4;

/**
 * How many Agents the tab row shows before the rest are folded away.
 *
 * Every configured Agent is a tab, including the ones that are not installed,
 * and on a phone that ran past one row. Four keeps the row single-height at the
 * narrowest width we support.
 */
export const RUNTIME_AGENT_PREVIEW_LIMIT = 4;

/**
 * Everything about how the next turn runs, in one column.
 *
 * Shared verbatim by the composer's modal and by the panel a new conversation
 * opens with, because those are the same question asked at two moments — and
 * when they were two components, only one of them ever got the fix.
 *
 * Nothing in here scrolls sideways. The tab row used to be one `overflow-x-auto`
 * line, which on a phone is indistinguishable from the page itself sliding
 * under your thumb; it wraps instead, and what does not fit is folded behind
 * one button rather than hidden past an edge with no scrollbar to hint at it.
 */
export function RuntimeSettings({
  selection,
  disabled,
  agentLocked,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
}: {
  selection: RuntimeSelection;
  disabled?: boolean;
  /** A conversation with history keeps its Agent; only the axes stay live. */
  agentLocked?: boolean;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
}) {
  const generatedId = useId();
  const bodyId = `runtime-axes-${generatedId}`;
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [detailModeId, setDetailModeId] = useState<string | null>(null);
  const current = selection.current;
  const agents = readyFirst(selection.agents);
  const models = current
    ? withMissing(current.catalog.models, selection.model, selection.modelAvailable)
    : [];
  const modes = current
    ? withMissing(current.catalog.modes, selection.mode, selection.modeAvailable)
    : [];
  const currentProfile = current ? resolveAgentProfile(current.id) : null;
  const permissionAxis = Boolean(
    current?.capabilities.permissions && currentProfile?.modeKind === "permission",
  );
  const hasRuntimeChoices = Boolean(
    (current?.capabilities.setModel && models.length > 0) ||
      (current?.capabilities.setEffort && (selection.model?.efforts.length ?? 0) > 0) ||
      (current?.capabilities.setMode && modes.length > 0),
  );
  const settingsDisabled = Boolean(disabled);
  const visibleAgents = showAllAgents
    ? agents
    : preview(agents, current?.id ?? null, RUNTIME_AGENT_PREVIEW_LIMIT);
  const visibleModels = showAllModels
    ? models
    : preview(models, selection.model?.id ?? null, RUNTIME_MODEL_PREVIEW_LIMIT);
  const detailMode = modes.find((mode) => mode.id === detailModeId);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        <div role="tablist" aria-label="Agent" className="contents">
          {visibleAgents.map((agent) => {
            const presentation = resolveAgentPresentation(agent);
            const availability = resolveAgentAvailability(agent);
            const chosen = agent.id === current?.id;
            return (
              <button
                key={agent.id}
                type="button"
                role="tab"
                aria-selected={chosen}
                aria-controls={bodyId}
                aria-label={`${presentation.label}${availability ? ` ${availability.fullLabel}` : ""}`}
                title={availability?.fullLabel}
                disabled={settingsDisabled || agentLocked || !canStartAgent(agent)}
                onClick={() => onPickAgent(agent.id)}
                className={`flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                  chosen
                    ? "bg-accent/15 text-fg ring-1 ring-inset ring-accent"
                    : "text-muted hover:bg-raised hover:text-fg"
                }`}
              >
                <AgentMark agent={agent} className="h-4 w-4" fallbackToText={false} />
                <span className="max-w-24 truncate">{presentation.label}</span>
              </button>
            );
          })}
        </div>
        {agents.length > visibleAgents.length || showAllAgents ? (
          <button
            type="button"
            aria-expanded={showAllAgents}
            className="h-8 shrink-0 rounded-lg px-2 text-xs text-accent hover:bg-raised"
            onClick={() => setShowAllAgents((shown) => !shown)}
          >
            {showAllAgents ? "收起" : `更多 ${agents.length - visibleAgents.length}`}
          </button>
        ) : null}
      </div>

      {agentLocked ? (
        <p className="text-xs text-muted">当前会话已有内容；新建会话后可以切换 Agent。</p>
      ) : null}

      <div id={bodyId} role="tabpanel" className="flex min-w-0 flex-col gap-3">
        {current?.probe.state === "ready" && !hasRuntimeChoices ? (
          <p className="rounded-lg border border-line bg-raised/40 px-2.5 py-2 text-xs text-muted">
            {currentProfile?.startWithoutModelCatalog
              ? "这个 Agent 没有返回可切换的模型、思考强度或模式，将使用它自身的默认配置。"
              : "已接入，但当前没有可用模型；请先在设置中配置模型服务。"}
          </p>
        ) : null}

        {current?.capabilities.setModel && models.length > 0 ? (
          <fieldset disabled={settingsDisabled} className="min-w-0">
            <legend className="text-[10px] font-medium uppercase tracking-wide text-faint">
              模型
            </legend>
            <div className="mt-1 grid grid-cols-2 gap-x-1">
              {visibleModels.map((model) => (
                <ModelOption
                  key={model.id}
                  agentId={current.id}
                  model={model}
                  checked={model.id === selection.model?.id}
                  unavailable={model === selection.model && !selection.modelAvailable}
                  onPick={onPickModel}
                />
              ))}
            </div>
            {models.length > visibleModels.length || showAllModels ? (
              <button
                type="button"
                aria-expanded={showAllModels}
                className="mt-0.5 h-7 rounded px-2 text-xs text-accent hover:bg-raised"
                onClick={() => setShowAllModels((shown) => !shown)}
              >
                {showAllModels ? "收起" : `更多 ${models.length - visibleModels.length}`}
              </button>
            ) : null}
          </fieldset>
        ) : null}

        {current?.capabilities.setEffort && (selection.model?.efforts.length ?? 0) > 0 ? (
          <fieldset disabled={settingsDisabled} className="min-w-0">
            <legend className="text-[10px] font-medium uppercase tracking-wide text-faint">
              思考强度
            </legend>
            <div className="mt-1 flex flex-wrap gap-1">
              {selection.model!.efforts.map((effortId) => {
                const badge = resolveEffortBadge(effortId);
                return (
                  <label
                    key={effortId}
                    className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 text-xs text-muted has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:checked]:text-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                  >
                    <input
                      type="radio"
                      name="runtime-effort"
                      value={effortId}
                      checked={effortId === selection.effortId}
                      onChange={() => onPickEffort(effortId)}
                      className="sr-only"
                    />
                    <EffortMeter level={badge.level} />
                    {badge.fullLabel}
                  </label>
                );
              })}
            </div>
            {!selection.effortId ? (
              <p className="mt-1 text-[11px] text-faint">当前由 Agent 使用默认强度。</p>
            ) : null}
          </fieldset>
        ) : null}

        {current?.id === "cursor" && selection.model && /(?:^|,)fast=(true|false)(?:,|\])/.test(selection.model.id) ? (
          <fieldset disabled={settingsDisabled} className="min-w-0">
            <legend className="text-[10px] font-medium uppercase tracking-wide text-faint">
              Fast 模式
            </legend>
            <label className="mt-1 flex h-8 w-fit cursor-pointer items-center gap-2 rounded-full border border-line px-2.5 text-xs text-muted has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:checked]:text-fg">
              <input
                type="checkbox"
                checked={/fast=true(?:,|\])/.test(selection.model.id)}
                onChange={(event) => onPickModel(cursorVariantWith(selection.model!.id, "fast", String(event.target.checked)))}
                className="sr-only"
              />
              { /fast=true(?:,|\])/.test(selection.model.id) ? "已开启" : "已关闭" }
            </label>
          </fieldset>
        ) : null}

        {current?.capabilities.setMode && modes.length > 0 ? (
          <fieldset disabled={settingsDisabled} className="min-w-0">
            <legend className="text-[10px] font-medium uppercase tracking-wide text-faint">
              {permissionAxis ? "权限" : "模式"}
            </legend>
            <div className="mt-1 flex flex-wrap gap-1">
              {modes.map((mode) => {
                const badge = resolveModeBadge({
                  agentId: current.id,
                  permissions: permissionAxis,
                  modeId: mode.id,
                  modeLabel: mode.label,
                });
                const unavailable = mode === selection.mode && !selection.modeAvailable;
                const detail = describeMode(mode, unavailable);
                return (
                  <span
                    key={mode.id}
                    className="flex h-8 items-center rounded-full border border-line pr-0.5 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                  >
                    <label className="flex h-full cursor-pointer items-center gap-1 rounded-full pl-2.5 pr-1 text-muted has-[:checked]:text-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                      <input
                        type="radio"
                        name="runtime-mode"
                        value={mode.id}
                        checked={mode.id === selection.mode?.id}
                        disabled={unavailable}
                        onChange={() => onPickMode(mode.id)}
                        className="sr-only"
                      />
                      <span aria-hidden>{badge.emoji}</span>
                      {mode.label}
                    </label>
                    {detail ? (
                      <button
                        type="button"
                        aria-label={`${mode.label} 说明`}
                        aria-expanded={detailModeId === mode.id}
                        onClick={() =>
                          setDetailModeId((shown) => (shown === mode.id ? null : mode.id))
                        }
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-raised ${
                          unavailable ? "text-danger" : "text-faint hover:text-fg"
                        }`}
                      >
                        <Info className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
            {detailMode ? (
              <p className="mt-1 text-[11px] text-muted">
                {describeMode(detailMode, detailMode === selection.mode && !selection.modeAvailable)}
              </p>
            ) : null}
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}

function cursorVariantWith(model: string, key: string, value: string) {
  return model.replace(new RegExp(`(${key}=)(true|false)`), `$1${value}`);
}

/**
 * One model, one cell.
 *
 * The id, the context window and the words "支持推理" used to take three lines
 * each, which turned a four-model catalog into a page. What is left is the name
 * plus the two things a name does not say — whether it thinks, and whether it
 * can see — and both are icons with the words behind them for anyone reading
 * this with something other than their eyes.
 */
function ModelOption({
  agentId,
  model,
  checked,
  unavailable,
  onPick,
}: {
  agentId: string;
  model: ModelInfo;
  checked: boolean;
  unavailable: boolean;
  onPick(id: string): void;
}) {
  const display = resolveModelPresentation({
    agentId,
    modelId: model.id,
    modelLabel: model.label,
  });
  const traits = resolveModelTraits(model);
  return (
    <label
      title={unavailable ? `${model.id}（当前目录已不再提供）` : model.id}
      className="flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-sm hover:bg-raised has-[:checked]:bg-accent/10 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
    >
      <input
        type="radio"
        name="runtime-model"
        value={model.id}
        checked={checked}
        disabled={unavailable}
        onChange={() => onPick(model.id)}
        className="sr-only"
      />
      <span className={`min-w-0 flex-1 truncate ${unavailable ? "text-danger" : "text-fg"}`}>
        {display.fullLabel}
      </span>
      {traits.reasoning ? (
        <>
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="sr-only">推理</span>
        </>
      ) : null}
      {traits.multimodal ? (
        <>
          <Eye className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="sr-only">多模态</span>
        </>
      ) : null}
      {unavailable ? <span className="sr-only">当前目录已不再提供</span> : null}
      <Tick checked={checked} />
    </label>
  );
}

function Tick({ checked }: { checked: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 text-accent ${checked ? "" : "invisible"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m3 8.5 3.5 3.5L13 4.5" />
    </svg>
  );
}

function describeMode(mode: ModeInfo, unavailable: boolean): string | null {
  if (unavailable) return "当前目录已不再提供此模式";
  return mode.description?.trim() || null;
}

/**
 * The Agents that can actually be started, then the rest.
 *
 * The list arrives in daemon configuration order, so an uninstalled Agent could
 * sit between two working ones and take the row's first position — the place a
 * reader looks first for the thing they can use.
 */
function readyFirst(agents: AgentInfo[]): AgentInfo[] {
  const startable = agents.filter((agent) => canStartAgent(agent));
  if (startable.length === agents.length) return agents;
  return [...startable, ...agents.filter((agent) => !canStartAgent(agent))];
}

/**
 * The first few entries, with the chosen one always among them.
 *
 * Folding away the setting that is currently in force would make the panel
 * report a different Agent or model than the one the next turn will use.
 */
function preview<T extends { id: string }>(items: T[], selectedId: string | null, limit: number): T[] {
  if (items.length <= limit) return items;
  const head = items.slice(0, limit);
  if (head.some((item) => item.id === selectedId)) return head;
  const selected = items.find((item) => item.id === selectedId);
  return selected ? [...head.slice(0, limit - 1), selected] : head;
}

function withMissing<T extends { id: string }>(
  catalog: T[],
  selected: T | undefined,
  available: boolean,
): T[] {
  return selected && !available ? [selected, ...catalog] : catalog;
}
