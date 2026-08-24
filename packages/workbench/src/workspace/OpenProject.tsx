import type { DirectoryListing } from "@genehub/proto";
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";

import type { Endpoint, Host } from "../host";
import { LOCATION_MOVED } from "../location/history";
import { patchWorkbenchLocation, readWorkbenchDialog } from "../location/sync";
import { warnOp } from "../session/op-log";
import { useWorkbench } from "../session/store";
import { WorkspaceKindIcon } from "./WorkspaceIcon";

/**
 * How a folder or saved VS Code workspace gets onto the workbench.
 *
 * A workspace is either one folder or a `.code-workspace` that names several.
 * A local daemon uses the operating system picker. A remote daemon exposes its
 * own tree through the connection, so choosing a workspace stays a browse
 * operation instead of becoming a memory test for an absolute path.
 *
 * On Windows the remote picker climbs past a drive root into a machine-roots
 * listing so the person can switch disks without typing a path.
 */
export type OpenWorkspaceHandle = { open(): void };

export const OpenProject = forwardRef<
  OpenWorkspaceHandle,
  {
    host: Host;
    endpoint: Endpoint;
    onOpened?: () => void;
    compact?: boolean;
    /** How the trigger is drawn. `none` keeps the picker mounted with no button. */
    variant?: "button" | "menuitem" | "inline" | "none";
    onPickStart?: () => void;
    /**
     * This instance owns the picker for `?dialog=open-workspace`. Other
     * triggers only write the address; this one opens it.
     */
    driveUrl?: boolean;
  }
