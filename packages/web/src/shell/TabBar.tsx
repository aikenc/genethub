import { useWorkbench } from "../session/store";

/**
 * Closable panes across the top of the workspace.
 *
 * These are work surfaces, not a site nav: opening Changes on the right does
 * not close the chat tab, and closing a tab removes it from the strip.
 */
export function TabBar() {
  const { tabs, activeTabId, activateTab, closeTab, rightPanel, setRightPanel, workspaceName } =
    useTabBar();

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-surface">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto touch-pan-x">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`group flex max-w-[14rem] items-center gap-1 border-r border-line px-3 text-xs ${
                active ? "bg-bg text-fg" : "text-muted hover:bg-raised hover:text-fg"
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => activateTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                className="rounded px-1 text-faint opacity-0 hover:bg-line hover:text-fg group-hover:opacity-100"
                onClick={() => closeTab(tab.id)}
              >
                ×
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

      <div className="flex shrink-0 items-center gap-1 border-l border-line px-2">
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
    activeTabId,
    activateTab,
    closeTab,
    rightPanel,
    setRightPanel,
    workspaceName,
  };
}
