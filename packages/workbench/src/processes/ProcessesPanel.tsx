import { useEffect, useState } from "react";
import type { BackgroundProcess } from "@genehub/proto";
import { useWorkbench } from "../session/store";

const keyOf = (p: BackgroundProcess) => `${p.workspaceId ?? ""}:${p.sessionId}:${p.pid}:${p.service?.runId ?? ""}`;

/** Processes and explicitly registered preview applications share one workspace view. */
export function ProcessesPanel({ sessionId }: { sessionId?: string }) {
  const { backgroundProcesses, refreshBackgroundProcesses, killBackgroundProcess,
    killBackgroundProcesses, sessions, workspaces, activeWorkspaceId, client, connection,
    openPreviewFloat } = useWorkbench();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [servicesOnly, setServicesOnly] = useState(false);
  useEffect(() => {
    setSelected(null);
    if (client && connection === "ready") void refreshBackgroundProcesses();
  }, [client, connection, activeWorkspaceId, refreshBackgroundProcesses]);
  const processes = backgroundProcesses.filter(p =>
    (!sessionId || p.sessionId === sessionId) &&
    (!activeWorkspaceId || (p.workspaceId ?? sessions.find(s => s.id === p.sessionId)?.workspaceId) === activeWorkspaceId));
  const chosen = processes.find(p => keyOf(p) === selected);
  const titleOf = (id: string) => sessions.find(s => s.id === id)?.title ?? (id || "外部程序登记");
  const workspaceName = workspaces.find(w => w.id === activeWorkspaceId)?.name ?? "此电脑";
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setProblem("");
    try { await action(); await refreshBackgroundProcesses(); setSelected(null); }
    catch (e) { setProblem(e instanceof Error ? e.message : "操作失败，请刷新后重试"); }
    finally { setBusy(false); }
  };
  const visible = servicesOnly ? processes.filter(p => p.service) : processes;
  // Only attach within the same workspace/session; a missing ancestor remains a root.
  const parentOf = (p: BackgroundProcess) => visible.find(other => other !== p &&
    other.pid === p.parentPid && other.workspaceId === p.workspaceId && other.sessionId === p.sessionId);
  const rendered = new Set<string>();
  const branch = (p: BackgroundProcess): React.ReactNode => {
    const key = keyOf(p);
    if (rendered.has(key)) return null;
    rendered.add(key);
    const children = visible.filter(child => parentOf(child) === p);
    const button = <button type="button" aria-current={selected === key}
      className="w-full rounded px-2 py-1 text-left text-xs hover:bg-raised aria-[current=true]:bg-raised"
      onClick={() => setSelected(key)}>
      <span className="block break-all">{p.service ? `${p.service.name} · 服务` : p.command}</span>
      <span className="text-[10px] text-muted">PID {p.pid} · {p.service ? (p.service.reachable ? "服务可连接" : "服务不可达，请检查源程序") : titleOf(p.sessionId)}</span>
    </button>;
    return <li key={key}>{children.length ? <details open><summary className="cursor-pointer text-xs">PID {p.pid} · {children.length} 个子进程</summary>{button}<ul className="ml-3 border-l border-line pl-1">{children.map(branch)}</ul></details> : button}</li>;
  };
  const nodes = visible.filter(p => !parentOf(p)).map(branch);
  // Defensive cycle handling: never hide a process because OS ancestry changed mid-snapshot.
  for (const p of visible) if (!rendered.has(keyOf(p))) nodes.push(branch(p));
  return <div className="flex h-full min-h-0 flex-col md:flex-row">
    <div className="flex max-h-64 shrink-0 flex-col border-b border-line md:max-h-none md:w-80 md:border-b-0 md:border-r">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2 text-xs">
        <span>{workspaceName} · 后台运行</span>
        <button type="button" onClick={() => void act(refreshBackgroundProcesses)} disabled={busy || connection !== "ready"}>刷新</button>
        <label><input type="checkbox" checked={servicesOnly} onChange={e => setServicesOnly(e.target.checked)} /> 仅服务</label>
      </div>
      {connection !== "ready" ? <p role="status" className="p-2 text-xs">源电脑未连接，运行状态待更新。</p> : null}
      <ul className="overflow-auto p-1" aria-label="后台进程树">{nodes}</ul>
      {!visible.length ? <p className="p-2 text-xs text-muted">暂无可显示的运行；程序启动后可刷新。</p> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
      {problem ? <p role="alert" className="mb-2 text-danger">{problem}</p> : null}
      {chosen ? <>
        <p className="mb-2 break-all">{chosen.service?.name || chosen.command}</p>
        <p className="mb-2">来源：{titleOf(chosen.sessionId)} · PID {chosen.pid} · 父进程 {chosen.parentPid}</p>
        <div className="flex flex-wrap gap-2">
          {chosen.service && chosen.workspaceId ? <>
            <button type="button" className="rounded border border-line px-2 py-1" disabled={connection !== "ready"}
              onClick={() => { if (client?.identity) openPreviewFloat({deviceHandle:client.identity.machineId, workspaceHandle:chosen.workspaceId!, path:chosen.service!.entryPath, ...(chosen.sessionId ? {sessionId:chosen.sessionId}: {})}); }}>打开预览</button>
            <button type="button" className="rounded border border-line px-2 py-1" disabled={busy || connection !== "ready" || !chosen.service.canStop}
              onClick={() => void act(async () => { await client!.call({type:"process.serviceStop",payload:{workspaceId:chosen.workspaceId!,entryPath:chosen.service!.entryPath,runId:chosen.service!.runId}}); })}>停止应用</button>
            <p className="w-full text-muted">关闭预览只断开访问；停止应用会请求该次运行清理它管理的进程。</p>
          </> : chosen.sessionId ? <>
            <button type="button" disabled={busy || connection !== "ready"} onClick={() => void act(() => killBackgroundProcess(chosen.sessionId, chosen.pid))}>结束进程树</button>
            <button type="button" disabled={busy || connection !== "ready"} onClick={() => void act(() => killBackgroundProcesses(chosen.sessionId))}>结束该会话的全部</button>
          </> : null}
        </div>
      </> : <p className="text-muted">选择一个运行查看详情或打开预览。</p>}
    </div>
  </div>;
}
