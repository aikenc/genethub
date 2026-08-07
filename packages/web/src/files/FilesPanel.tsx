import { useCallback, useEffect, useRef, useState } from "react";

import { assetPreviewUrl } from "../preview/url";
import { useWorkbench } from "../session/store";
import { FileTree } from "./FileTree";

/** File-system entry point for the independent, E2EE Asset Preview page. */
export function FilesPanel() {
  const { tree, loadTree, client, activeWorkspaceId } = useWorkbench();
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Browsers commonly dispatch visibilitychange and focus together. One
    // request is enough, and prevents an older root response racing a newer
    // one back into the shared tree.
    if (!client || !activeWorkspaceId || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await loadTree();
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [activeWorkspaceId, client, loadTree]);
  const expand = useCallback((path: string) => {
    void loadTree(path);
  }, [loadTree]);

  useEffect(() => {
    // Mounting the pane is itself a refresh. The tree lives in the shared store,
    // so checking only `!tree` left a reopened Files tab permanently stale.
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const open = (path: string) => {
    const deviceHandle = client?.identity?.machineId;
    if (!deviceHandle || !activeWorkspaceId) return;
    setSelected(path);
    const url = assetPreviewUrl(deviceHandle, activeWorkspaceId, path);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 text-[11px] text-muted">
        <p className="min-w-0 flex-1">文件会在独立预览页打开；单个文件上限 4 MiB。</p>
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-accent hover:bg-raised disabled:text-faint"
          disabled={refreshing || !client || !activeWorkspaceId}
          onClick={() => void refresh()}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree ? (
          <FileTree
            root={tree}
            selected={selected}
            onOpen={open}
            onExpand={expand}
          />
        ) : (
          <p className="p-2 text-xs text-muted">载入中…</p>
        )}
      </div>
    </div>
  );
}
