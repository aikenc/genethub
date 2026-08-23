import type { SessionSummary } from "@genehub/proto";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useWorkbench, type WorkbenchTab } from "../session/store";
import { WorkspaceAffordance } from "../workspace/WorkspaceAffordance";
import { SessionStatusIcon } from "./SessionStatusIcon";
import { TabKindIcon } from "./TabKindIcon";
import { compactAge, useNow } from "./tabAge";
import { tabDisplayTitle, workspaceForTab } from "./tabWorkspace";

/**
 * The phone's way of moving between open tabs.
 *
 * A strip under the header is a second title bar at this width: each tab is
 * too narrow to read, and the close control fights the title for the same
 * 44px. The header already names the current surface, so that name becomes
 * the switcher. Collapsed it stays one line — title, a chevron that says it
 * is tappable, and the running/done counts for the open set. The current
 * tab also has its own close control on this row, so shutting the one you
 * are looking at does not require opening the list. Expanded it is a list,
 * and that is where any other tab is closed.
 */
export function MobileTitleSwitcher({ fallbackTitle }: { fallbackTitle: string }) {
  const { tabs, sessions, activeTabId, activateTab, closeTab, workspaceCtx } = useTitleTabs();
  const [open, setOpen] = useState(false);
  const [panelTop, setPanelTop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const now = useNow();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const title = activeTab ? tabDisplayTitle(activeTab) : fallbackTitle;
  const owned = activeTab ? workspaceForTab(activeTab, workspaceCtx) : undefined;
  const counts = countTabSet(tabs, sessions);
  const switchable = tabs.length > 1;

  useEffect(() => {
    if (tabs.length <= 1) setOpen(false);
  }, [tabs.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const header = root.current?.closest("header");
      setPanelTop(header?.getBoundingClientRect().bottom ?? 0);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!switchable) {
    return (
      <span className="flex min-w-0 flex-1 items-center justify-center gap-0.5 text-sm font-medium text-fg">
        <TabKindIcon kind={activeTab?.kind} />
        <span className="min-w-0 truncate">{title}</span>
        {owned ? <WorkspaceAffordance workspace={owned} /> : null}
      </span>
    );
  }

  return (
    <div ref={root} className="flex min-w-0 flex-1 items-center">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={switcherLabel(title, counts, tabs.length)}
        className="flex h-11 min-w-0 flex-1 items-center justify-center gap-0.5 rounded-lg px-1 text-sm font-medium text-fg active:bg-raised"
        onClick={() => setOpen((current) => !current)}
      >
        <TabKindIcon kind={activeTab?.kind} />
        <span className="min-w-0 truncate">{title}</span>
        {owned ? <WorkspaceAffordance workspace={owned} className="max-w-[4.5rem]" /> : null}
        <ChevronDown
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
        <TabSetCounts counts={counts} />
      </button>
      {activeTabId ? (
        <button
          type="button"
          aria-label={`关闭当前标签 ${title}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lg text-faint active:bg-raised active:text-fg"
          onClick={() => closeTab(activeTabId)}
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
      {open ? (
        <div
          role="listbox"
          aria-label="已打开的标签"
          className="fixed inset-x-0 z-20 max-h-[min(24rem,70vh)] overflow-y-auto border-b border-line bg-surface py-1 shadow-[0_12px_32px_rgb(0_0_0_/0.28)]"
          style={{ top: panelTop }}
        >
          <p className="px-3 pb-1 pt-0.5 text-[11px] leading-4 text-faint">
            点一项打开 · 右侧关闭
          </p>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            const summary = tab.sessionId
              ? sessions.find((session) => session.id === tab.sessionId)
              : undefined;
            const rowTitle = tabDisplayTitle(tab);
            const rowOwned = workspaceForTab(tab, workspaceCtx);
            const age = compactAge(summary?.updatedAtMs, now);
            return (
              <div
                key={tab.id}
                className={`flex items-stretch ${
                  active ? "bg-bg text-fg" : "text-muted"
                }`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2.5 text-left text-sm !min-h-11"
                  onClick={() => {
                    activateTab(tab.id);
                    setOpen(false);
                  }}
                >
                  {tab.kind === "chat" ? (
                    <SessionStatusIcon status={summary?.status} />
                  ) : (
                    <TabKindIcon kind={tab.kind} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{rowTitle}</span>
                  {rowOwned ? <WorkspaceAffordance workspace={rowOwned} /> : null}
                  {age ? (
                    <span
                      className="shrink-0 text-[10px] leading-none text-faint tabular-nums"
                      aria-hidden
                    >
                      {age}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${rowTitle}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center text-faint active:bg-raised active:text-fg"
                  onClick={() => closeTab(tab.id)}
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TabSetCounts({ counts }: { counts: TabSetCounts }) {
  if (counts.running === 0 && counts.completed === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-normal leading-none">
      {counts.running > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-ok" aria-hidden>
          <Loader2 className="h-3 w-3 animate-spin" />
          {counts.running}
        </span>
      ) : null}
      {counts.completed > 0 ? (
        <span className="text-faint" aria-hidden>
          ✓{counts.completed}
        </span>
      ) : null}
    </span>
  );
}

function switcherLabel(title: string, counts: TabSetCounts, tabCount: number): string {
  const parts = [`切换已打开的标签，当前 ${title}`];
  if (counts.running > 0) parts.push(`${counts.running} 个进行中`);
  if (counts.completed > 0) parts.push(`${counts.completed} 个已完成`);
  parts.push(`共 ${tabCount} 个`);
  return parts.join("，");
}

/**
 * Chat tabs are the tasks. Files, settings and the rest stay in the list
 * but do not pretend to be work that is running or finished.
 */
export function countTabSet(
  tabs: WorkbenchTab[],
  sessions: SessionSummary[],
): TabSetCounts {
  let running = 0;
  let completed = 0;
  for (const tab of tabs) {
    if (tab.kind !== "chat" || !tab.sessionId) continue;
    const status = sessions.find((session) => session.id === tab.sessionId)?.status;
    if (status === "running" || status === "waiting") running += 1;
    else completed += 1;
  }
  return { running, completed };
}

type TabSetCounts = { running: number; completed: number };

function useTitleTabs() {
  const tabs = useWorkbench((state) => state.tabs);
  const activeTabId = useWorkbench((state) => state.activeTabId);
  const sessions = useWorkbench((state) => state.sessions);
  const activateTab = useWorkbench((state) => state.activateTab);
  const closeTab = useWorkbench((state) => state.closeTab);
  const workspaces = useWorkbench((state) => state.workspaces);
  const activeWorkspaceId = useWorkbench((state) => state.activeWorkspaceId);
  const draftWorkspaceId = useWorkbench((state) => state.draft?.workspaceId ?? null);
  return {
    tabs,
    sessions,
    activeTabId,
    activateTab,
    closeTab,
    workspaceCtx: { sessions, workspaces, activeWorkspaceId, draftWorkspaceId },
  };
}
