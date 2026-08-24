import type { ReactNode } from "react";

import type { ExtraTab } from "./tabs";
import { ToolsMenu } from "./ToolsMenu";

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
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="关闭工具"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onNavigate}
        />
      ) : null}
      <aside
        aria-label="工具"
        className={`fixed inset-y-0 right-0 z-40 flex w-[78%] max-w-xs flex-col border-l border-line bg-sidebar transition-transform duration-200 md:hidden ${
          open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div
          className="flex items-center justify-between border-b border-line px-4 pb-3"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          <h2 className="text-base font-medium text-fg">工具</h2>
          <button
            type="button"
            aria-label="关闭工具"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-xl text-muted active:bg-raised"
            onClick={onNavigate}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
        <ToolsMenu extraTabs={extraTabs} onNavigate={onNavigate} density="phone">
          {children}
        </ToolsMenu>
      </aside>
    </>
  );
}
