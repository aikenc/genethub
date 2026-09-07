import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Workspace management belongs to the whole window, including on phones. */
export function WorkspaceDetailsDialog({ children, onClose, title = "专家详情", fullScreenOnMobile = false }: {
  title?: string;
  fullScreenOnMobile?: boolean;
  children: ReactNode;
  onClose(): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div className={`fixed inset-0 z-[80] flex items-center justify-center bg-black/60 ${fullScreenOnMobile ? "p-0 md:p-5" : "p-3 md:p-5"}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== event.currentTarget) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]',
        ) ?? [])].filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      className={`w-full max-w-3xl overflow-hidden border border-line-strong bg-surface text-fg shadow-2xl ${fullScreenOnMobile ? "h-[100dvh] md:h-auto md:max-h-[88dvh] md:rounded-2xl" : "max-h-[88dvh] rounded-2xl"}`}
    >
      <div className={`flex flex-col ${fullScreenOnMobile ? "h-full md:h-auto md:max-h-[88dvh]" : "max-h-[88dvh]"}`}>
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-medium">{title}</h2>
          <button type="button" autoFocus aria-label={`关闭${title}`} onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-xl text-muted hover:bg-raised">×</button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5 text-sm">{children}</div>
      </div>
    </section>
    </div>,
    document.body,
  );
}
