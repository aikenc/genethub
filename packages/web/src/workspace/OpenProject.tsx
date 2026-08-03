import { useId, useState } from "react";

import type { Endpoint, Host } from "../host";
import { useWorkbench } from "../session/store";

/**
 * How a project gets onto the workbench.
 *
 * Two shapes for two situations, and the difference is not cosmetic: on the
 * desktop the daemon runs on this machine, so a native folder picker is both
 * possible and the only sane option. In a browser the daemon is somewhere else
 * entirely and there is nothing to browse, so the user types a path that means
 * something over there.
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
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathId = useId();

  const open = async (root: string) => {
    if (!root.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(root.trim());
      setPath("");
      onOpened?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const canBrowseThisMachine = endpoint.via === "loopback" && host.pickDirectory;

  if (canBrowseThisMachine) {
    return (
      <div className={compact ? "" : "flex flex-col items-center gap-2"}>
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
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <form
      className={`${compact ? "" : "w-full max-w-md "}space-y-2`}
      onSubmit={(event) => {
        event.preventDefault();
        void open(path);
      }}
    >
      <label className="block text-[11px] text-muted" htmlFor={pathId}>
        {endpoint.label}上的文件夹
      </label>
      <div className="flex items-center gap-2">
        <input
          id={pathId}
          aria-label="项目路径"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1.5 text-xs outline-none placeholder:text-faint focus:border-accent"
          placeholder="输入绝对路径，例如 /home/you/code/app"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button
          type="submit"
          className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-40"
          disabled={busy || path.trim().length === 0}
        >
          {busy ? "打开中…" : "打开"}
        </button>
      </div>
      {!compact ? (
        <p className="text-left text-[11px] text-faint">
          远程设备的系统目录无法从当前设备浏览，请输入它上面的文件夹路径。
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </form>
  );
}
