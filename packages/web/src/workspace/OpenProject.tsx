import type { DirectoryListing } from "@genehub/proto";
import { useState } from "react";

import type { Endpoint, Host } from "../host";
import { useWorkbench } from "../session/store";

/**
 * How a folder or saved VS Code workspace gets onto the workbench.
 *
 * A local daemon uses the operating system picker. A remote daemon exposes its
 * own directory tree through the connection, so choosing a folder stays a
 * browse operation instead of becoming a memory test for an absolute path.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<DirectoryListing | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  const open = async (root: string) => {
    if (!root.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(root.trim());
      setPicker(null);
      onOpened?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const canBrowseThisMachine = endpoint.via === "loopback" && host.pickDirectory;

  const browse = async (path?: string) => {
    if (!client) return;
    setPickerBusy(true);
    setError(null);
    try {
      const reply = await client.call({
        type: "directory.list",
        payload: { path: path ?? null },
      });
      if (reply?.type !== "directory") throw new Error("设备没有返回目录列表");
      setPicker(reply.data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
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
          onClick={async () => {
            const picked = await host.pickDirectory!();
            if (picked) await open(picked);
          }}
        >
          {busy ? "打开中…" : "打开项目文件夹…"}
        </button>
        {host.pickWorkspaceFile ? (
          <button
            type="button"
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:bg-raised disabled:opacity-40"
            disabled={busy}
            onClick={async () => {
              const picked = await host.pickWorkspaceFile!();
              if (picked) await open(picked);
            }}
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
        onClick={() => void browse()}
      >
        {pickerBusy ? "读取中…" : "选择文件夹或 .code-workspace…"}
      </button>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {picker ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={"选择" + endpoint.label + "上的文件夹或工作区"}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPicker(null);
          }}
        >
          <div className="flex max-h-[min(42rem,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
            <header className="flex items-center gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium text-fg">选择文件夹或 .code-workspace</h2>
                <p className="truncate text-xs text-faint" title={picker.path}>{picker.path}</p>
              </div>
              <button type="button" aria-label="关闭目录选择器" className="rounded px-2 py-1 text-muted hover:bg-raised" onClick={() => setPicker(null)}>×</button>
            </header>
            <div className="min-h-48 flex-1 overflow-y-auto p-2">
              {picker.parent ? (
                <button type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-muted hover:bg-raised" onClick={() => void browse(picker.parent!)}>
                  <span aria-hidden>↰</span><span>上一级</span>
                </button>
              ) : null}
              {picker.directories.map((directory) => (
                <button key={directory.path} type="button" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg hover:bg-raised" onClick={() => void browse(directory.path)}>
                  <span aria-hidden>📁</span><span className="truncate">{directory.name}</span>
                </button>
              ))}
              {(picker.workspaceFiles ?? []).map((workspace) => (
                <button
                  key={workspace.path}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg hover:bg-raised"
                  onClick={() => void open(workspace.path)}
                >
                  <span aria-hidden>◇</span>
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <span className="shrink-0 text-[10px] text-faint">Workspace</span>
                </button>
              ))}
              {picker.directories.length === 0 && (picker.workspaceFiles ?? []).length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-faint">
                  这里没有子文件夹或 .code-workspace
                </p>
              ) : null}
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
              <button type="button" className="rounded px-3 py-1.5 text-xs text-muted hover:bg-raised" onClick={() => setPicker(null)}>取消</button>
              <button type="button" className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40" disabled={busy || pickerBusy} onClick={() => void open(picker.path)}>{busy ? "打开中…" : "选择当前文件夹"}</button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
