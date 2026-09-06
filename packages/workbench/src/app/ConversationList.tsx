import { useEffect, useState } from "react";
import type { Host, Endpoint, Target } from "../host";
import { useWorkbench } from "../session/store";
import { localValue } from "../session/localConversation";
import { RecentSessions } from "../shell/ConversationRows";
import { TargetSwitcher } from "../shell/TargetSwitcher";
import { OpenProject } from "../workspace/OpenProject";

/** A row is a Session, even when several rows share the same Space. */
export function ConversationList({host, endpoint, open, hidden, onPickTarget, onNavigate}: {
 host: Host; endpoint?: Endpoint | null; open: boolean; hidden?: boolean; sessionOnly?: boolean;
 onPickTarget?(target: Target, endpoint: Endpoint): void; onNavigate(): void;
}) {
 const wb = useWorkbench();
 const [, refreshLocal] = useState(0);
 useEffect(() => { const refresh = () => refreshLocal(n => n+1); window.addEventListener("genehub-conversation-local", refresh); return () => window.removeEventListener("genehub-conversation-local",refresh); }, []);
 const machine = wb.client?.identity?.machineId ?? endpoint?.label ?? "";
 const [query, setQuery] = useState("");
 const [needs, setNeeds] = useState(false);
 useEffect(() => {
   if(wb.connection !== "ready") return;
   const timer = setInterval(() => void wb.refreshSessions(), 2000);
   return () => clearInterval(timer);
 }, [wb.connection, wb.refreshSessions]);
 const rows = wb.sessions.filter(s => wb.includeArchived ? s.archived : !s.archived).filter(s => !needs || ["waiting", "failed"].includes(s.status))
   .filter(s => `${s.title} ${wb.workspaces.find(w => w.id === s.workspaceId)?.name ?? ""}`.toLowerCase().includes(query.toLowerCase()))
   .map(s => ({...s, unread: Boolean(s.messagePreview && localValue(`read:${machine}:${s.id}`) !== s.messagePreview.itemId)}));
 return <aside aria-label="会话列表" className={`${hidden ? "hidden" : open ? "flex" : "hidden md:flex"} min-h-0 w-full shrink-0 flex-col border-r border-line bg-sidebar md:w-80`}>
   <header className="border-b border-line p-4">{onPickTarget && <TargetSwitcher host={host} current={endpoint ?? null} onPick={onPickTarget} onNavigate={onNavigate} />}<p className="text-xs text-muted">{endpoint?.label}</p><div className="mt-2 flex items-center justify-between"><h1 className="text-xl font-medium">会话</h1><button type="button" className="min-h-11 px-3 text-accent" onClick={() => { wb.newSession(wb.activeWorkspaceId, null); onNavigate(); }}>新会话</button></div>
   <input type="search" aria-label="搜索会话" placeholder="搜索空间或会话" value={query} onChange={e => setQuery(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg bg-raised px-3 text-sm" />
   <button type="button" aria-pressed={needs} className={`mt-2 min-h-10 rounded-lg px-3 text-sm ${needs ? "bg-raised text-accent" : "text-muted"}`} onClick={() => setNeeds(!needs)}>受阻会话 {wb.sessions.some(s => ["waiting", "failed"].includes(s.status)) ? "●" : ""}</button><button type="button" aria-pressed={wb.includeArchived} className="min-h-10 px-3 text-sm text-muted" onClick={() => { useWorkbench.setState({includeArchived: !wb.includeArchived}); void wb.refreshSessions(); }}>已归档</button></header>
   <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2"><RecentSessions sessions={rows} workspaces={wb.workspaces} activeSessionId={wb.activeSessionId} onPickSession={id => { void wb.selectSession(id); onNavigate(); }} onRename={(id,title) => void wb.renameSession(id,title)} onDelete={id => void wb.deleteSession(id)} />{!rows.length && <p className="px-3 py-6 text-sm text-muted">{query || needs ? "没有匹配的会话" : "从一个空间开始会话"}</p>}</div>
   {!wb.workspaces.length && endpoint && <OpenProject host={host} endpoint={endpoint} />}
 </aside>;
}
