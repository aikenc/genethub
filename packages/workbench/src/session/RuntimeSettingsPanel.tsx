import type {
  AgentInfo,
  AgentSelectionPreferences,
  SessionAgentTarget,
} from "@genehub/proto";
import { ChevronLeft, Settings2 } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { definedRuntimeValues, normalizeGroupedTags, routeTarget } from "./capability-preferences";
import { ModelPicker } from "./ModelPicker";
import { CompactRuntimeControls, RuntimeSettings } from "./RuntimeSettings";
import { resolveRuntimeSelection, type RuntimeSelection } from "./runtime-selection";

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
  onPickTarget,
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
  onPickTarget(target: SessionAgentTarget, filterTags: string[]): Promise<void> | void;
  onSavePreferences(preferences: AgentSelectionPreferences): Promise<void> | void;
  onRefreshAgents?(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"quick" | "preferences">("quick");
  const [filters, setFilters] = useState(() => normalizeGroupedTags(tags, preferences));
  const [target, setTarget] = useState<SessionAgentTarget | null>(() => targetFrom(selection));
  const [saving, setSaving] = useState(false);
  const targetSelection = target
    ? resolveRuntimeSelection({
        agents,
        agentId: target.agentId,
        modelId: target.modelId ?? null,
        modeId: target.modeId ?? null,
        effortId: target.effortId ?? null,
        runtimeValues: definedRuntimeValues(target.runtimeValues),
      })
    : selection;

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
        className="flex max-h-[min(88dvh,52rem)] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Tab") trapTab(event, panel.current);
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          {view === "preferences" ? (
            <button
              type="button"
              aria-label="返回模型选择"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-fg"
              onClick={() => setView("quick")}
            >
              <ChevronLeft size={17} />
            </button>
          ) : null}
          <h2 id={`${id}-title`} className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
            {view === "quick" ? "模型选择" : "Agent 配置"}
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
              <ModelPicker
                agents={agents}
                preferences={preferences}
                filterTags={filters}
                automaticTags={mediaTags}
                selected={{
                  agentId: target?.agentId ?? null,
                  modelId: target?.modelId ?? null,
                }}
                disabled={disabled || saving}
                onFilterTags={setFilters}
                onSelect={(route) => setTarget(routeTarget(route))}
              />

              {target ? (
                <div className="rounded-xl border border-line bg-raised/35 p-2.5">
                  <CompactRuntimeControls
                    selection={targetSelection}
                    disabled={disabled || saving}
                    onPickMode={(modeId) => setTarget((current) => current ? { ...current, modeId } : current)}
                    onPickEffort={(effortId) => setTarget((current) => current ? { ...current, effortId } : current)}
                    onPickRuntimeAxis={(axisId, valueId) =>
                      setTarget((current) => current ? {
                        ...current,
                        runtimeValues: { ...current.runtimeValues, [axisId]: valueId },
                      } : current)
                    }
                  />
                </div>
              ) : null}

              <div className="flex items-center justify-between border-t border-line pt-2">
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
                <button
                  type="button"
                  disabled={disabled || saving || !target}
                  className="h-9 rounded-lg bg-accent px-4 text-xs font-medium text-on-accent disabled:opacity-50"
                  onClick={() => {
                    if (!target) return;
                    setSaving(true);
                    Promise.resolve(onPickTarget(target, filters))
                      .then(onClose)
                      .finally(() => setSaving(false));
                  }}
                >
                  {saving ? "切换中…" : "使用此模型"}
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
                setFilters(normalizeGroupedTags(filters, next));
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

function targetFrom(selection: RuntimeSelection): SessionAgentTarget | null {
  if (!selection.current) return null;
  return {
    agentId: selection.current.id,
    ...(selection.model ? { modelId: selection.model.id } : {}),
    ...(selection.mode ? { modeId: selection.mode.id } : {}),
    ...(selection.effortId ? { effortId: selection.effortId } : {}),
    runtimeValues: selection.runtimeValues,
  };
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
