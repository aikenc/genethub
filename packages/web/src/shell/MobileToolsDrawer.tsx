import type { ReactNode } from "react";

import { useWorkbench } from "../session/store";
import type { ExtraTab } from "./tabs";

/** Phone-only work surfaces, kept separate from the left conversation tree. */
export function MobileToolsDrawer({
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
  const { openTab } = useWorkbench();
  const go = (kind: Parameters<typeof openTab>[0], title?: string) => {
    openTab(kind, title);
    onNavigate();
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="关闭工作区工具"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onNavigate}
        />
      ) : null}
      <aside
        aria-label="工作区工具"
        className={`fixed inset-y-0 right-0 z-40 flex w-[78%] max-w-xs flex-col border-l border-line bg-sidebar transition-transform duration-200 md:hidden ${
          open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div
          className="flex items-center justify-between border-b border-line px-4 pb-3"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <h2 className="text-base font-medium text-fg">工作区工具</h2>
          <button
            type="button"
            aria-label="关闭工作区工具"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-xl text-muted active:bg-raised"
            onClick={onNavigate}
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          <Entry label="文件" onClick={() => go("files")} />
          <Entry label="终端" onClick={() => go("terminal")} />
          <Entry label="设备" onClick={() => go("devices")} />
          {extraTabs.map((tab) => (
            <Entry
              key={tab.id}
              label={tab.label}
              onClick={() => go(`extra:${tab.id}`, tab.label)}
            />
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
      className="flex min-h-11 w-full items-center rounded-xl px-4 text-left text-base text-muted active:bg-sidebar-hover active:text-fg"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
