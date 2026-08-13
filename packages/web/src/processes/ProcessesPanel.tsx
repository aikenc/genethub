import { useEffect, useState } from "react";

import { useWorkbench } from "../session/store";

/**
 * What the agents left running, and a way to stop it.
 *
 * An agent runs commands, and some of them do not end: a dev server started to
 * check a page, a watcher started to see a test go green. Nobody decided those
 * should keep running — the turn ended while they were still going. Until this
 * panel existed there was no way to find out, and the first sign was a port
 * that would not bind the next morning.
 *
 * Everything here is named against a session, because a process with no
 * conversation to answer for it is one nobody can judge: "is this still needed"
 * is a question about what somebody was doing, not about a command line.
 */
export function ProcessesPanel() {
  const {
    backgroundProcesses,
    refreshBackgroundProcesses,
    killBackgroundProcess,
    killBackgroundProcesses,
    sessions,
    client,
  } = useWorkbench();
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (client) void refreshBackgroundProcesses();
  }, [client, refreshBackgroundProcesses]);

  const chosen = backgroundProcesses.find((process) => process.pid === selected) ?? null;
  const titleOf = (sessionId: string) =>
    sessions.find((session) => session.id === sessionId)?.title ?? sessionId;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex max-h-56 shrink-0 flex-col border-b border-line md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <span className="truncate text-muted">
            {backgroundProcesses.length > 0 ? `${backgroundProcesses.length} 个在运行` : "后台进程"}
          </span>
          <button
            type="button"
            className="ml-auto text-muted hover:text-fg"
            onClick={() => void refreshBackgroundProcesses()}
          >
            刷新
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto p-1 text-sm">
          {backgroundProcesses.map((process) => (
            <li key={process.pid}>
              <button
                type="button"
                aria-current={selected === process.pid}
                className={`flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left hover:bg-raised ${
                  selected === process.pid ? "bg-raised" : ""
                }`}
                onClick={() => setSelected(process.pid)}
              >
                <span className="truncate font-mono text-xs">{process.command}</span>
                <span className="truncate text-[10px] text-muted">
                  {titleOf(process.sessionId)} · 已运行 {duration(process.runningForSeconds)}
                </span>
              </button>
            </li>
          ))}
          {backgroundProcesses.length === 0 ? (
            <li className="p-2 text-xs text-muted">没有留下运行中的进程</li>
          ) : null}
        </ul>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {chosen ? (
          <>
            <p className="mb-3 break-all font-mono text-xs">{chosen.command}</p>
            <dl className="mb-4 grid grid-cols-[6rem_1fr] gap-y-1 text-xs">
              <Fact name="所属会话" value={titleOf(chosen.sessionId)} />
              <Fact name="进程号" value={String(chosen.pid)} />
              <Fact name="父进程号" value={String(chosen.parentPid)} />
              <Fact name="已运行" value={duration(chosen.runningForSeconds)} />
            </dl>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded border border-line px-2 py-1 text-xs hover:border-danger hover:text-danger disabled:opacity-40"
                onClick={() => {
                  setBusy(true);
                  void killBackgroundProcess(chosen.sessionId, chosen.pid).finally(() => {
                    setBusy(false);
                    setSelected(null);
                  });
                }}
              >
                结束进程
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded border border-line px-2 py-1 text-xs hover:border-danger hover:text-danger disabled:opacity-40"
                onClick={() => {
                  setBusy(true);
                  void killBackgroundProcesses(chosen.sessionId).finally(() => {
                    setBusy(false);
                    setSelected(null);
                  });
                }}
              >
                结束该会话的全部
              </button>
            </div>
            {/* Said before it is pressed, not after: a person choosing between
                these two buttons is deciding how much to take down. */}
            <p className="mt-3 text-[10px] text-muted">
              结束一个进程会同时结束它启动的进程。
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">选择一个进程查看详情。</p>
        )}
      </div>
    </div>
  );
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{name}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  );
}

/** Coarse on purpose: the useful question is "since when", not "how long". */
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}
