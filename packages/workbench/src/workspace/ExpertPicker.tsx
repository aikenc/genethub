import { ListSearch } from "../ui/ListLayout";
import { useState } from "react";
import { useWorkbench } from "../session/store";
import { AgentList } from "./AgentList";
import { WorkspaceDetailsDialog } from "./WorkspaceDetailsDialog";

/** Shared expert selection: directory rows, search filter, no management actions. */
export function ExpertPicker({ selectedId, onPick, onClose, onCreate, allowedIds, allowNone = false, noneLabel = "不限项目" }: {
  selectedId?: string; onPick(id: string): void; onClose?(): void; onCreate?(): void; allowedIds?: string[]; allowNone?: boolean; noneLabel?: string;
}) {
  const { workspaces, sessions } = useWorkbench();
  const [query, setQuery] = useState("");
  return <section aria-label="选择项目" className="flex min-h-0 flex-col rounded-xl border border-line p-2">
    {onCreate && <p className="mb-2 text-xs text-muted">从当前项目列表开始，选择或新建文件夹作为新项目。</p>}
    {onCreate && <button type="button" className="mb-2 min-h-11 rounded-lg bg-accent px-3 text-sm text-white" onClick={onCreate}>新建项目</button>}
    <div className="mb-2 flex items-center gap-2"><div className="min-w-0 flex-1"><ListSearch label="搜索项目" value={query} onChange={setQuery}/></div>{onClose && <button type="button" className="min-h-11 shrink-0 px-3 text-sm" onClick={onClose}>取消</button>}</div>
    {allowNone && <button type="button" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-raised" onClick={() => onPick("")}>{noneLabel}</button>}
    <div className="max-h-64 min-h-0 overflow-y-auto"><AgentList workspaces={workspaces} sessions={sessions} memberIds={allowedIds} selectedId={selectedId} density="comfortable" actions={false} query={query} onPick={onPick} /></div>
  </section>;
}

/** Every expert choice uses the same modal, row presentation and group semantics. */
export function ExpertPickerDialog({ onClose, title = "选择项目", ...props }: {
  selectedId?: string; onPick(id: string): void; onClose(): void; onCreate?(): void;
  allowedIds?: string[]; allowNone?: boolean; noneLabel?: string; title?: string;
}) {
  return <WorkspaceDetailsDialog title={title} onClose={onClose}><ExpertPicker {...props} /></WorkspaceDetailsDialog>;
}
