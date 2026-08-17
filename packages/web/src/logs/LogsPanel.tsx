import { useEffect } from "react";

import { useWorkbench } from "../session/store";

/**
 * What the machine has been saying.
 *
 * Served over the connection rather than read off disk, and that is the reason
 * this panel exists instead of an error that ends with "日志在 C:\…": the person
 * reading the error is often on a phone, where a path on the PC is not something
 * they can act on.
 *
 * The end of the file, not the file. These reach megabytes and the useful part is
 * always what just happened.
 */
export function LogsPanel() {
  const log = useWorkbench((state) => state.log);
  const loadLog = useWorkbench((state) => state.loadLog);
  const client = useWorkbench((state) => state.client);

  useEffect(() => {
    if (client && !log) void loadLog();
  }, [client, log, loadLog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {(log?.files ?? []).map((file) => (
          <button
            key={file.name}
            type="button"
            className={`rounded px-2 py-1 text-xs ${
              file.name === log?.name
                ? "bg-raised text-fg"
                : "text-muted hover:bg-raised hover:text-fg"
            }`}
            onClick={() => void loadLog(file.name)}
          >
            {file.name}
            <span className="ml-1 text-faint">{size(file.bytes)}</span>
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="refresh-log"
            className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
            onClick={() => void loadLog(log?.name)}
          >
            刷新
          </button>
          <button
            type="button"
            className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
            onClick={() => void navigator.clipboard?.writeText(log?.text ?? "")}
          >
            复制
          </button>
        </div>
      </div>

      {log ? <p className="truncate text-xs text-faint">{log.path}</p> : null}

      <pre
        data-testid="log-text"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-3 text-xs leading-relaxed text-muted"
      >
        {log?.text?.length ? log.text : "还没有日志内容。"}
      </pre>
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