>(function OpenProject(
  { host, endpoint, onOpened, compact = false, variant = "button", onPickStart, driveUrl = false },
  ref,
) {
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
  const [nativeChoice, setNativeChoice] = useState(false);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const rememberedDirectory = () => recallPickerDirectory(endpoint);
  const startingDirectory = () => activeWorkspace?.root ?? rememberedDirectory();
  const opening = useRef(false);
  const [urlDialog, setUrlDialog] = useState(() => readWorkbenchDialog());

  useEffect(() => {
    const sync = () => setUrlDialog(readWorkbenchDialog());
    window.addEventListener("popstate", sync);
    window.addEventListener(LOCATION_MOVED, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(LOCATION_MOVED, sync);
    };
  }, []);

  const writeDialog = () => {
    if (host.kind !== "browser") return;
    patchWorkbenchLocation({ dialog: "open-workspace" });
  };

  const closePicker = () => {
    opening.current = false;
    setPicker(null);
    setNativeChoice(false);
    if (host.kind === "browser" && readWorkbenchDialog() === "open-workspace") {
      patchWorkbenchLocation({ dialog: null }, "replace");
    }
  };

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
      closePicker();
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
    setNativeChoice(false);
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
    let failure: unknown = new Error("无法读取工作区位置");
    for (const start of starts) {
      try {
        const listing = await readDirectory(start);
        setPicker(listing);
        if (!listing.roots) rememberPickerDirectory(endpoint, listing.path);
        setPickerBusy(false);
        return;
      } catch (caught) {
        failure = caught;
      }
    }
    setError(warnOp("directory.list", failure));
    setPickerBusy(false);
  };

  const startOpen = () => {
    onPickStart?.();
    if (host.kind === "browser" && !driveUrl) {
      writeDialog();
      return;
    }
    writeDialog();
    if (!canBrowseThisMachine && !client) return;
    opening.current = true;
    if (canBrowseThisMachine) {
      if (host.pickDirectory && host.pickWorkspaceFile) {
        setNativeChoice(true);
        return;
      }
      if (host.pickDirectory) {
        void pickNative(host.pickDirectory);
        return;
      }
    }
    void beginBrowse();
  };

  const startOpenRef = useRef(startOpen);
  startOpenRef.current = startOpen;
  useImperativeHandle(ref, () => ({ open: () => startOpenRef.current() }), []);

  useEffect(() => {
    if (!driveUrl || host.kind !== "browser") return;
    if (urlDialog === "open-workspace") {
      if (!picker && !nativeChoice && !pickerBusy && !busy && !opening.current) {
        startOpenRef.current();
      }
      return;
    }
    if (opening.current) return;
    if (picker || nativeChoice) closePicker();
  }, [busy, client, driveUrl, host.kind, nativeChoice, picker, pickerBusy, urlDialog]);

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

  const triggerLabel = pickerBusy ? "读取中…" : busy ? "打开中…" : "打开工作区";
  const triggerDisabled = busy || pickerBusy || (!canBrowseThisMachine && !client);

  const trigger =
    variant === "none" ? null : variant === "menuitem" ? (
      <button
        type="button"
        role="menuitem"
        disabled={triggerDisabled}
        className="flex min-h-10 w-full items-center px-3 text-left text-sm text-fg hover:bg-raised disabled:opacity-40 md:min-h-0 md:py-1.5 md:text-xs"
        onClick={startOpen}
      >
        {triggerLabel}
      </button>
    ) : variant === "inline" ? (
      <button
        type="button"
        disabled={triggerDisabled}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-accent hover:bg-raised disabled:opacity-40"
        onClick={startOpen}
      >
        {triggerLabel}
      </button>
    ) : (
      <button
        type="button"
        className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
        disabled={triggerDisabled}
        onClick={startOpen}
      >
        {triggerLabel}
      </button>
    );

  return (
    <div className={compact || variant !== "button" ? "" : "flex flex-col items-center gap-2"}>
      {trigger}
      {error && !picker && !nativeChoice ? <p className="text-xs text-danger">{error}</p> : null}
      {nativeChoice
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="打开工作区"
              className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3"
              onKeyDown={(event) => {
                if (event.key === "Escape") closePicker();
              }}
            >
              <div className="w-full max-w-sm rounded-xl border border-line-strong bg-surface p-4 shadow-2xl">
                <h2 className="text-sm font-medium text-fg">打开工作区</h2>
                <p className="mt-1 text-xs text-muted">
                  工作区可以是一个文件夹，也可以是 .code-workspace 描述的多文件夹工作区。
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    className="rounded bg-accent px-3 py-2 text-sm text-white disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void pickNative(host.pickDirectory!)}
                  >
                    打开文件夹
                  </button>
                  <button
                    type="button"
                    className="rounded border border-line px-3 py-2 text-sm text-muted hover:bg-raised disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void pickNative(host.pickWorkspaceFile!)}
                  >
                    打开 .code-workspace
                  </button>
                  <button
                    type="button"
                    className="rounded px-3 py-1.5 text-xs text-muted hover:bg-raised"
                    onClick={() => closePicker()}
                  >
                    取消
                  </button>
                </div>
                {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
      {picker
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={
                picker.roots
                  ? "选择" + endpoint.label + "上的磁盘"
                  : "打开" + endpoint.label + "上的工作区"
              }
              className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 md:p-4"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (creating) setCreating(false);
                  else closePicker();
                }
              }}
            >
              <div className="flex h-[75dvh] w-[75vw] max-h-[75dvh] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl md:h-auto md:max-h-[min(42rem,85vh)] md:w-full md:max-w-2xl">
                <header className="flex items-center gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-fg">
                      {picker.roots ? "选择磁盘" : "打开工作区"}
                    </h2>
                    <p className="truncate text-xs text-faint" title={picker.path || undefined}>
                      {picker.roots ? "此设备上的可用位置" : picker.path}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭工作区选择器"
                    className="rounded px-2 py-1 text-muted hover:bg-raised"
                    onClick={() => closePicker()}
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
                      <WorkspaceKindIcon kind="folder" />
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
                      <WorkspaceKindIcon kind="workspace" />
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
                      onClick={() => closePicker()}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
                      disabled={busy || pickerBusy || picker.roots || !picker.path}
                      onClick={() => void open(picker.path)}
                    >
                      {busy ? "打开中…" : "打开此工作区"}
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
});

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
  return `genehub:workspace-picker:${machine}`;
}

function legacyPickerStorageKey(endpoint: Endpoint): string {
  const machine =
    endpoint.fingerprint ?? endpoint.credential?.deviceId ?? `${endpoint.via}:${endpoint.label}`;
  return `genehub:project-picker:${machine}`;
}

function recallPickerDirectory(endpoint: Endpoint): string | undefined {
  try {
    return (
      globalThis.localStorage?.getItem(pickerStorageKey(endpoint)) ||
      globalThis.localStorage?.getItem(legacyPickerStorageKey(endpoint)) ||
      undefined
    );
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
