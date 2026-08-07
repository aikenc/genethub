import { useEffect, useRef } from "react";

import { useWorkbench } from "../session/store";
import { SessionStatusIcon } from "./SessionStatusIcon";

/**
 * Closable panes across the top of the workspace.
 *
 * These are work surfaces, not a site nav: opening Changes on the right does
 * not close the chat tab, and closing a tab removes it from the strip.
 */
export function TabBar({ onOpenTools = () => {} }: { onOpenTools?(): void }) {
  const { tabs, sessions, activeTabId, activateTab, closeTab, workspaceName } = useTabBar();
  const strip = useWheelPannedStrip();

  return (
    <div
      // One tab on a phone is not a strip, it is a second title bar under the
      // first: the header above already says which conversation this is, and
      // the drawer is how you get to another. It appears once there is a
      // choice to make.
      className={`${
        tabs.length > 1 ? "flex" : "hidden"
      } h-11 shrink-0 items-stretch overflow-hidden border-b border-line bg-surface md:flex md:h-9`}
    >
      <div
        ref={strip}
        // overflow-x alone would promote overflow-y to auto, and any one-pixel
        // taller child (a 44px phone button inside a 44px row, a focus ring)
        // drew a vertical scrollbar on a strip that only ever moves sideways.
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const status = tab.sessionId
            ? sessions.find((session) => session.id === tab.sessionId)?.status
            : undefined;
          return (
            <div
              key={tab.id}
              // A phone gets a fixed share of the strip rather than a width
              // taken from the title: two full-width tabs read as a strip with
              // nothing else in it, so the fourth tab is cut off mid-way to say
              // out loud that the strip keeps going. The size is written out
              // rather than taken from `text-xs`, which the shared phone
              // typography lifts to 14px for body copy this strip is not.
              className={`group flex w-[28.5%] shrink-0 grow items-center gap-1 border-r border-line pl-2 pr-0.5 text-[0.75rem] leading-4 md:w-auto md:max-w-[14rem] md:shrink md:grow-0 md:pl-3 md:pr-3 ${
                active ? "bg-bg text-fg" : "text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {tab.kind === "chat" ? <SessionStatusIcon status={status} /> : null}
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-2 text-left !min-h-0"
                onClick={() => activateTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                // Hover is the one thing a phone cannot do, so on touch the
                // close control is simply there. It opts out of the 44px square
                // every other phone button gets: at that width three of them
                // fill the strip, and the row is already 44px tall, so the
                // thumb keeps the travel it actually aims along.
                className="flex h-11 w-7 shrink-0 items-center justify-center rounded text-faint !min-h-0 !min-w-0 hover:bg-line hover:text-fg md:h-auto md:w-auto md:px-1 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                onClick={() => closeTab(tab.id)}
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          );
        })}
        {tabs.length === 0 ? (
          <div className="flex items-center px-3 text-xs text-faint">
            {workspaceName ?? "工作台"}
          </div>
        ) : null}
      </div>

      {/* Keep secondary tools out of the composer corner. The drawer also
          houses product-specific actions such as feedback. */}
      <div className="hidden shrink-0 items-center gap-1 border-l border-line px-2 md:flex">
        <button
          type="button"
          aria-label="打开右侧工作区工具"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg"
          onClick={onOpenTools}
        >
          工具
        </button>
      </div>
    </div>
  );
}

/**
 * Lets a plain up/down wheel or trackpad gesture travel along the strip.
 *
 * A tab strip is the one horizontal scroller most pointing devices cannot
 * address: a mouse offers only a vertical wheel, so tabs past the right edge
 * were unreachable without dragging. The listener is native and non-passive
 * because React delivers `wheel` passively and could not cancel the page
 * scroll. At either end the gesture is handed back untouched, so a wheel over
 * the strip never traps the page.
 */
function useWheelPannedStrip() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;

    const pan = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const travel = strip.scrollWidth - strip.clientWidth;
      if (travel <= 0) return;
      const next = Math.min(Math.max(strip.scrollLeft + event.deltaY, 0), travel);
      if (next === strip.scrollLeft) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };

    strip.addEventListener("wheel", pan, { passive: false });
    return () => strip.removeEventListener("wheel", pan);
  }, []);

  return ref;
}

function useTabBar() {
  const tabs = useWorkbench((state) => state.tabs);
  const activeTabId = useWorkbench((state) => state.activeTabId);
  const sessions = useWorkbench((state) => state.sessions);
  const activateTab = useWorkbench((state) => state.activateTab);
  const closeTab = useWorkbench((state) => state.closeTab);
  const workspaces = useWorkbench((state) => state.workspaces);
  const activeWorkspaceId = useWorkbench((state) => state.activeWorkspaceId);
  const workspaceName =
    workspaces.find((entry) => entry.id === activeWorkspaceId)?.name ?? workspaces[0]?.name;
  return {
    tabs,
    sessions,
    activeTabId,
    activateTab,
    closeTab,
    workspaceName,
  };
}
