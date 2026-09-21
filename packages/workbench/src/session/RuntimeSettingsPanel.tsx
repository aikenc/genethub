import type { AgentCapability, AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { Brain, ChevronLeft, Code2, ScanSearch, Settings2 } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  resolveAgentPresentation,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  CAPABILITIES,
  resolveCapabilityRoute,
} from "./capability-preferences";
import {
  CompactRuntimeControls,
  RuntimeSettings,
} from "./RuntimeSettings";
import type { RuntimeSelection } from "./runtime-selection";

export function RuntimeSettingsPanel({
  id,
  selection,
  agents,
  preferences,
  capability,
  disabled,
  agentLocked,
  returnFocusRef,
  onClose,
  onPickCapability,
  onPickMode,
  onPickEffort,
  onPickRuntimeAxis,
  onSavePreferences,
  onRefreshAgents,
}: {
  id: string;
  selection: RuntimeSelection;
  agents: AgentInfo[];
  preferences: AgentSelectionPreferences;
  capability: AgentCapability;
  disabled?: boolean;
  agentLocked?: boolean;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onPickCapability(capability: AgentCapability): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
  onPickRuntimeAxis(axisId: string, valueId: string): void;
  onSavePreferences(preferences: AgentSelectionPreferences): Promise<void> | void;
  onRefreshAgents?(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"quick" | "preferences">("quick");

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (view === "preferences") setView("quick");
      else onClose();
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => {
      const chosen = panel.current?.querySelector<HTMLElement>(
        '[role="radio"][aria-checked="true"]:not(:disabled), [role="tab"][aria-selected="true"]',
      );
      (chosen ?? close.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef, view]);

  if (typeof document === "undefined") return null;

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
        className="flex max-h-[min(82dvh,46rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Tab") trapTab(event, panel.current);
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          {view === "preferences" ? (
            <button
              type="button"
              aria-label="返回能力选择"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
              onClick={() => setView("quick")}
            >
              <ChevronLeft size={17} />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-sm font-medium text-fg">
              {view === "quick" ? "能力与运行设置" : "能力首选 Agent"}
            </h2>
            <p className="text-[11px] text-faint">
              {view === "quick"
                ? "紧凑选择；这台机器会记住上一次设置"
                : "每种能力最多 5 组，按顺序自动降级"}
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭能力设置"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {view === "quick" ? (
            <div className="space-y-3">
              <div role="radiogroup" aria-label="选择能力" className="grid grid-cols-3 gap-1.5">
                {CAPABILITIES.map((item) => {
                  const route = resolveCapabilityRoute(preferences, item.id, agents);
                  const selected = item.id === capability;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled || agentLocked || !route}
                      onClick={() => onPickCapability(item.id)}
                      className={`flex min-h-16 min-w-0 flex-col items-start justify-center rounded-xl border px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
                        selected
                          ? "border-accent bg-accent/10 text-fg"
                          : "border-line text-muted hover:bg-raised hover:text-fg"
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <CapabilityIcon capability={item.id} />
                        <span className="truncate">{item.label}</span>
                      </span>
                      <span className="mt-1 block w-full truncate text-[10px] text-faint">
                        {route ? routeLabel(route.agent, route.modelId) : "尚未配置可用首选项"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {agentLocked ? (
                <p className="text-[11px] text-faint">当前会话已有内容；运行参数仍可调整，切换能力请新建会话。</p>
              ) : null}

              <div className="rounded-xl border border-line bg-raised/35 p-2.5">
                <CompactRuntimeControls
                  selection={selection}
                  disabled={disabled}
                  onPickMode={onPickMode}
                  onPickEffort={onPickEffort}
                  onPickRuntimeAxis={onPickRuntimeAxis}
                />
                {!selection.current ? (
                  <p className="text-xs text-danger">此能力没有可用的 Agent 与模型，请先编辑首选项。</p>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line pt-2">
                <p className="text-[11px] text-faint">默认思考强度为中偏高（优先 high 档），权限为全开；选择保存在 daemon 的机器配置中。</p>
                <button
                  type="button"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-accent hover:bg-raised"
                  onClick={() => {
                    onRefreshAgents?.();
                    setView("preferences");
                  }}
                >
                  <Settings2 size={14} /> 编辑能力首选项
                </button>
              </div>
            </div>
          ) : (
            <RuntimeSettings
              agents={agents}
              preferences={preferences}
              initialCapability={capability}
              disabled={disabled}
              onSave={async (next) => {
                await onSavePreferences(next);
                setView("quick");
              }}
            />
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function CapabilityIcon({ capability }: { capability: AgentCapability }) {
  if (capability === "planning") return <Brain size={15} aria-hidden />;
  if (capability === "coding") return <Code2 size={15} aria-hidden />;
  return <ScanSearch size={15} aria-hidden />;
}

function routeLabel(agent: AgentInfo, modelId: string | null): string {
  const agentLabel = resolveAgentPresentation(agent).label;
  if (!modelId) return `${agentLabel} · Agent 默认`;
  const model = agent.catalog.models.find((candidate) => candidate.id === modelId);
  return `${agentLabel} · ${resolveModelPresentation({
    agentId: agent.id,
    modelId,
    modelLabel: model?.label,
  }).shortLabel}`;
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
