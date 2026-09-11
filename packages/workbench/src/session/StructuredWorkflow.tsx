import { useEffect, useState } from "react";
import type { WorkflowRunStatus } from "@genehub/proto";
import { useWorkbench } from "./store";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const label: Record<string,string> = {sequence:"顺序",loop:"循环",parallel:"并行",forEach:"批次",if:"条件",choice:"分支",call:"子流程",task:"活动"};
const status: Record<string,string> = {running:"执行中",pending:"待执行",completed:"已完成",finishing:"收尾中",blocked:"受阻",cancelled:"已取消",unreached:"未选择",failed:"失败"};

/** Versioned product projection, never a reconstruction of execution from logs. */
export function StructuredWorkflow({run}:{run:WorkflowRunStatus}) {
  const selectSession = useWorkbench(s=>s.selectSession);
  const view = record(run.structure);
  if (view.schema !== "genehub.workflow.structure.v1") return null;
  const definition = record(view.definition);
  const instances = list(view.instances).map(record);
  const render = (value:unknown, filter:(instance:Record<string,unknown>)=>boolean, depth=0):React.ReactNode => {
    const block = record(value);
    if (typeof block.id !== "string" || depth > 32) return null;
    const kind = String(block.type);
    const local = (i:Record<string,unknown>) => filter(i) && list(i.scope).some(s=>record(s).blockId === block.id);
    const relevant = instances.filter(local);
    const workers = relevant.filter(i=>record(list(i.scope).at(-1)).blockId === block.id);
    let children: unknown[] = [];
    if (kind === "sequence") children = list(block.steps);
    if (kind === "parallel") children = list(block.branches);
    if (kind === "if") children = [block.then,block.else].filter(Boolean);
    if (kind === "choice") children = [...list(block.branches).map(b=>record(b).body),block.default];
    if (kind === "call") children = [record(definition.procedures)[String(block.procedure)]];
    const rounds = kind === "loop" ? [...new Set(relevant.map(i=>record(list(i.scope).find(s=>record(s).blockId === block.id)).round).filter((r):r is number=>typeof r === "number"))].sort((a,b)=>a-b) : [];
    const itemKey = (i:Record<string,unknown>) => {const scope=list(i.scope).map(record);const index=scope.findIndex(s=>s.blockId === block.id);return scope[index+1]?.itemId;};
    const items = kind === "forEach" ? [...new Set(relevant.map(itemKey).filter((key):key is string=>typeof key === "string"))] : [];
    const active = list(view.active).map(record).filter(f=>f.blockId === block.id);
    return <details key={block.id} open={depth < 2} className={depth < 4 ? "min-w-0 rounded-lg border border-line px-3 py-2" : "min-w-0 border-t border-line py-2"}>
      <summary className="cursor-pointer break-words text-sm">
        {label[kind] ?? kind} · {block.id}
        {kind === "loop" ? ` · 最多 ${String(block.maxRounds)} 轮` : ""}
        {kind === "forEach" ? ` · 并发 ${String(block.maxConcurrency)}` : ""}
        {!relevant.length && !active.length ? " · 未执行" : ""}
      </summary>
      <div className="mt-2 space-y-2">
        {workers.map(instance=>{
          const node = run.nodes.find(n=>n.id === instance.nodeId);
          return node ? <div key={node.id} className="text-xs">
            <p>{node.id} · {status[node.status] ?? node.status}</p>
            {node.reason ? <p className="mt-1 break-words">{node.reason}</p> : null}
            {node.sessionId ? <button type="button" className="min-h-11 text-accent" onClick={()=>void selectSession(node.sessionId!)}>查看本次工作会话</button> : null}
            {Object.keys(node.evidence).length ? <details><summary className="cursor-pointer">本次证据</summary><dl className="space-y-1">{Object.entries(node.evidence).map(([key,value])=><div key={key} className="break-words"><dt>{key}</dt><dd className="whitespace-pre-wrap">{value}</dd></div>)}</dl></details> : null}
          </div> : null;
        })}
        {kind === "loop" ? rounds.length ? rounds.map(round=><details key={String(round)} open={round === rounds.at(-1)}>
          <summary className="min-h-8 cursor-pointer text-xs">第 {String(round)} 轮</summary>
          {render(block.body,i=>local(i) && list(i.scope).some(s=>record(s).blockId === block.id && record(s).round === round),depth+1)}
        </details>) : <p className="text-xs text-muted">尚未进入循环体；条件不满足时可执行零轮。</p> : null}
        {kind === "forEach" ? items.map(key=><details key={key}><summary className="min-h-8 cursor-pointer break-words text-xs">业务项 · {key}</summary>{render(block.body,i=>local(i) && itemKey(i) === key,depth+1)}</details>) : null}
        {children.map(child=>render(child,local,depth+1))}
      </div>
    </details>;
  };
  return <section aria-label="结构化流程" className="space-y-2">
    <h3 className="text-sm font-medium">流程与执行实例</h3>
    {typeof view.error === "string" ? <p role="alert" className="text-sm text-danger">执行状态无法核对：{view.error}</p> : null}
    {render(definition.body,()=>true)}
  </section>;
}

/** Fetch full structure only when requested; list summaries stay lightweight. */
export function WorkflowStructureDetails({workspaceId,runId,revision}:{workspaceId:string;runId:string;revision:number}) {
  const client = useWorkbench(s=>s.client);
  const [open,setOpen] = useState(false);
  const [result,setResult] = useState<{owner:typeof client;run:WorkflowRunStatus}|null>(null);
  const [error,setError] = useState<string|null>(null);
  useEffect(()=>{
    if (!open || !client) return;
    let disposed = false;
    setError(null);
    void client.call({type:"workflow.get",payload:{workspaceId,runId}}).then(reply=>{
      if (disposed) return;
      if (reply?.type !== "workflowRun") throw Error("未收到流程记录");
      setResult({owner:client,run:reply.data});
    }).catch(cause=>{if(!disposed)setError(String(cause));});
    return ()=>{disposed=true;};
  },[client,open,workspaceId,runId,revision]);
  const run = result?.owner === client && result.run.id === runId ? result.run : null;
  return <details onToggle={event=>setOpen(event.currentTarget.open)} className="mt-2">
    <summary className="min-h-9 cursor-pointer text-xs text-accent">查看流程结构</summary>
    {open && error ? <p role="alert" className="text-sm text-danger">无法读取流程：{error}</p> : null}
    {open && run ? run.structure ? <StructuredWorkflow run={run}/> : <p className="text-xs text-muted">此记录使用原有 DAG 流程，可在执行记录中查看节点。</p> : open && !error ? <p className="text-xs text-muted">正在读取…</p> : null}
  </details>;
}
