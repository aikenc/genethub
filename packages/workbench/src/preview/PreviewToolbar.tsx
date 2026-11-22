import { ArrowLeft, ArrowRight, Info, X } from "lucide-react";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PreviewToolbarContext = createContext<HTMLElement | null>(null);
export const PreviewFileFeedbackOpenContext = createContext<(() => void) | null>(null);
export const PreviewProductFeedbackContext = createContext<(() => void) | null>(null);
export const PreviewShareOpenContext = createContext<(() => void) | null>(null);

type Slot = "navigation" | "controls" | "capture" | "selection" | "share" | "feedback" | "logs";

export const previewIconButton =
  "inline-flex size-8 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg disabled:opacity-35";
export const previewTextButton =
  "inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded px-2 text-xs text-fg hover:bg-raised disabled:opacity-40";

export function PreviewToolbarPortal({ children, slot = "controls" }: { children: ReactNode; slot?: Slot }) {
  const toolbar = useContext(PreviewToolbarContext);
  const target = toolbar?.querySelector(`[data-preview-slot="${slot}"]`) ?? toolbar;
  if (target) return createPortal(children, target);
  if (slot === "logs") return null;
  return <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 text-xs">{children}</div>;
}

export function PreviewNavigation({ back, forward }: { back?: () => void; forward?: () => void }) {
  return <PreviewToolbarPortal slot="navigation">
    <button type="button" className={previewIconButton} title="后退" aria-label="后退" disabled={!back} onClick={back}><ArrowLeft size={16} /></button>
    <button type="button" className={previewIconButton} title="前进" aria-label="前进" disabled={!forward} onClick={forward}><ArrowRight size={16} /></button>
  </PreviewToolbarPortal>;
}

export function PreviewShareAction() {
  const share = useContext(PreviewShareOpenContext);
  return share ? <PreviewToolbarPortal slot="share"><button type="button" className={`${previewTextButton} bg-accent text-white hover:opacity-90`} onClick={share}>分享</button></PreviewToolbarPortal> : null;
}

export function PreviewShell({
  bindTools, navigation, information, children, readOnly = false,
}: {
  bindTools: (element: HTMLDivElement | null) => void;
  navigation?: ReactNode;
  information: ReactNode;
  children: ReactNode;
  readOnly?: boolean;
}) {
  const [surface, setSurface] = useState<"info" | "feedback" | null>(null);
  const [tab, setTab] = useState<"feedback" | "logs">("feedback");
  const id = useId();
  const toggle = (name: NonNullable<typeof surface>) => setSurface(previous => previous === name ? null : name);
  return <div ref={bindTools} className="relative flex min-h-0 flex-1 flex-col"
    onClick={event => {
      if (event.target instanceof Element && event.target.closest("[data-preview-dismiss]")) setSurface(null);
    }}
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented && surface) {
        event.stopPropagation();
        setSurface(null);
        event.currentTarget.querySelector<HTMLButtonElement>(`[aria-controls="${id}-${surface}"]`)?.focus();
      }
    }}>
    <header aria-label="预览工具栏" className="gh-preview-toolbar relative z-30 flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-1 sm:gap-1 sm:px-2">
      {navigation}
      <div data-preview-slot="navigation" className="flex shrink-0 items-center" />
      <button type="button" className={previewIconButton} title="预览信息" aria-label="预览信息" aria-expanded={surface === "info"}
        aria-controls={id + "-info"} onClick={() => toggle("info")}><Info size={16} /></button>
      <div data-preview-slot="controls" className="flex min-w-0 flex-1 items-center gap-1" />
      <div data-preview-slot="selection" className="peer empty:hidden" />
      <button type="button" className={`${previewTextButton} peer-[:not(:empty)]:hidden`} aria-expanded={surface === "feedback"} aria-controls={id + "-feedback"}
        onClick={() => toggle("feedback")}>{readOnly ? "日志" : "反馈"}</button>
      <div data-preview-slot="capture" className="flex shrink-0 items-center" />
      <div data-preview-slot="share" className="flex shrink-0 items-center" />
    </header>
    <div className="relative flex min-h-0 flex-1">
      <aside id={id + "-info"} hidden={surface !== "info"} aria-label="预览信息"
        className="absolute inset-y-0 left-0 z-20 w-64 max-w-[90%] overflow-auto border-r border-line bg-surface p-3 text-xs shadow-lg sm:relative sm:shadow-none">
        <div className="mb-2 flex items-center justify-between"><strong>预览信息</strong>
          <button type="button" className={previewIconButton} aria-label="关闭信息" onClick={() => setSurface(null)}><X size={16} /></button></div>
        {information}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      <aside id={id + "-feedback"} hidden={surface !== "feedback"} aria-label="反馈与日志"
        className="absolute inset-x-0 bottom-0 z-20 max-h-[60dvh] overflow-auto border-t border-line bg-surface p-3 text-xs shadow-lg sm:relative sm:inset-auto sm:max-h-none sm:w-72 sm:border-l sm:border-t-0 sm:shadow-none">
        <div className="mb-2 flex items-center gap-1 border-b border-line pb-1">
          {!readOnly ? <button type="button" className={previewTextButton} aria-pressed={tab === "feedback"} onClick={() => setTab("feedback")}>意见</button> : null}
          <button type="button" className={previewTextButton} aria-pressed={readOnly || tab === "logs"} onClick={() => setTab("logs")}>运行日志</button>
          <span className="flex-1" />
          <button type="button" className={previewIconButton} aria-label="关闭反馈面板" onClick={() => setSurface(null)}><X size={16} /></button>
        </div>
        <div data-preview-slot="feedback" hidden={readOnly || tab !== "feedback"} className="space-y-2 [&:empty]:before:content-['当前预览没有可用的意见工具']" />
        <div data-preview-slot="logs" hidden={!readOnly && tab !== "logs"} className="[&:empty]:before:content-['当前预览没有运行日志']" />
      </aside>
    </div>
  </div>;
}
