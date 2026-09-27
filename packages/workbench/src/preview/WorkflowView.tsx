import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Request, WorkflowRunStatus } from "@genehub/proto";
import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { WorkflowStructureDetails } from "../session/StructuredWorkflow";
import { HtmlDocument } from "./AssetPreviewPage";
import { workflowBridgeScript } from "./workflowBridge";
import { emitClientDiagnostic } from "../diagnostics";

export type WorkflowViewTarget = { workspaceId: string; runId: string; viewId?: string; nodeId?: string; params?: Record<string,unknown> };
type ViewInfo = { id: string; title: string; entry: string };
type BuildViews = { build: string; packageId: string; views: ViewInfo[] };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("平台调用参数应是对象");
  return value as Record<string, unknown>;
}
function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value;
}
const mime = (path: string) => ({html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", woff: "font/woff", woff2: "font/woff2", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", wasm: "application/wasm"}[path.split(".").pop() ?? ""] ?? "application/octet-stream");

/** Uses exactly the existing Asset Preview renderer and file transport. */
export function WorkflowView({ target, client, onClose, onSessionNavigation }: { target: WorkflowViewTarget; client: Client; onClose(): void; onSessionNavigation(): void }) {
  const [bundle, setBundle] = useState<{ catalog: BuildViews; run: WorkflowRunStatus; view: ViewInfo; bytes: Uint8Array; instanceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auditWarning, setAuditWarning] = useState<string | null>(null);
  const [structure, setStructure] = useState<{workspaceId: string; runId: string; revision: number; nodeId?: string} | null>(null);
  const fetchAsset = useCallback(async (path: string) => {
    const reply = await client.call({type: "workflow.view", payload: {...target, path}});
    if (reply?.type !== "workflowView") throw new Error("未收到构建资源");
    const data = record(reply.data);
    const bytes = Uint8Array.from(atob(String(data.base64 ?? "")), char => char.charCodeAt(0));
    return {bytes, mediaType: mime(path)};
  }, [client, target]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalogReply, runReply] = await Promise.all([
        client.call({type: "workflow.view", payload: {workspaceId: target.workspaceId, runId: target.runId, path: null}}),
        client.call({type: "workflow.get", payload: {workspaceId: target.workspaceId, runId: target.runId}}),
      ]);
      if (catalogReply?.type !== "workflowView" || runReply?.type !== "workflowRun") throw new Error("工作流视图读取失败");
      const catalog = catalogReply.data as unknown as BuildViews;
      const view = target.viewId ? catalog.views.find(item => item.id === target.viewId) : catalog.views.find(item => item.id === "progress") ?? catalog.views[0];
      if (!view) throw new Error("这个工作流构建没有对应视图。可在小队任务详情中查看流程结构。");
      const asset = await fetchAsset(view.entry);
      if (!cancelled) setBundle({catalog, run: runReply.data, view, bytes: asset.bytes, instanceId: crypto.randomUUID()});
    })().catch(cause => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { cancelled = true; };
  }, [client, target, fetchAsset]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const bridge = useMemo(() => {
    if (!bundle) return undefined;
    const context = {...target, build: bundle.catalog.build, packageId: bundle.catalog.packageId,
      nodeId: target.nodeId, parentSessionId: bundle.run.parentSessionId, executionRoot: bundle.run.executionRoot, viewId: bundle.view.id};
    const paths = new Map<string, Promise<string[]>>();
    async function filePath(workspaceId: string, path: string): Promise<string> {
      let roots = paths.get(workspaceId);
      if (!roots) {
        roots = client.call({type:"workspace.list"}).then(reply => {
          if (reply?.type !== "workspaces") throw new Error("文件 Workspace 无法读取");
          return reply.data.find(workspace=>workspace.id===workspaceId)?.folders.map(folder=>folder.rootHandle).filter((handle): handle is string=>!!handle) ?? [];
        }); paths.set(workspaceId, roots);
      }
      const handles = await roots;
      if (!handles.length) throw new Error("Workspace 没有文件根目录");
      if (handles.includes(path.split("/")[0] ?? "")) return path;
      return `${handles[0]}/${path.replace(/^\.\//, "")}`;
    }
    const auditFolders = new Map<string, Promise<void>>();
    async function authorize(kind: string, payload: Record<string, unknown>) {
      const method = typeof payload.method === "string" ? payload.method : typeof payload.name === "string" ? payload.name : typeof payload.action === "string" ? payload.action : "readFile";
      const origin = {at: new Date().toISOString(), packageId: bundle!.catalog.packageId, build: bundle!.catalog.build,
        runId: target.runId, viewId: bundle!.view.id, kind, method};
      emitClientDiagnostic({at: origin.at, kind: "operation", detail: {operation: "workflow.view", ...origin}});
      // Same file API as the view. Metadata only, never RPC/file contents.
      // Audit failure is visible and cannot turn an executed write into a retry.
      try {
        const folder = await filePath(target.workspaceId, `.genethub/temp/workflow-view-calls/${target.runId}`);
        let ready = auditFolders.get(folder);
        if (!ready) {
          ready = client.call({type:"file.mkdir",payload:{workspaceId:target.workspaceId,path:folder}}).then(() => undefined).catch(async () => {
            // mkdir is not idempotent. Confirm an existing directory instead
            // of treating its existence as an audit failure.
            const reply = await client.call({type:"file.tree",payload:{workspaceId:target.workspaceId,path:folder,depth:1}});
            if (!reply) throw new Error("调用记录目录不可读取");
          });
          auditFolders.set(folder, ready);
        }
        await ready;
        const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[-:T]/g, "").slice(2, 14);
        const name = `${stamp.slice(0,6)}-${stamp.slice(6)}_${crypto.randomUUID().replaceAll("-", "").slice(0,16)}.json`;
        await client.call({type:"file.write",payload:{workspaceId:target.workspaceId,path:`${folder}/${name}`,content:JSON.stringify({...origin,phase:"requested"})}});
      } catch {
        setAuditWarning("视图调用记录未能持久化；调用仍按现有权限执行，写操作超时后请核对结果。");
      }
      return true; // First version grants all normal client operations.
    }
    return {instanceId: bundle.instanceId, script: workflowBridgeScript(context, bundle.instanceId), handle: async (kind: string, raw: unknown) => {
      const payload = record(raw);
      await authorize(kind, payload);
      // Deliberately no RPC whitelist: package code has normal client authority.
      // No retry here: the existing protocol owns receipts and CAS fences.
      if (kind === "rpc") {
        const method = required(payload.method, "RPC 方法");
        const reply = await client.call({type: method, ...(payload.payload !== undefined ? {payload: payload.payload} : {})} as Request);
        if (!reply) throw new Error("平台没有返回调用结果");
        return "data" in reply ? reply.data : reply;
      }
      if (kind === "file" || kind === "readFile") {
        const workspaceId = required(payload.workspaceId,"Workspace");
        const path = await filePath(workspaceId,required(payload.path,"文件路径"));
        const action = kind === "readFile" ? "readFile" : payload.action;
        if (action === "readFile") {
          const file = await client.preview(workspaceId,path);
          return new TextDecoder().decode(file.bytes);
        }
        if (action === "writeFile" && typeof payload.content !== "string") throw new Error("文件内容必须是文本");
        const request: Request = action === "readdir" ? {type:"file.tree",payload:{workspaceId,path,depth:1}}
          : action === "writeFile" ? {type:"file.write",payload:{workspaceId,path,content:typeof payload.content === "string" ? payload.content : ""}}
          : action === "mkdir" ? {type:"file.mkdir",payload:{workspaceId,path}}
          : action === "remove" ? {type:"file.delete",payload:{workspaceId,paths:[path]}}
          : (()=>{throw new Error("未知文件动作");})();
        const reply=await client.call(request);
        if (!reply) throw new Error("文件调用未返回结果");
        return "data" in reply ? reply.data : reply;
      }
      if (kind !== "intent") throw new Error("未知视图动作");
      const name = required(payload.name, "动作");
      const args = record(payload.payload ?? {});
      const store = useWorkbench.getState();
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : target.workspaceId;
      if (name === "openSession") {
        await store.selectSession(required(args.sessionId, "Session")); onSessionNavigation();
      } else if (name === "draftToPM") {
        await store.selectSession(bundle.run.parentSessionId); onSessionNavigation();
        for (const line of required(args.text, "草稿").split(/\r?\n/).filter(Boolean)) store.appendComposerDraftLine(bundle.run.parentSessionId, line);
      } else if (name === "openView") {
        store.openWorkflowView({workspaceId, runId: typeof args.runId === "string" ? args.runId : target.runId, viewId: typeof args.viewId === "string" ? args.viewId : undefined, nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined, params: args.params === undefined ? undefined : record(args.params)});
      } else if (name === "openRun") {
        const runId = typeof args.runId === "string" ? args.runId : target.runId;
        const reply = await client.call({type: "workflow.get", payload: {workspaceId, runId}});
        if (reply?.type !== "workflowRun") throw new Error("未能读取流程结构");
        setStructure({workspaceId, runId, revision: reply.data.revision, nodeId: typeof args.nodeId === "string" ? args.nodeId : undefined});
      } else if (name === "openFile") {
        const deviceHandle = client.identity?.machineId;
        if (!deviceHandle) throw new Error("设备连接待同步");
        store.openPreviewFloat({deviceHandle, workspaceHandle: workspaceId, path: await filePath(workspaceId, required(args.path, "文件路径"))}); onClose();
      } else throw new Error("未知平台界面动作");
      return {ok: true};
    }};
  }, [bundle, client, target, onClose, onSessionNavigation]);
  return createPortal(<section role="dialog" aria-modal="true" aria-label={bundle?.view.title ?? "工作流进度"} className="genehub-ui fixed inset-0 z-[90] flex flex-col bg-surface text-fg">
    <header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
      <button type="button" className="min-h-11 px-2" onClick={() => structure ? setStructure(null) : onClose()}>‹ 返回</button>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{structure ? "流程结构" : bundle?.view.title ?? "工作流进度"}</h2>
        {bundle && <p className="truncate text-xs text-muted">由 {bundle.catalog.packageId} 工作流提供 · 构建 {bundle.catalog.build.replace(/^sha256:/, "").slice(0, 12)}</p>}</div>
      {bundle && bundle.catalog.views.length > 1 && <select aria-label="工作流视图" value={bundle.view.id} onChange={event => useWorkbench.getState().openWorkflowView({...target, viewId: event.target.value})}>
        {bundle.catalog.views.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
      </select>}
      {bundle && !structure && <button type="button" className="min-h-11 px-2 text-xs" onClick={() => setStructure({workspaceId: target.workspaceId, runId: target.runId, revision: bundle.run.revision})}>流程结构</button>}
    </header>
    {auditWarning && <p role="status" className="shrink-0 px-3 py-1 text-xs text-danger">{auditWarning}</p>}
    {error ? <p role="alert" className="p-5 text-danger">{error}</p> : structure ? <div className="overflow-auto p-4"><WorkflowStructureDetails {...structure} openInitially /></div> : bundle ?
      <HtmlDocument bytes={bundle.bytes} entryPath={bundle.view.entry} fetchAsset={fetchAsset} workflowBridge={bridge}
        metadata={{kind: "html", mediaType: "text/html", sourceBytes: bundle.bytes.length, version: bundle.catalog.build}} /> : <p role="status" className="p-5">读取工作流构建…</p>}
  </section>, document.body);
}
