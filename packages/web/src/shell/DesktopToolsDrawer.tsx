import type { ReactNode } from "react";

import type { ExtraTab } from "./tabs";
import { ToolsMenu } from "./ToolsMenu";

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
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="关闭右侧工具"
          className="fixed inset-0 z-30 hidden bg-black/20 md:block"
          onClick={onNavigate}
        />
      ) : null}
      <aside
        aria-label="右侧工具"
        className={`fixed inset-y-0 right-0 z-40 hidden w-80 flex-col border-l border-line bg-sidebar shadow-2xl transition-transform duration-200 md:flex ${
          open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-medium text-fg">工具</h2>
          <button
            type="button"
            aria-label="关闭右侧工具"
            className="flex h-8 w-8 items-center justify-center rounded text-lg text-muted hover:bg-raised hover:text-fg"
            onClick={onNavigate}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <ToolsMenu extraTabs={extraTabs} onNavigate={onNavigate}>
          {children}
        </ToolsMenu>
      </aside>
    </>
  );
}
