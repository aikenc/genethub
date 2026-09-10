import { useEffect, useState } from "react";

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
export function LogsPanel({ onOpenDirectory }: { onOpenDirectory?: () => void }) {
  const [copyError, setCopyError] = useState("");
  const entries = useWorkbench(state => state.interfaceLogs);
  const log = useWorkbench((state) => state.log);
  const loadLog = useWorkbench((state) => state.loadLog);
  const client = useWorkbench((state) => state.client);

  useEffect(() => {
    if (client && !log) void loadLog();
  }, [client, log, loadLog]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <section aria-label="界面日志" className="shrink-0 rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto font-medium">界面日志</h2>
          <button type="button" className="min-h-11 rounded px-3 text-sm hover:bg-raised" disabled={!entries.length} onClick={async () => {
            setCopyError("");
            try {
              if (!navigator.clipboard) throw new Error("当前浏览器不支持复制，请手动选择日志。");
              await navigator.clipboard.writeText(entries.map(entry => `${new Date(entry.at).toLocaleString()} ${entry.machine} ${entry.message}`).join("\n"));
            } catch (error) { setCopyError(error instanceof Error ? error.message : "复制失败"); }
          }}>复制界面日志</button>
          <button type="button" className="min-h-11 rounded px-3 text-sm hover:bg-raised" disabled={!entries.length} onClick={() => useWorkbench.setState({interfaceLogs: [], notice: null})}>清空界面日志</button>
        </div>
        <p className="mb-2 text-xs text-muted">记录当前页面收到的提示和错误，最多保留 100 条；刷新页面后清空。</p>
        {copyError && <p role="alert" className="text-sm text-danger">{copyError}</p>}
        <div className="max-h-48 overflow-y-auto overscroll-contain text-xs">
          {!entries.length ? <p className="text-muted">暂无界面日志。</p> : <ol className="space-y-2">{entries.map((entry, index) => <li key={index} className="break-words border-b border-line pb-2">
            <p className="text-muted"><time>{new Date(entry.at).toLocaleString()}</time>{entry.machine && ` · ${entry.machine}`}</p>
            <p className="whitespace-pre-wrap">{entry.message}</p>
          </li>)}</ol>}
        </div>
      </section>
      <h2 className="shrink-0 font-medium">设备日志</h2>
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
          {/* Only where there is a desktop to open it in. In a browser this
              button would do nothing, and a dead control is worse than none. */}
          {onOpenDirectory ? (
            <button
              type="button"
              className="rounded border border-line px-2 py-1 text-xs hover:border-accent"
              onClick={onOpenDirectory}
            >
              打开日志目录
            </button>
          ) : null}
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
