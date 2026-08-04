import type { ModelInfo } from "@genehub/proto";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { AgentMark } from "../presentation/AgentMark";
import {
  canStartAgent,
  resolveAgentAvailability,
  resolveAgentPresentation,
  resolveAgentProfile,
  resolveEffortBadge,
  resolveModeBadge,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import type { RuntimeSelection } from "./ComposerControls";

export function RuntimeSettingsPanel({
  id,
  selection,
  disabled,
  agentLocked,
  returnFocusRef,
  onClose,
  onPickAgent,
  onPickModel,
  onPickMode,
  onPickEffort,
}: {
  id: string;
  selection: RuntimeSelection;
  disabled?: boolean;
  agentLocked?: boolean;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onPickAgent(id: string): void;
  onPickModel(id: string): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => {
      const checked = panel.current?.querySelector<HTMLInputElement>(
        'input[type="radio"]:checked:not(:disabled)',
      );
      (checked ?? close.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  if (typeof document === "undefined") return null;
  const current = selection.current;
  const agentOptions = selection.agents;
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

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="flex max-h-[min(78dvh,44rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            trapTab(event, panel.current);
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="font-medium text-fg">
              Agent 与运行设置
            </h2>
            <p className="text-xs text-faint">设置会用于下一条消息</p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭运行设置"
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <fieldset disabled={settingsDisabled || agentLocked}>
            <legend className="text-xs font-medium uppercase tracking-wide text-faint">Agent</legend>
            {agentLocked ? (
              <p className="mt-1 text-xs text-muted">当前会话已有内容；新建会话后可以切换 Agent。</p>
            ) : null}
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {agentOptions.map((agent) => {
                const presentation = resolveAgentPresentation(agent);
                const availability = resolveAgentAvailability(agent);
                const profile = resolveAgentProfile(agent.id);
                const axes = [
                  agent.capabilities.setModel ? "模型" : null,
                  agent.capabilities.setEffort ? "思考" : null,
                  agent.capabilities.setMode
                    ? agent.capabilities.permissions && profile.modeKind === "permission"
                      ? "权限"
                      : "模式"
                    : null,
                  agent.capabilities.attachments ? "附件" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <label
                    key={agent.id}
                    className="flex min-h-16 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                  >
                    <input
                      type="radio"
                      name="runtime-agent"
                      value={agent.id}
                      aria-label={`${presentation.label}${availability ? ` ${availability.fullLabel}` : ""}`}
                      checked={agent.id === current?.id}
                      disabled={!canStartAgent(agent)}
                      onChange={() => onPickAgent(agent.id)}
                      className="sr-only"
                    />
                    {presentation.kind === "text" ? null : (
                      <AgentMark
                        agent={agent}
                        className="h-6 w-6"
                        fallbackToText={false}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-fg">{presentation.label}</span>
                        <span
                          className={`shrink-0 text-[10px] ${availability ? "text-danger" : "text-faint"}`}
                        >
                          {availability?.shortLabel ?? "已就绪"}
                        </span>
                      </span>
                      {availability ? (
                        availability.fullLabel === availability.shortLabel ? null : (
                          <span
                            className="block truncate text-[10px] text-danger"
                            title={availability.fullLabel}
                          >
                            {availability.fullLabel}
                          </span>
                        )
                      ) : null}
                      <span className="block truncate text-[10px] text-faint">
                        {axes || "基础对话"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {current?.probe.state === "ready" && !hasRuntimeChoices ? (
            <div className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-xs text-muted">
              <span className="font-medium text-fg">
                {resolveAgentPresentation(current).label}
              </span>
              <span>
                {" "}
                {currentProfile?.startWithoutModelCatalog
                  ? "已接入；当前没有返回可切换的模型、思考强度或模式，将使用 Agent 自身默认配置。"
                  : "已接入，但当前没有可用模型；请先在设置中配置模型服务。"}
              </span>
            </div>
          ) : null}

          {current?.capabilities.setModel && models.length > 0 ? (
            <fieldset disabled={settingsDisabled}>
              <legend className="text-xs font-medium uppercase tracking-wide text-faint">模型</legend>
              <div className="mt-2 space-y-2">
                {models.map((model) => (
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
            </fieldset>
          ) : null}

          {current?.capabilities.setEffort && (selection.model?.efforts.length ?? 0) > 0 ? (
            <fieldset disabled={settingsDisabled}>
              <legend className="text-xs font-medium uppercase tracking-wide text-faint">思考强度</legend>
              {!selection.effortId ? (
                <p className="mt-1 text-xs text-muted">当前由 Agent 使用默认强度。</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {selection.model!.efforts.map((effortId) => {
                  const badge = resolveEffortBadge(effortId);
                  return (
                    <label
                      key={effortId}
                      className="cursor-pointer rounded-full border border-line px-3 py-2 text-sm text-muted has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:checked]:text-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                    >
                      <input
                        type="radio"
                        name="runtime-effort"
                        value={effortId}
                        checked={effortId === selection.effortId}
                        onChange={() => onPickEffort(effortId)}
                        className="sr-only"
                      />
                      <span aria-hidden>{badge.emoji}</span> {badge.fullLabel}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {current?.capabilities.setMode && modes.length > 0 ? (
            <fieldset disabled={settingsDisabled}>
              <legend className="text-xs font-medium uppercase tracking-wide text-faint">
                {permissionAxis ? "权限" : "模式"}
              </legend>
              <div className="mt-2 space-y-2">
                {modes.map((mode) => {
                  const badge = resolveModeBadge({
                    agentId: current.id,
                    permissions: permissionAxis,
                    modeId: mode.id,
                    modeLabel: mode.label,
                  });
                  const unavailable = mode === selection.mode && !selection.modeAvailable;
                  return (
                    <label
                      key={mode.id}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-3 py-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                    >
                      <input
                        type="radio"
                        name="runtime-mode"
                        value={mode.id}
                        checked={mode.id === selection.mode?.id}
                        disabled={unavailable}
                        onChange={() => onPickMode(mode.id)}
                        className="mt-0.5"
                      />
                      <span className="text-lg" aria-hidden>{badge.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-fg">{mode.label}</span>
                        {mode.description ? (
                          <span className="mt-0.5 block text-xs text-muted">{mode.description}</span>
                        ) : null}
                        {unavailable ? (
                          <span className="mt-0.5 block text-xs text-danger">当前目录已不再提供此模式</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

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
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-3 py-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input
        type="radio"
        name="runtime-model"
        value={model.id}
        checked={checked}
        disabled={unavailable}
        onChange={() => onPick(model.id)}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-fg">{display.fullLabel}</span>
        <code className="block break-all text-[11px] text-faint">{model.id}</code>
        <span className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
          {model.contextWindow ? <span>{formatContext(model.contextWindow)} 上下文</span> : null}
          {model.reasoning ? <span>支持推理</span> : null}
          {unavailable ? <span className="text-danger">当前目录已不再提供</span> : null}
        </span>
      </span>
    </label>
  );
}

function withMissing<T extends { id: string }>(catalog: T[], selected: T | undefined, available: boolean): T[] {
  return selected && !available ? [selected, ...catalog] : catalog;
}

function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}K`
      : String(tokens);
}

function trapTab(event: React.KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
