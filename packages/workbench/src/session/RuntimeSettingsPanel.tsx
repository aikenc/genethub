import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { RuntimeSettings } from "./RuntimeSettings";
import type { RuntimeSelection } from "./runtime-selection";

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
  onPickRuntimeAxis,
  onRefreshAgents,
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
  onPickRuntimeAxis(axisId: string, valueId: string): void;
  onRefreshAgents?(): void;
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
      const chosen = panel.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]:not(:disabled)',
      );
      (chosen ?? close.current)?.focus();
    });
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);

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
        className="flex max-h-[min(78dvh,44rem)] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            trapTab(event, panel.current);
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="text-sm font-medium text-fg">
              Agent 与运行设置
            </h2>
            <p className="text-[11px] text-faint">设置会用于下一条消息</p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭运行设置"
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <RuntimeSettings
            selection={selection}
            disabled={disabled}
            agentLocked={agentLocked}
            onPickAgent={onPickAgent}
            onPickModel={onPickModel}
            onPickMode={onPickMode}
            onPickEffort={onPickEffort}
            onPickRuntimeAxis={onPickRuntimeAxis}
            onRefreshAgents={onRefreshAgents}
          />
        </div>
      </section>
    </div>,
    document.body,
  );
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
