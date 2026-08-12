import type { DirectoryListing } from "@genehub/proto";
import { useState } from "react";
import { createPortal } from "react-dom";

import type { Endpoint, Host } from "../host";
import { warnOp } from "../session/op-log";
import { useWorkbench } from "../session/store";
import { ProjectIcon } from "./WorkspaceIcon";

/**
 * How a folder or saved VS Code workspace gets onto the workbench.
 *
 * A local daemon uses the operating system picker. A remote daemon exposes its
 * own directory tree through the connection, so choosing a folder stays a
 * browse operation instead of becoming a memory test for an absolute path.
 *
 * On Windows the remote picker climbs past a drive root into a machine-roots
 * listing so the person can switch disks without typing a path.
 */
export function OpenProject({
  host,
  endpoint,
  onOpened,
  compact = false,
}: {
  host: Host;
  endpoint: Endpoint;
  onOpened?: () => void;
  compact?: boolean;
}) {
  const openWorkspace = useWorkbench((state) => state.openWorkspace);
  const client = useWorkbench((state) => state.client);
  const workspaces = useWorkbench((state) => state.workspaces);
  const activeWorkspaceId = useWorkbench((state) => state.activeWorkspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<DirectoryListing | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("新建文件夹");
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const rememberedDirectory = () => recallPickerDirectory(endpoint);
  const startingDirectory = () => activeWorkspace?.root ?? rememberedDirectory();

  const open = async (root: string) => {
    if (!root.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(root.trim());
      rememberPickerDirectory(
        endpoint,
        isWorkspaceFile(root) ? (picker?.path ?? parentDirectory(root)) : root,
      );
      setPicker(null);
      setCreating(false);
      onOpened?.();
    } catch (failure) {
      setError(warnOp("workspace.open", failure));
    } finally {
      setBusy(false);
    }
  };

  const canBrowseThisMachine = endpoint.via === "loopback" && host.pickDirectory;

  const pickNative = async (
    pick: (initialDirectory?: string) => Promise<string | null>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const picked = await pick(startingDirectory());
      if (picked) await open(picked);
    } catch (failure) {
      setError(warnOp("workspace.pick", failure));
    } finally {
      setBusy(false);
    }
  };

  const readDirectory = async (path?: string) => {
    if (!client) throw new Error("设备尚未连接");
    const reply = await client.call({
      type: "directory.list",
      payload: { path: path ?? null },
    });
    if (reply?.type !== "directory") throw new Error("设备没有返回目录列表");
    return reply.data;
  };

  const browse = async (path?: string) => {
    setPickerBusy(true);
    setError(null);
    setCreating(false);
    try {
      const listing = await readDirectory(path);
      setPicker(listing);
      if (!listing.roots) rememberPickerDirectory(endpoint, listing.path);
    } catch (failure) {
      setError(warnOp("directory.list", failure));
    } finally {
      setPickerBusy(false);
    }
  };

  const beginBrowse = async () => {
    if (!client) return;
    setPickerBusy(true);
    setError(null);
    const starts: Array<string | undefined> = [];
    for (const candidate of [activeWorkspace?.root, rememberedDirectory()]) {
      if (candidate && !starts.includes(candidate)) starts.push(candidate);
    }
    // Let the daemon choose its home only after the two user-owned hints.
    starts.push(undefined);
    let failure: unknown = new Error("无法读取目录");
    for (const start of starts) {
      try {
        const listing = await readDirectory(start);
        setPicker(listing);
        if (!listing.roots) rememberPickerDirectory(endpoint, listing.path);
        setPickerBusy(false);
        return;
      } catch (error) {
        failure = error;
      }
    }
    setError(warnOp("directory.list", failure));
    setPickerBusy(false);
  };

  const createFolder = async () => {
    if (!client || !picker || picker.roots) return;
    const name = newFolderName.trim();
    if (!name) {
      setError("请输入文件夹名称");
      return;
    }
    setPickerBusy(true);
    setError(null);
    try {
      const reply = await client.call({
        type: "directory.mkdir",
        payload: { parent: picker.path, name },
      });
      if (reply?.type !== "directory") throw new Error("设备没有返回目录列表");
      setPicker(reply.data);
      rememberPickerDirectory(endpoint, reply.data.path);
      setCreating(false);
      setNewFolderName("新建文件夹");
    } catch (failure) {
      setError(warnOp("directory.mkdir", failure));
    } finally {
      setPickerBusy(false);
    }
  };

  if (canBrowseThisMachine) {
    return (
      <div className={compact ? "flex flex-col gap-1" : "flex flex-col items-center gap-2"}>
        <button
          type="button"
          className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={busy}
          onClick={() => void pickNative(host.pickDirectory!)}
        >
          {busy ? "打开中…" : "打开项目文件夹…"}
        </button>
        {host.pickWorkspaceFile ? (
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:bg-raised disabled:opacity-40"
            disabled={busy}
            onClick={() => void pickNative(host.pickWorkspaceFile!)}
          >
            打开 .code-workspace…
          </button>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className={compact ? "" : "flex flex-col items-center gap-2"}>
      <button
        type="button"
        className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
        disabled={busy || pickerBusy || !client}
        onClick={() => void beginBrowse()}
      >
        {pickerBusy ? "读取中…" : "选择文件夹或 .code-workspace…"}
      </button>
      {error && !picker ? <p className="text-xs text-danger">{error}</p> : null}
      {picker
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={
                picker.roots
                  ? "选择" + endpoint.label + "上的磁盘"
                  : "选择" + endpoint.label + "上的文件夹或工作区"
              }
              // Portaled to body so a transformed sidebar cannot shrink the
              // fixed overlay; mobile sizes against the viewport (~75%), PC keeps
              // the existing centered card proportions.
              className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 md:p-4"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (creating) setCreating(false);
                  else setPicker(null);
                }
              }}
            >
              <div className="flex h-[75dvh] w-[75vw] max-h-[75dvh] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl md:h-auto md:max-h-[min(42rem,85vh)] md:w-full md:max-w-2xl">
                <header className="flex items-center gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-fg">
                      {picker.roots ? "选择磁盘" : "选择文件夹或 .code-workspace"}
                    </h2>
                    <p className="truncate text-xs text-faint" title={picker.path || undefined}>
                      {picker.roots ? "此设备上的可用位置" : picker.path}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭目录选择器"
                    className="rounded px-2 py-1 text-muted hover:bg-raised"
                    onClick={() => setPicker(null)}
                  >
                    ×
                  </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {picker.parent !== null && picker.parent !== undefined ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-muted hover:bg-raised"
                      onClick={() => void browse(picker.parent!)}
                    >
                      <span aria-hidden>↰</span>
                      <span>{picker.parent === "" ? "所有磁盘" : "上一级"}</span>
                    </button>
                  ) : null}
                  {picker.directories.map((directory) => (
                    <button
                      key={directory.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg hover:bg-raised"
                      onClick={() => void browse(directory.path)}
                    >
                      <ProjectIcon kind="folder" />
                      <span className="truncate">{directory.name}</span>
                    </button>
                  ))}
                  {(picker.workspaceFiles ?? []).map((workspace) => (
                    <button
                      key={workspace.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg hover:bg-raised"
                      onClick={() => void open(workspace.path)}
                    >
                      <ProjectIcon kind="workspace" />
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      <span className="shrink-0 text-[10px] text-faint">Workspace</span>
                    </button>
                  ))}
                  {picker.directories.length === 0 &&
                  (picker.workspaceFiles ?? []).length === 0 ? (
                    <p className="px-3 py-8 text-center text-xs text-faint">
                      {picker.roots ? "没有可访问的磁盘" : "这里没有子文件夹或 .code-workspace"}
                    </p>
                  ) : null}
                </div>
                {creating && !picker.roots ? (
                  <div className="flex items-center gap-2 border-t border-line px-4 py-3">
                    <input
                      autoFocus
                      className="min-w-0 flex-1 rounded border border-line bg-raised px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
                      value={newFolderName}
                      aria-label="新文件夹名称"
                      onChange={(event) => setNewFolderName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void createFolder();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="rounded px-3 py-1.5 text-xs text-muted hover:bg-raised"
                      onClick={() => setCreating(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
                      disabled={pickerBusy || !newFolderName.trim()}
                      onClick={() => void createFolder()}
                    >
                      创建
                    </button>
                  </div>
                ) : null}
                <footer className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
                  <div>
                    {!picker.roots ? (
                      <button
                        type="button"
                        className="rounded px-3 py-1.5 text-xs text-muted hover:bg-raised disabled:opacity-40"
                        disabled={pickerBusy || creating}
                        onClick={() => {
                          setNewFolderName(uniqueFolderName(picker));
                          setCreating(true);
                          setError(null);
                        }}
                      >
                        新建文件夹
                      </button>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {error ? <p className="max-w-xs truncate text-xs text-danger">{error}</p> : null}
                    <button
                      type="button"
                      className="rounded px-3 py-1.5 text-xs text-muted hover:bg-raised"
                      onClick={() => setPicker(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
                      disabled={busy || pickerBusy || picker.roots || !picker.path}
                      onClick={() => void open(picker.path)}
                    >
                      {busy ? "打开中…" : "选择当前文件夹"}
                    </button>
                  </div>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function uniqueFolderName(listing: DirectoryListing): string {
  const taken = new Set(listing.directories.map((entry) => entry.name.toLowerCase()));
  if (!taken.has("新建文件夹")) return "新建文件夹";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `新建文件夹 (${index})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `新建文件夹 (${Date.now()})`;
}

function pickerStorageKey(endpoint: Endpoint): string {
  const machine =
    endpoint.fingerprint ?? endpoint.credential?.deviceId ?? `${endpoint.via}:${endpoint.label}`;
  return `genehub:project-picker:${machine}`;
}

function recallPickerDirectory(endpoint: Endpoint): string | undefined {
  try {
    return globalThis.localStorage?.getItem(pickerStorageKey(endpoint)) || undefined;
  } catch {
    return undefined;
  }
}

function rememberPickerDirectory(endpoint: Endpoint, directory?: string): void {
  if (!directory) return;
  try {
    globalThis.localStorage?.setItem(pickerStorageKey(endpoint), directory);
  } catch {
    // A browsing preference is optional; private mode may reject storage.
  }
}

function isWorkspaceFile(path: string): boolean {
  return path.toLowerCase().endsWith(".code-workspace");
}

/** Handles both daemon path families without asking the browser which OS owns them. */
function parentDirectory(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return undefined;
  return separator === 0 ? path.slice(0, 1) : path.slice(0, separator);
}
