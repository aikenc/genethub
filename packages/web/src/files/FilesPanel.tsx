import type { FileNode } from "@genehub/proto";
import { useCallback, useEffect, useRef, useState } from "react";

import { warnOp } from "../session/op-log";
import { useWorkbench } from "../session/store";
import { FileTree } from "./FileTree";

type Clipboard = {
  mode: "copy" | "cut";
  items: Array<{ path: string; name: string }>;
};

type SelectIntent = "copy" | "cut" | "delete";

/** File-system entry point for the in-workbench Asset Preview float. */
export function FilesPanel() {
  const { tree, loadTree, client, activeWorkspaceId, openPreviewFloat } = useWorkbench();
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [focusIsDir, setFocusIsDir] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("新建文件夹");
  const [selectIntent, setSelectIntent] = useState<SelectIntent | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
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
  const expand = useCallback(
    (path: string) => {
      void loadTree(path);
    },
    [loadTree],
  );

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
    openPreviewFloat({
      deviceHandle,
      workspaceHandle: activeWorkspaceId,
      path,
    });
  };

  const activate = (path: string, node: FileNode) => {
    setFocusPath(path);
    setFocusIsDir(node.isDir);
    setError(null);
  };

  const toggleChecked = (path: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const beginSelect = (intent: SelectIntent) => {
    setSelectIntent(intent);
    setChecked(new Set());
    setCreating(false);
    setError(null);
  };

  const cancelSelect = () => {
    setSelectIntent(null);
    setChecked(new Set());
  };

  const targetDirectory = () => {
    if (!tree) return null;
    if (!focusPath) return tree.path || null;
    return focusIsDir ? focusPath : parentPath(focusPath);
  };

  const run = async (op: string, action: () => Promise<void>) => {
    if (!client || !activeWorkspaceId) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadTree();
      const directory = targetDirectory();
      if (directory) await loadTree(directory);
    } catch (failure) {
      setError(warnOp(op, failure));
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    const directory = targetDirectory();
    const name = newFolderName.trim();
    if (!directory || !name) {
      setError("请选择位置并输入文件夹名称");
      return;
    }
    const path = joinPath(directory, name);
    await run("file.mkdir", async () => {
      const reply = await client!.call({
        type: "file.mkdir",
        payload: { workspaceId: activeWorkspaceId!, path },
      });
      if (reply && reply.type !== "ack") throw new Error("创建文件夹失败");
      setCreating(false);
      setNewFolderName("新建文件夹");
      setFocusPath(path);
      setFocusIsDir(true);
    });
  };

  const pasteClipboard = async () => {
    if (!clipboard) return;
    const directory = targetDirectory();
    if (!directory) {
      setError("请先点开目标文件夹，再粘贴");
      return;
    }
    for (const item of clipboard.items) {
      if (directory === item.path || directory.startsWith(`${item.path}/`)) {
        setError("不能粘贴到自身内部");
        return;
      }
    }
    const op = clipboard.mode === "copy" ? "file.copy" : "file.move";
    await run(op, async () => {
      let lastPath: string | null = null;
      for (const item of clipboard.items) {
        const to = uniqueChildPath(directory, item.name, tree);
        if (clipboard.mode === "copy") {
          const reply = await client!.call({
            type: "file.copy",
            payload: {
              workspaceId: activeWorkspaceId!,
              from: item.path,
              to,
            },
          });
          if (reply && reply.type !== "ack") throw new Error("复制失败");
        } else {
          const reply = await client!.call({
            type: "file.move",
            payload: {
              workspaceId: activeWorkspaceId!,
              from: item.path,
              to,
            },
          });
          if (reply && reply.type !== "ack") throw new Error("移动失败");
        }
        lastPath = to;
      }
      if (clipboard.mode === "cut") {
        setClipboard(null);
        if (lastPath) {
          setFocusPath(lastPath);
          setFocusIsDir(false);
        }
      }
    });
  };

  const confirmSelect = async () => {
    if (!selectIntent || checked.size === 0) {
      setError("请先勾选要操作的文件或文件夹");
      return;
    }
    const paths = [...checked];
    if (selectIntent === "copy" || selectIntent === "cut") {
      setClipboard({
        mode: selectIntent,
        items: paths.map((path) => ({ path, name: baseName(path) })),
      });
      cancelSelect();
      setError(null);
      return;
    }

    const label =
      paths.length === 1 ? `「${baseName(paths[0]!)}」` : `${paths.length} 个项目`;
    if (!window.confirm(`确定删除${label}？此操作不可撤销。`)) return;
    await run("file.delete", async () => {
      const reply = await client!.call({
        type: "file.delete",
        payload: { workspaceId: activeWorkspaceId!, paths },
      });
      if (reply && reply.type !== "ack") throw new Error("删除失败");
      if (clipboard?.items.some((item) => paths.includes(item.path))) {
        setClipboard(null);
      }
      if (focusPath && paths.includes(focusPath)) {
        setFocusPath(null);
      }
      cancelSelect();
    });
  };

  const selecting = selectIntent !== null;
  const intentLabel =
    selectIntent === "copy" ? "复制" : selectIntent === "cut" ? "剪切" : "删除";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5 text-[11px]">
        {selecting ? (
          <>
            <span className="px-1 text-muted">
              选择要{intentLabel}的项（已选 {checked.size}）
            </span>
            <button
              type="button"
              className="rounded px-2 py-1 text-muted hover:bg-raised"
              disabled={busy}
              onClick={cancelSelect}
            >
              取消
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 text-white disabled:opacity-40 ${
                selectIntent === "delete" ? "bg-danger" : "bg-accent"
              }`}
              disabled={busy || checked.size === 0}
              onClick={() => void confirmSelect()}
            >
              确认{intentLabel}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="rounded px-2 py-1 text-accent hover:bg-raised disabled:text-faint"
              disabled={busy || !client || !activeWorkspaceId || !tree}
              onClick={() => {
                setNewFolderName("新建文件夹");
                setCreating(true);
                setError(null);
              }}
            >
              新建文件夹
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-muted hover:bg-raised disabled:text-faint"
              disabled={busy || !tree}
              onClick={() => beginSelect("copy")}
            >
              复制
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-muted hover:bg-raised disabled:text-faint"
              disabled={busy || !tree}
              onClick={() => beginSelect("cut")}
            >
              剪切
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-muted hover:bg-raised disabled:text-faint"
              disabled={busy || !clipboard || !tree}
              onClick={() => void pasteClipboard()}
            >
              粘贴
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-danger hover:bg-raised disabled:text-faint"
              disabled={busy || !tree}
              onClick={() => beginSelect("delete")}
            >
              删除
            </button>
          </>
        )}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-accent hover:bg-raised disabled:text-faint"
          disabled={refreshing || busy || !client || !activeWorkspaceId}
          onClick={() => void refresh()}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      {clipboard && !selecting ? (
        <p className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-faint">
          已{clipboard.mode === "copy" ? "复制" : "剪切"}{" "}
          {clipboard.items.length === 1
            ? clipboard.items[0]!.name
            : `${clipboard.items.length} 项`}
          ，点开目标文件夹后粘贴
        </p>
      ) : null}
      {creating && !selecting ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-line bg-raised px-2 py-1 text-sm text-fg outline-none focus:border-accent"
            value={newFolderName}
            aria-label="新文件夹名称"
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createFolder();
              }
              if (event.key === "Escape") setCreating(false);
            }}
          />
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted hover:bg-raised"
            onClick={() => setCreating(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-40"
            disabled={busy || !newFolderName.trim()}
            onClick={() => void createFolder()}
          >
            创建
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-danger">{error}</p>
      ) : (
        <p className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-muted">
          {selecting
            ? `勾选后点确认${intentLabel}；点左侧三角仍可展开文件夹。`
            : "点击预览文件；复制/剪切/删除先选再确认。单个预览上限 4 MiB。"}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree ? (
          <FileTree
            root={tree}
            selected={focusPath}
            checked={checked}
            selecting={selecting}
            onOpen={open}
            onExpand={expand}
            onActivate={activate}
            onToggle={toggleChecked}
          />
        ) : (
          <p className="p-3 text-xs text-muted">加载文件树…</p>
        )}
      </div>
    </div>
  );
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function uniqueChildPath(directory: string, name: string, tree: FileNode | null): string {
  const taken = new Set<string>();
  collectNamesUnder(tree, directory, taken);
  if (!taken.has(name.toLowerCase())) return joinPath(directory, name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return joinPath(directory, candidate);
  }
  return joinPath(directory, `${stem}-${Date.now()}${ext}`);
}

function collectNamesUnder(node: FileNode | null, directory: string, taken: Set<string>) {
  if (!node) return;
  if (node.path === directory) {
    for (const child of node.children ?? []) taken.add(child.name.toLowerCase());
    return;
  }
  for (const child of node.children ?? []) collectNamesUnder(child, directory, taken);
}
