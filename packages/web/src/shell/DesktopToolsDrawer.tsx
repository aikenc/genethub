import type { ReactNode } from "react";

import { useWorkbench } from "../session/store";
import type { ExtraTab } from "./tabs";

/** Desktop counterpart to the phone tools drawer. It keeps workbench actions
 * away from the composer, whose lower-right corner is reserved for Send. */
export function DesktopToolsDrawer({
  open,
  extraTabs,
  onNavigate,
  children,
}: {
  open: boolean;
  extraTabs: ExtraTab[];
  onNavigate(): void;
  children?: ReactNode;
}) {
  const { openTab, setRightPanel } = useWorkbench();
  const go = (kind: Parameters<typeof openTab>[0], title?: string) => {
    openTab(kind, title);
    onNavigate();
  };
  const openPanel = (panel: "changes" | "files") => {
    setRightPanel(panel);
    onNavigate();
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="关闭右侧工作区工具"
          className="fixed inset-0 z-30 hidden bg-black/20 md:block"
          onClick={onNavigate}
        />
      ) : null}
      <aside
        aria-label="右侧工作区工具"
        className={`fixed inset-y-0 right-0 z-40 hidden w-80 flex-col border-l border-line bg-sidebar shadow-2xl transition-transform duration-200 md:flex ${
          open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-medium text-fg">工作区工具</h2>
          <button
            type="button"
            aria-label="关闭右侧工作区工具"
            className="flex h-8 w-8 items-center justify-center rounded text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={onNavigate}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          <Entry label="Changes" onClick={() => openPanel("changes")} />
          <Entry label="文件" onClick={() => openPanel("files")} />
          <Entry label="终端" onClick={() => go("terminal")} />
          <Entry label="设备" onClick={() => go("devices")} />
          {extraTabs.map((tab) => (
            <Entry key={tab.id} label={tab.label} onClick={() => go(`extra:${tab.id}`, tab.label)} />
          ))}
          <Entry label="设置" onClick={() => go("settings")} />
          {children}
        </nav>
      </aside>
    </>
  );
}

function Entry({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center rounded-lg px-3 text-left text-sm text-muted hover:bg-sidebar-hover hover:text-fg"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
