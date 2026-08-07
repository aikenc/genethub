import { useEffect, useState } from "react";

import { assetPreviewUrl } from "../preview/url";
import { useWorkbench } from "../session/store";
import { FileTree } from "./FileTree";

/** File-system entry point for the independent, E2EE Asset Preview page. */
export function FilesPanel() {
  const { tree, loadTree, client, activeWorkspaceId } = useWorkbench();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (client && !tree) void loadTree();
  }, [client, tree, loadTree]);

  const open = (path: string) => {
    const deviceHandle = client?.identity?.machineId;
    if (!deviceHandle || !activeWorkspaceId) return;
    setSelected(path);
    const url = assetPreviewUrl(deviceHandle, activeWorkspaceId, path);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="border-b border-line px-3 py-2 text-[11px] text-muted">
        文件会在独立的安全预览页中打开；单个文件上限 2 MiB。
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree ? (
          <FileTree
            root={tree}
            selected={selected}
            onOpen={open}
            onExpand={(path) => void loadTree(path)}
          />
        ) : (
          <p className="p-2 text-xs text-muted">载入中…</p>
        )}
      </div>
    </div>
  );
}
