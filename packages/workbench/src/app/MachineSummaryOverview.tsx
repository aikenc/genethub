import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Target } from "../host";
import { MachineSummaryDirectory, type SummaryDirectory, type SummarySource, type SummaryState, type MachineSummary } from "../protocol/summary-directory";
import { emitClientDiagnostic } from "../diagnostics";

const label: Record<SummaryState,string> = { deferred:"未展开，详情未刷新",waiting:"等待读取",loading:"正在读取",ready:"已读取",offline:"目录报告离线，显示上次记录",denied:"无权访问，已清除缓存",timeout:"读取超时，显示上次记录",unavailable:"暂时无法读取",notChecked:"本批未检查",partial:"内容超出本批显示预算",rateLimited:"请求频繁，请稍后刷新" };
export function MachineSummaryOverview({ source, onClose, onOpenSession }: {
  source: SummarySource; onClose():void; onOpenSession(target:Target,sessionId:string,signal:AbortSignal):Promise<void>;
}) {
  const directory=useRef<MachineSummaryDirectory|null>(null);
  const [result,setResult]=useState<SummaryDirectory>({sources:[],complete:false,checked:0});
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const [query,setQuery]=useState(""),[tab,setTab]=useState<"sessions"|"projects">("sessions"),[limit,setLimit]=useState(100);
  const [project,setProject]=useState<{sourceId:string;workspaceId:string;name:string}|null>(null);
  const [opening,setOpening]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null);
  const expandedRef=useRef<string|null>(null),refreshGeneration=useRef(0);
  const panel=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
  const alive=useRef(true);
  const openingController=useRef<AbortController|null>(null);
  const refresh=async(current=directory.current)=>{
    if(!current)return;
    const generation=++refreshGeneration.current;
    setBusy(true);setError("");
    try{await current.refresh(value=>{if(alive.current&&directory.current===current&&generation===refreshGeneration.current)setResult(value);},undefined,new Set(expandedRef.current?[expandedRef.current]:[]));}
    catch(e){if(alive.current && directory.current===current && generation===refreshGeneration.current && !(e instanceof DOMException && e.name==="AbortError"))setError("本次刷新未完成，下方保留上次记录。请稍后重试。");}
    finally{if(alive.current&&directory.current===current&&generation===refreshGeneration.current)setBusy(false);}
  };
  useEffect(()=>{
    const current=new MachineSummaryDirectory(source,{onDiagnostic:emitClientDiagnostic});
    directory.current=current;alive.current=true;void refresh(current);
    return()=>{alive.current=false;if(directory.current===current)directory.current=null;openingController.current?.abort();current.close();};
  },[source]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const key=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){e.preventDefault();close.current();}
      if(e.key==="Tab"){
        const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')??[]);
        const first=nodes[0],last=nodes.at(-1);
        if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener("keydown",key);return()=>{document.removeEventListener("keydown",key);previous?.focus();};
  },[]);
  const toggleSource=(id:string)=>{
    const next=expandedRef.current===id?null:id;
    expandedRef.current=next;setExpanded(next);setProject(null);setLimit(100);
    void refresh();
  };
  const needle=query.trim().toLocaleLowerCase();
  type Row={key:string;source:MachineSummary;title:string;subtitle:string;sessionId:string|null;workspaceId:string};
  const rows=result.sources.filter(row=>row.target.id===expanded).flatMap<Row>(row=>{
    const workspaces=new Map(row.workspaces.map(w=>[w.id,w.name]));
    const counts=new Map<string,number>();for(const session of row.sessions)counts.set(session.workspaceId,(counts.get(session.workspaceId)??0)+1);
    return tab==="sessions" ? row.sessions.filter(s=>!project || project.sourceId===row.target.id && project.workspaceId===s.workspaceId).map(s=>({key:`${row.target.id}:${s.id}`,source:row,title:s.title ?? "未命名会话",subtitle:workspaces.get(s.workspaceId)??"项目名称待同步",sessionId:s.id,workspaceId:s.workspaceId}))
      : row.workspaces.map(w=>({key:`${row.target.id}:${w.id}`,source:row,title:w.name,subtitle:`${counts.get(w.id)??0} 个已读取会话`,sessionId:null,workspaceId:w.id}));
  }).filter(row=>`${row.source.target.label} ${row.title} ${row.subtitle}`.toLocaleLowerCase().includes(needle));
  const open=async(target:Target,id:string)=>{
    const controller=new AbortController();openingController.current?.abort();openingController.current=controller;
    setOpening(true);setError("");
    try{await onOpenSession(target,id,controller.signal);if(!controller.signal.aborted)close.current();}
    catch{if(alive.current&&!controller.signal.aborted)setError("打开会话失败，请核对这台设备的连接和访问权限后重试。");}
    finally{if(alive.current)setOpening(false);}
  };
  if(typeof document==="undefined")return null;
  return createPortal(<div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 md:items-center md:p-4" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section ref={panel} role="dialog" aria-modal="true" aria-label="跨设备项目与会话" className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-2xl md:rounded-2xl">
      <header className="flex items-center gap-3 border-b border-line p-4"><div className="min-w-0 flex-1"><h2 className="font-medium">跨设备项目与会话</h2><p className="mt-1 text-xs text-muted">展开一台设备读取项目与会话目录，打开会话时加载正文。</p></div><button type="button" className="min-h-11 px-3 text-sm" disabled={busy} onClick={()=>void refresh()}>刷新</button><button type="button" aria-label="关闭跨设备总览" className="min-h-11 min-w-11" onClick={onClose}>×</button></header>
      <div className="shrink-0 space-y-3 border-b border-line p-4">
        <p role="status" className="text-xs text-muted">{busy?"正在读取…":error?"本次刷新未完成":expanded?"当前展开设备的读取已结束":"设备目录已读取，展开后读取详情"} · 已读取详情 {result.checked}/{result.sources.length} 台设备</p>
        {result.sources.length>32 && <p className="text-xs text-muted">仅刷新当前展开设备，其他设备详情不产生网络请求。</p>}
        <div aria-label="选择展开设备" className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">{result.sources.map(row=><button key={row.target.id} type="button" aria-expanded={expanded===row.target.id} aria-controls="expanded-source-summaries" className="min-h-11 rounded border border-line px-3 text-left text-xs" onClick={()=>toggleSource(row.target.id)}>{expanded===row.target.id?"收起":"展开"} {row.target.label}<span className="block text-muted">{label[row.state]}{row.updatedAt?` · 缓存 ${row.sessionTotal} 个会话`:""}</span></button>)}</div>
        <details className="max-h-36 overflow-y-auto text-xs"><summary className="cursor-pointer text-muted">查看每台设备的状态与更新时间</summary><ul className="mt-2 space-y-2">{result.sources.map(row=><li key={row.target.id} className="flex flex-wrap justify-between gap-1"><span>{row.target.label} · {label[row.state]} · {row.stateSource==="daemon"?"源端查询":row.stateSource==="directory"?"目录记录":"请求结果"} · {row.sessions.length}/{row.sessionTotal} 个会话 · {row.workspaces.length}/{row.workspaceTotal} 个项目</span><time dateTime={row.updatedAt??undefined}>{row.updatedAt?`上次成功：${new Date(row.updatedAt).toLocaleString()}`:"尚无成功读取记录"}</time></li>)}</ul></details>
        <div className="flex gap-2"><button type="button" aria-pressed={tab==="sessions"} className="min-h-9 rounded border border-line px-3 text-sm" onClick={()=>{setTab("sessions");setLimit(100);}}>会话</button><button type="button" aria-pressed={tab==="projects"} className="min-h-9 rounded border border-line px-3 text-sm" onClick={()=>{setTab("projects");setProject(null);setLimit(100);}}>项目</button><input aria-label="搜索跨设备项目与会话" className="min-w-0 flex-1 rounded border border-line bg-bg px-3 text-sm" placeholder="搜索设备、项目或会话" value={query} onChange={e=>{setQuery(e.target.value);setLimit(100);}}/></div>
        {project && <button type="button" className="text-xs text-accent" onClick={()=>setProject(null)}>清除项目筛选：{project.name} ×</button>}
        {error && <p role="alert" className="text-sm text-muted">{error}</p>}
      </div>
      <div id="expanded-source-summaries" className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="跨设备摘要列表"><ul className="space-y-2">{rows.slice(0,limit).map(row=><li key={row.key}><button type="button" disabled={opening || !["ready","partial"].includes(row.source.state)} className="flex min-h-14 w-full flex-col rounded-lg border border-line p-3 text-left hover:bg-raised disabled:opacity-60" onClick={()=>{if(row.sessionId)void open(row.source.target,row.sessionId);else{setProject({sourceId:row.source.target.id,workspaceId:row.workspaceId,name:row.title});setTab("sessions");setLimit(100);}}}><span className="break-words text-sm font-medium">{row.title}</span><span className="mt-1 text-xs text-muted">{row.source.target.label} · {row.subtitle}</span></button></li>)}</ul>{rows.length===0 && <p className="p-6 text-sm text-muted">{expanded?"暂未读到匹配记录，请查看来源状态或调整搜索条件。":"展开一台设备查看项目和会话；未展开设备不读取详情。"}</p>}{rows.length>limit && <button type="button" className="min-h-11 w-full text-sm text-accent" onClick={()=>setLimit(n=>n+100)}>继续显示 100 条（当前 {limit}/{rows.length}）</button>}</div>
    </section>
  </div>,document.body);
}
