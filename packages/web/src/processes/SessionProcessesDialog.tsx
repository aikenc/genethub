import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useWorkbench } from "../session/store";
import { ProcessesPanel } from "./ProcessesPanel";

export function SessionProcessesDialog({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose(): void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const title = useWorkbench(
    (state) => state.sessions.find((session) => session.id === sessionId)?.title ?? "这个会话",
  );

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", dismiss);
    const frame = window.requestAnimationFrame(() => close.current?.focus());
    return () => {
      document.removeEventListener("keydown", dismiss);
      window.cancelAnimationFrame(frame);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-processes-title"
        className="flex h-[min(82dvh,38rem)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-surface shadow-2xl md:rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="session-processes-title" className="font-medium text-fg">会话的后台进程</h2>
            <p className="truncate text-xs text-faint">{title} · 只显示这个会话留下的进程</p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label="关闭会话后台进程"
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-raised hover:text-fg"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <ProcessesPanel sessionId={sessionId} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
