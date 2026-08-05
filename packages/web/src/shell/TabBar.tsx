import { useWorkbench } from "../session/store";
import { SessionStatusIcon } from "./SessionStatusIcon";

/**
 * Closable panes across the top of the workspace.
 *
 * These are work surfaces, not a site nav: opening Changes on the right does
 * not close the chat tab, and closing a tab removes it from the strip.
 */
export function TabBar() {
  const { tabs, sessions, activeTabId, activateTab, closeTab, rightPanel, setRightPanel, workspaceName } =
    useTabBar();

  return (
    <div
      // One tab on a phone is not a strip, it is a second title bar under the
      // first: the header above already says which conversation this is, and
      // the drawer is how you get to another. It appears once there is a
      // choice to make.
      className={`${
        tabs.length > 1 ? "flex" : "hidden"
      } h-11 shrink-0 items-stretch border-b border-line bg-surface md:flex md:h-9`}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overscroll-x-contain">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const status = tab.sessionId
            ? sessions.find((session) => session.id === tab.sessionId)?.status
            : undefined;
          return (
            <div
              key={tab.id}
              className={`group flex max-w-[14rem] items-center gap-1 border-r border-line pl-3 pr-1 text-sm md:pr-3 md:text-xs ${
                active ? "bg-bg text-fg" : "text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {tab.kind === "chat" ? <SessionStatusIcon status={status} /> : null}
              <button
                type="button"
                className="min-w-0 flex-1 truncate py-2 text-left"
                onClick={() => activateTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                // Hover is the one thing a phone cannot do, so on touch the
                // close control is simply there, at a size a thumb can hit.
                className="flex h-9 w-9 items-center justify-center rounded text-faint hover:bg-line hover:text-fg md:h-auto md:w-auto md:px-1 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
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

      {/* Both open a panel that is docked to the right of the chat, and that
          panel is desktop-only — on a phone these were two buttons that did
          nothing at all. */}
      <div className="hidden shrink-0 items-center gap-1 border-l border-line px-2 md:flex">
        <PanelToggle
          label="Changes"
          active={rightPanel === "changes"}
          onClick={() => setRightPanel(rightPanel === "changes" ? null : "changes")}
        />
        <PanelToggle
          label="Files"
          active={rightPanel === "files"}
          onClick={() => setRightPanel(rightPanel === "files" ? null : "files")}
        />
      </div>
    </div>
  );
}

function PanelToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`rounded px-2 py-1 text-xs ${
        active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function useTabBar() {
  const tabs = useWorkbench((state) => state.tabs);
  const activeTabId = useWorkbench((state) => state.activeTabId);
  const sessions = useWorkbench((state) => state.sessions);
  const activateTab = useWorkbench((state) => state.activateTab);
  const closeTab = useWorkbench((state) => state.closeTab);
  const rightPanel = useWorkbench((state) => state.rightPanel);
  const setRightPanel = useWorkbench((state) => state.setRightPanel);
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
    rightPanel,
    setRightPanel,
    workspaceName,
  };
}
