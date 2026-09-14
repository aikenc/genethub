import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { useWorkbench } from "../session/store";
import type { Host, Endpoint } from "../host";
import { OpenProject } from "./OpenProject";
import { AgentAdvancedSettings } from "./AgentAdvancedSettings";
import { useAgentGroups } from "./agentGroups";
import { AgentAvatar, AgentAvatarPicker } from "./AgentAvatar";
import { WorkspaceDetailsDialog } from "./WorkspaceDetailsDialog";

export const AgentDetailsEnvironment = createContext<{ host: Host; endpoint: Endpoint; onCreateExpert?(): void; onOverview?(id: string, surface?: string, child?: boolean): void; workspaceTools?(id: string): ReactNode } | null>(null);

/** Shared facts for contact details, the desktop inspector and the chat header. */
export function AgentDetails({ workspace, deviceName, compact = false }: { workspace: WorkspaceInfo; deviceName: string; compact?: boolean }) {
  const client = useWorkbench((s) => s.client);
  const connection = useWorkbench((s) => s.connection);
  const workspaces = useWorkbench((s) => s.workspaces);
  const { groups } = useAgentGroups(client?.identity?.machineId ?? "");
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ owner: string; sessions?: SessionSummary[]; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (!client || connection !== "ready") return;
    void client.call({ type: "session.list", payload: { workspaceId: workspace.id, includeArchived: true } }).then((reply) => {
      if (cancelled) return;
      if (reply?.type !== "sessions") throw new Error("设备未返回会话数量");
      setResult({ owner: workspace.id, sessions: reply.data.filter((s) => s.workspaceId === workspace.id) });
    }).catch((e) => { if (!cancelled) setResult({ owner: workspace.id, error: e instanceof Error ? e.message : "读取失败" }); });
    return () => { cancelled = true; };
  }, [client, connection, workspace.id, reload]);
  const rows = result?.owner === workspace.id ? result.sessions : undefined;
  const components = workspace.agentSpace?.components.filter((c) => c.enabled).map((c) => c.role ? `${c.componentId} · ${c.role}` : c.componentId) ?? [];
  const parent = workspaces.find((w) => w.id === workspace.agentSpace?.parentWorkspaceId);
  return <section aria-label={`${workspace.name} 的资料`} className="min-w-0 space-y-4">
    {!compact && <div className="flex items-center gap-3"><AgentAvatar id={workspace.id} name={workspace.name} /><div className="min-w-0"><h2 className="break-words text-lg font-semibold">{workspace.name}</h2><p className="text-xs text-muted">{components.join(" / ") || (workspace.workspaceFile ? "多目录代码工作区" : "目录专家")}</p></div></div>}
    <dl className="space-y-3 text-sm">
      <Fact label="分组">{groups.filter((g) => g.workspaceIds.includes(workspace.id)).map((g) => g.name).join("、") || "未分组"}</Fact>
      <Fact label="所属设备">{deviceName || "当前设备"}</Fact>
      <Fact label="主路径">{workspace.root}</Fact>
      {workspace.workspaceFile && <Fact label="工作区文件">{workspace.workspaceFile}</Fact>}
      {parent && <Fact label="上级专家">{parent.name}</Fact>}
      <Fact label="会话数量">
        {rows ? <span>{rows.length} 个 · 未归档 {rows.filter((s) => !s.archived).length} · 已归档 {rows.filter((s) => s.archived).length}</span> : <span>{connection !== "ready" ? "设备未连接，暂时无法读取" : result?.error ? "读取失败" : "正在读取…"}</span>}
        <button type="button" disabled={connection !== "ready"} className="ml-2 min-h-8 text-xs text-accent disabled:opacity-40" onClick={() => setReload((n) => n + 1)}>刷新数量</button>
        {result?.owner === workspace.id && result.error && <p role="alert" className="mt-1 break-words text-xs text-danger">{result.error}</p>}
      </Fact>
    </dl>
    <ExpertDirectories workspace={workspace} />
    <details className="border-t border-line pt-2"><summary className="cursor-pointer py-2 text-sm text-muted">更换头像</summary><AgentAvatarPicker id={workspace.id} /></details>
  </section>;
}
/** Root management shared by the expert page and legacy details. */
export function ExpertDirectories({ workspace }: { workspace: WorkspaceInfo }) {
  const environment = useContext(AgentDetailsEnvironment);
  const client = useWorkbench(s => s.client);
  const folders = workspace.folders.length ? workspace.folders : [{ name: workspace.name, root: workspace.root }];
  return (
    <section><h3 className="mb-2 text-sm font-medium">Root 目录 · {folders.length}</h3><ul className="space-y-2">{folders.map((folder) => <li key={folder.root} className="rounded-lg border border-line bg-raised/40 p-3"><p className="text-sm font-medium">{folder.name}</p><p className="mt-1 break-all text-xs leading-5 text-muted">{folder.root}</p></li>)}</ul>
      {workspace.workspaceFile && environment && <div className="mt-3"><OpenProject host={environment.host} endpoint={environment.endpoint} directoryAction={{initialDirectory: workspace.root, onPick: async (root) => {
        if (!client) throw new Error("设备尚未连接");
        const reply = await client.call({ type: "workspace.addRoot", payload: { workspaceId: workspace.id, root } });
        if (reply?.type !== "workspace") throw new Error("未收到目录更新结果");
        if (useWorkbench.getState().client === client) await useWorkbench.getState().refreshWorkspaces();
      }}} /><p className="mt-2 text-xs text-muted">新增目录会写入 .code-workspace，新会话使用更新后的目录。</p></div>}
    </section>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3"><dt className="text-muted">{label}</dt><dd className="min-w-0 break-all">{children}</dd></div>;
}
export function AgentDetailsDialog({ workspace, deviceName, onClose, onBrowse }: { workspace: WorkspaceInfo; deviceName: string; onClose(): void; onBrowse?(): void }) {
  return <WorkspaceDetailsDialog title="资料与配置" fullScreenOnMobile onClose={onClose}>
    <AgentDetails key={workspace.id} workspace={workspace} deviceName={deviceName} />
    <AgentAdvancedSettings key={workspace.id + ":advanced"} workspace={workspace} />
    {onBrowse && <button type="button" className="mt-4 min-h-11 w-full rounded-lg bg-accent text-white" onClick={onBrowse}>打开专家面板</button>}
  </WorkspaceDetailsDialog>;
}
