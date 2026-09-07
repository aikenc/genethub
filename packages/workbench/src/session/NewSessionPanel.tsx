import { useContext, useEffect, useMemo, useState } from "react";
import type { Host, Endpoint } from "../host";
import { useWorkbench } from "./store";
import { pickPromptSuggestions } from "./prompt-suggestions";
import { AgentList } from "../workspace/AgentList";
import { AgentAvatar } from "../workspace/AgentAvatar";
import { AgentDetails, AgentDetailsEnvironment } from "../workspace/AgentDetails";
import { AgentAdvancedSettings } from "../workspace/AgentAdvancedSettings";
import { OpenProject } from "../workspace/OpenProject";
import { RecentSessions } from "../shell/ConversationRows";
import { useAgentActivities } from "../workspace/useAgentActivity";
import { localValue } from "./localConversation";
import { ImportSessionsDialog } from "./ImportSessionsDialog";
import { FilesPanel } from "../files/FilesPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export const NEW_SESSION_WORKSPACE_PREVIEW_LIMIT = 4;
export const NEW_SESSION_PROJECT_PREVIEW_LIMIT = NEW_SESSION_WORKSPACE_PREVIEW_LIMIT;

/** The single expert home. The existing Composer remains owned by WorkbenchApp. */
export function NewSessionPanel({ host, endpoint, surface = "sessions", onSurface }: {
  host?: Host; endpoint?: Endpoint | null; surface?: string; onSurface?(value: string): void;
} = {}) {
  const wb = useWorkbench();
  const environment = useContext(AgentDetailsEnvironment);
  const workspace = wb.workspaces.find((w) => w.id === wb.draft?.workspaceId);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [archived, setArchived] = useState(false);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  useEffect(() => { if (surface === "terminal" && workspace) setTerminalIds(ids => ids.includes(workspace.id) ? ids : [...ids.slice(-3), workspace.id]); }, [surface, workspace?.id]);
  const [importOpen, setImportOpen] = useState(false);
  const activity = useAgentActivities();
  const machine = wb.client?.identity?.machineId ?? "";
  const guidanceKey = workspace?.agentSpace?.guidance?.join("\n") ?? "";
  const suggestions = useMemo(() => pickPromptSuggestions(3, Math.random,
    guidanceKey ? guidanceKey.split("\n") : undefined), [workspace?.id, guidanceKey]);
  useEffect(() => { setShowAll(false); setArchived(false); setHistoryQuery(""); }, [workspace?.id]);
  const rows = (activity.sessions ?? []).filter((s) => s.workspaceId === workspace?.id && s.archived === archived && !s.unsupported &&
    `${s.title ?? ""} ${s.messagePreview?.text ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase()))
    .sort((a, b) => (b.messagePreview?.atMs ?? b.updatedAtMs) - (a.messagePreview?.atMs ?? a.updatedAtMs) || a.id.localeCompare(b.id));
  const children = wb.workspaces.filter((w) => w.agentSpace?.parentWorkspaceId === workspace?.id);
  const navigate = (id: string) => { setChoosing(false); setQuery(""); environment?.onOverview?.(id); };
  if (!workspace) return <p className="p-4 text-sm text-muted">请选择可用专家后开始会话。</p>;
  const setSurface = (value: string) => onSurface?.(value);
  return <section className="flex h-full min-h-0 flex-col" aria-label="专家概要">
    <header className="shrink-0 border-b border-line px-4 py-3 md:px-6">
      <div className="mx-auto flex max-w-4xl items-center gap-3">
        <AgentAvatar id={workspace.id} name={workspace.name} />
        <div className="min-w-0 flex-1"><h2 className="truncate text-lg font-semibold">{workspace.name}</h2>
          <p className="truncate text-xs text-muted">{workspace.agentSpace?.components.filter(c => c.enabled).map(c => c.role ?? c.componentId).join(" · ") || "与你一起规划、执行与检查工作"}</p>
          <button type="button" className="min-h-8 text-xs text-accent" onClick={() => setSurface("details")}>查看详情</button>
        </div>
        <button type="button" className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-sm hover:bg-raised" onClick={() => setChoosing(v => !v)} aria-expanded={choosing}>切换专家</button>
      </div>
      {choosing && <div className="mx-auto mt-3 max-w-4xl rounded-xl border border-line p-2" aria-label="选择专家">
        <div className="flex items-center gap-2"><input autoFocus aria-label="搜索专家" placeholder="搜索专家" value={query} onChange={e => setQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm" /><button type="button" className="min-h-11 px-3 text-sm" onClick={() => setChoosing(false)}>取消</button></div>
        <div className="max-h-48 overflow-y-auto"><AgentList workspaces={wb.workspaces} sessions={wb.sessions} memberIds={wb.workspaces.map(w => w.id)} selectedId={workspace.id} density="compact" actions={false} query={query} onPick={navigate} /></div>
        {host && endpoint && <OpenProject host={host} endpoint={endpoint} variant="inline" />}
        <p className="p-2 text-xs text-muted">每位专家保留自己的草稿，附件不会随切换带到其他目录。</p>
      </div>}
      <nav className="mx-auto mt-2 flex max-w-4xl gap-1 overflow-x-auto" aria-label="专家概要页签">
        {[["sessions", "最近会话"], ["components", "组件"], ["directories", "目录"], ["children", `子专家${children.length ? ` ${children.length}` : ""}`]].map(([id,label]) => <button key={id} type="button" aria-pressed={surface === id} className={`min-h-10 shrink-0 rounded-lg px-3 text-sm ${surface === id ? "bg-raised font-medium text-accent" : "text-muted hover:bg-raised"}`} onClick={() => setSurface(id!)}>{label}</button>)}
      </nav>
    </header>
    <div className={surface === "terminal" ? "hidden" : ["files", "changes"].includes(surface) ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"} key={`${workspace.id}:${surface}`}>
      <div className="mx-auto max-w-4xl">
        {surface === "sessions" && <>
          <div className="mb-2 flex items-center gap-2"><p className="mr-auto text-xs text-muted">继续已有话题</p><button type="button" className="min-h-10 shrink-0 whitespace-nowrap px-2 text-sm text-accent" onClick={() => setImportOpen(true)}>导入</button><button type="button" className="min-h-10 shrink-0 whitespace-nowrap px-2 text-sm text-accent" onClick={() => { setShowAll(v => !v); setArchived(false); setHistoryQuery(""); }}>{showAll ? "收起历史" : "查看全部"}</button></div>
          {showAll && <div className="mb-3 flex gap-2"><input aria-label="搜索当前专家会话" placeholder="搜索会话" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg bg-raised px-3 text-sm"/><button type="button" aria-pressed={archived} className="min-h-11 rounded-lg border border-line px-3 text-sm" onClick={() => setArchived(v => !v)}>{archived ? "返回未归档" : "已归档"}</button></div>}
          {!activity.sessions ? <p role="status" className="py-6 text-sm text-muted">{activity.error ? "会话暂时无法读取，请检查连接后重试。" : "正在读取会话…"}</p> : <>
            <RecentSessions sessions={(showAll ? rows : rows.slice(0,10)).map(s => ({...s, unread: Boolean(s.messagePreview && localValue(`read:${machine}:${s.id}`) !== s.messagePreview.itemId)}))} workspaces={wb.workspaces} activeSessionId={null} onPickSession={id => void wb.selectSession(id)} onRename={(id,title) => void wb.renameSession(id,title)} onDelete={id => void wb.deleteSession(id)} />
            {!rows.length && <p className="py-6 text-center text-sm text-muted">{archived || historyQuery ? "没有匹配的会话" : "还没有会话，从下面开始吧"}</p>}
          </>}
        </>}
        {surface === "components" && <div className="space-y-3">{workspace.agentSpace?.components.map(c => <article key={c.componentId} className="rounded-xl border border-line p-4"><h3 className="text-sm font-medium">{c.componentId}{c.role ? ` · ${c.role}` : ""}</h3><p className="mt-2 text-xs text-muted">{c.enabled ? "已启用" : "已停用"}</p></article>)}{!workspace.agentSpace?.components.length && <p className="text-sm text-muted">尚未配置组件。</p>}<button type="button" className="min-h-11 text-sm text-accent" onClick={() => setSurface("details")}>查看组件配置</button></div>}
        {surface === "directories" && <><ul className="space-y-3">{(workspace.folders.length ? workspace.folders : [{name:workspace.name, root:workspace.root}]).map(f => <li key={f.root} className="rounded-xl border border-line p-4"><h3 className="text-sm font-medium">{f.name}</h3><p className="mt-1 break-all text-xs text-muted">{f.root}</p></li>)}</ul><div className="mt-4 flex flex-wrap gap-2">{[["files","文件"],["changes","变更"],["terminal","终端"],["details","管理目录"]].map(([id,label]) => <button type="button" key={id} className="min-h-11 rounded-lg border border-line px-4 text-sm" onClick={() => setSurface(id!)}>{label}</button>)}</div>{environment?.workspaceTools?.(workspace.id)}</>}
        {surface === "children" && <>{children.length ? <AgentList workspaces={wb.workspaces} rootIds={children.map(w => w.id)} sessions={wb.sessions} onPick={navigate} /> : <p className="py-6 text-sm text-muted">没有子专家。父子关系不自动代表一个协作团队。</p>}</>}
        {surface === "details" && <><div className="mb-4 flex items-center gap-3"><button type="button" className="min-h-11 text-sm text-accent" onClick={() => setSurface("sessions")}>‹ 返回概要</button><h2 className="text-lg font-medium">专家详情</h2></div><AgentDetails workspace={workspace} deviceName={endpoint?.label ?? "当前设备"} /><AgentAdvancedSettings workspace={workspace} /></>}
      </div>
      {surface === "files" && <FilesPanel workspaceId={workspace.id} />}
      {surface === "changes" && <ChangesPanel workspaceId={workspace.id} />}

    </div>
    {terminalIds.filter(id => wb.workspaces.some(w => w.id === id)).map(id => <div key={id} className={surface === "terminal" && workspace.id === id ? "min-h-0 flex-1" : "hidden"}><TerminalPanel workspaceId={id} /></div>)}
    {surface === "sessions" && <div className="shrink-0 px-4 pb-2"><div className="mx-auto flex max-w-chat gap-2 overflow-x-auto">{suggestions.map(s => <button type="button" key={s} className="min-h-9 shrink-0 rounded-full border border-line px-3 text-xs text-muted hover:text-fg" onClick={() => wb.appendComposerDraftLine(null, s)}>{s}</button>)}</div></div>}
    {importOpen && wb.client && <ImportSessionsDialog workspaceId={workspace.id} onClose={() => setImportOpen(false)} />}
  </section>;
}
