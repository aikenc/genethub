import { useState } from "react";

import type { Host } from "../host";
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
  onOpened,
  compact = false,
}: {
  host: Host;
  onOpened?: () => void;
  compact?: boolean;
}) {
  const openWorkspace = useWorkbench((state) => state.openWorkspace);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (host.pickDirectory) {
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
      className={`flex ${compact ? "" : "w-full max-w-md "}items-center gap-2`}
      onSubmit={(event) => {
        event.preventDefault();
        void open(path);
      }}
    >
      <input
        aria-label="项目路径"
        className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        placeholder="那台机器上的项目路径，例如 /home/you/code/app"
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
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </form>
  );
}
