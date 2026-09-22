import type { AgentInfo, AgentSelectionPreferences } from "@genehub/proto";
import { ChevronLeft, Settings2, Tags } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  resolveAgentPresentation,
  resolveModelPresentation,
} from "../presentation/catalog/resolve";
import {
  availableAgentTags,
  normalizeTags,
  resolveTagRoute,
} from "./capability-preferences";
import { CompactRuntimeControls, RuntimeSettings } from "./RuntimeSettings";
import type { RuntimeSelection } from "./runtime-selection";

export function RuntimeSettingsPanel({
  id,
  selection,
  agents,
  preferences,
  tags,
  mediaTags = [],
  disabled,
  returnFocusRef,
  onClose,
  onPickTags,
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
  tags: string[];
  mediaTags?: string[];
  disabled?: boolean;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onPickTags(tags: string[]): void;
  onPickMode(id: string): void;
  onPickEffort(id: string): void;
  onPickRuntimeAxis(axisId: string, valueId: string): void;
  onSavePreferences(preferences: AgentSelectionPreferences): Promise<void> | void;
  onRefreshAgents?(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"quick" | "preferences">("quick");
  const selectableTags = availableAgentTags(preferences);
  const selected = normalizeTags(tags);
  const automatic = normalizeTags(mediaTags);
  const required = normalizeTags([...selected, ...automatic]);
  const route = resolveTagRoute(preferences, required, agents);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (view === "preferences") setView("quick");
      else onClose();
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => close.current?.focus());
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
        className="flex max-h-[min(84dvh,48rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Tab") trapTab(event, panel.current);
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          {view === "preferences" ? (
            <button
              type="button"
              aria-label="返回标签选择"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
              onClick={() => setView("quick")}
            >
              <ChevronLeft size={17} />
            </button>
          ) : null}
          <h2 id={`${id}-title`} className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {view === "quick" ? "标签与运行设置" : "Agent 配置"}
          </h2>
          <button
            ref={close}
            type="button"
            aria-label="关闭设置"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {view === "quick" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="选择 Agent 标签">
                {selectableTags.map((tag) => {
                  const checked = selected.includes(tag) || automatic.includes(tag);
                  const locked = automatic.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={checked}
                      title={locked ? "由会话中的媒体自动添加" : undefined}
                      disabled={
                        disabled ||
                        locked ||
                        (checked && selected.length === 1) ||
                        (!checked && required.length >= 4)
                      }
                      onClick={() =>
                        onPickTags(
                          checked
                            ? selected.filter((candidate) => candidate !== tag)
                            : [...selected, tag],
                        )
                      }
                      className={`rounded-full border px-3 py-1.5 text-xs disabled:opacity-55 ${
                        checked
                          ? "border-accent/60 bg-accent/10 text-accent"
                          : "border-line text-muted hover:bg-raised hover:text-fg"
                      }`}
                    >
                      {tag}{locked ? " · 自动" : ""}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-xl border border-line bg-raised/35 p-2.5">
                <div className="mb-2 flex min-w-0 items-center gap-2 text-xs">
                  <Tags size={14} className="shrink-0 text-accent" />
                  <span className={`truncate ${route ? "text-fg" : "text-danger"}`}>
                    {route ? routeLabel(route.agent, route.modelId) : "没有 Agent 与模型同时匹配全部标签"}
                  </span>
                </div>
                <CompactRuntimeControls
                  selection={selection}
                  disabled={disabled || !route}
                  onPickMode={onPickMode}
                  onPickEffort={onPickEffort}
                  onPickRuntimeAxis={onPickRuntimeAxis}
                />
              </div>

              <div className="flex justify-end border-t border-line pt-2">
                <button
                  type="button"
                  className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-accent hover:bg-raised"
                  onClick={() => {
                    onRefreshAgents?.();
                    setView("preferences");
                  }}
                >
                  <Settings2 size={14} /> Agent 配置
                </button>
              </div>
            </div>
          ) : (
            <RuntimeSettings
              agents={agents}
              preferences={preferences}
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

function routeLabel(agent: AgentInfo, modelId: string | null): string {
  const agentLabel = resolveAgentPresentation(agent).label;
  if (!modelId) return `${agentLabel} · Agent 默认`;
  const model = agent.catalog.models.find((candidate) => candidate.id === modelId);
  return `${agentLabel} · ${resolveModelPresentation({
    agentId: agent.id,
    modelId,
    modelLabel: model?.label,
  }).fullLabel}`;
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
