import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PmProjectStatus,
  PmWorkflowDefinitionStatus,
  SessionSummary,
  WorkspaceInfo,
} from "@genehub/proto";

import type { Client } from "../protocol/client";

export function ProjectPanel({
  client,
  session,
  workspaces,
  onOpenSession,
  onOpenWorkspace,
}: {
  client: Client | null;
  session: SessionSummary;
  workspaces: WorkspaceInfo[];
  onOpenSession: (sessionId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  const pmWorkspace = workspaces.find((item) => item.id === session.workspaceId);
  const projectWorkspaceId = pmWorkspace?.parentWorkspaceId;
  const [status, setStatus] = useState<PmProjectStatus | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [spacesExpanded, setSpacesExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !projectWorkspaceId) return;
    const reply = await client.call({
      type: "pm.project.status",
      payload: { workspaceId: projectWorkspaceId },
    });
    if (reply?.type === "projectStatus") setStatus(reply.data);
  }, [client, projectWorkspaceId]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    void refresh().catch((cause: unknown) => setError(messageOf(cause)));
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = status?.workflowRuns.find(
    (item) => item.controllerSessionId === session.id,
  );
  const graph = run?.definition ?? status?.workflowCatalog.workflows.find(
    (item) => item.id === run?.graphId,
  );
  const runPackages = status?.workPackages.filter(
    (item) => item.controllerSessionId === session.id,
  ) ?? [];
  // Cancelled retry attempts remain in history but must not make the current
  // delivery look progressively more complete on every failed iteration.
  const deliveryPackages = runPackages.filter((item) => item.status !== "cancelled");
  const completed = deliveryPackages.filter((item) => item.status === "accepted").length;
  const total = deliveryPackages.length;
  const exceptions = runPackages.filter((item) => item.status === "blocked");
  const intent = run?.intent ?? null;

  async function mutate(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!projectWorkspaceId) return null;
  return (
    <aside className="shrink-0 border-b border-line bg-raised/70" aria-label="需求推进">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="text-sm font-medium text-fg">需求推进</span>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
          {completed}/{total || "—"}
        </span>
        {run?.graphId ? <span className="truncate text-xs text-muted">{run.graphId}</span> : null}
        {run?.outcome ? <span className="truncate text-xs text-muted">{run.outcome}</span> : null}
        {exceptions.length ? (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
            {exceptions.length} 个异常
          </span>
        ) : null}
        <span className="ml-auto text-faint">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded ? (
        <div className="max-h-[48vh] space-y-3 overflow-y-auto border-t border-line px-4 py-3 text-xs">
          {intent ? (
            <section>
              <p className="text-sm font-medium text-fg">{intent.outcome}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${total ? Math.round((completed / total) * 100) : 0}%` }}
                />
              </div>
              <p className="mt-1 text-muted">阶段 {status?.phase} · 修订 {intent.revision}</p>
            </section>
          ) : <p className="text-muted">PM 正在澄清需求，尚未锁定验收口径。</p>}

          {status && (!run?.graphId || run.status === "discussion") ? (
            <section>
              <p className="mb-2 font-medium text-fg">{run?.graphId ? "切换工作流（尚未开始）" : "选择项目工作流"}</p>
              <div className="flex flex-wrap gap-2">
                {status.workflowCatalog.workflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    disabled={busy !== null}
                    className={`rounded-md border px-2.5 py-1.5 text-fg hover:border-accent disabled:opacity-50 ${run?.graphId === workflow.id ? "border-accent bg-accent/10" : "border-line"}`}
                    onClick={() => void mutate(`select:${workflow.id}`, async () => {
                      await client?.call({ type: "pm.workflow.select", payload: {
                        workspaceId: projectWorkspaceId,
                        sessionId: session.id,
                        graphId: workflow.id,
                      }});
                    })}
                  >
                    {workflow.id}{workflow.id === status.workflowCatalog.recommended ? " · 推荐" : ""}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {graph && run ? <Workflow graph={graph} run={run} /> : null}

          {run?.availableEdges.length ? (
            <section className="space-y-2">
              <p className="font-medium text-fg">下一步与异常分支</p>
              {run.availableEdges.map((edge) => {
                const userDecision = edge.chooseBy === "user";
                return (
                  <div key={edge.id} className="rounded-lg border border-line bg-canvas/40 p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-fg">{edge.from} → {edge.to}</span>
                      <span className="text-muted">{edge.satisfied ? "条件已满足" : "等待证据"}</span>
                    </div>
                    {edge.description ? <p className="mt-1 text-muted">{edge.description}</p> : null}
                    {userDecision ? (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={busy !== null || !edge.satisfied}
                          className="rounded bg-accent px-2.5 py-1 text-canvas disabled:opacity-50"
                          onClick={() => void mutate(`edge:${edge.id}`, async () => {
                            await client?.call({ type: "pm.workflow.transition", payload: {
                              workspaceId: projectWorkspaceId,
                              sessionId: session.id,
                              edgeId: edge.id,
                              facts: [],
                            }});
                          })}
                        >{edge.label ?? "确认选择"}</button>
                      </div>
                    ) : edge.chooseBy === "pm" ? (
                      <p className="mt-1 text-muted">由 PM 根据证据选择</p>
                    ) : (
                      <p className="mt-1 text-muted">由 Coordinator 根据证据推进</p>
                    )}
                  </div>
                );
              })}
            </section>
          ) : null}

          {run?.teamSlots.length ? (
            <section>
              <p className="mb-2 font-medium text-fg">当前小队</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {run.teamSlots.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    disabled={!slot.workSessionId}
                    onClick={() => slot.workSessionId && onOpenSession(slot.workSessionId)}
                    className="rounded-lg border border-line p-2 text-left hover:border-accent disabled:cursor-default"
                  >
                    <span className="font-medium text-fg">{slot.responsibility}</span>
                    <span className="ml-2 text-accent">{slot.status}</span>
                    <p className="mt-1 text-muted">{slot.workPackageId} · {slot.nodeInstanceId}</p>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {exceptions.map((item) => (
            <p key={item.id} role="alert" className="rounded border border-red-500/30 bg-red-500/5 p-2 text-red-300">
              {item.title}：{item.blockReason ?? "执行受阻，等待 PM 选择异常分支"}
            </p>
          ))}
          {status?.improvementCandidates.length ? (
            <section>
              <p className="mb-2 font-medium text-fg">PM 自举改进</p>
              <div className="space-y-2">
                {status.improvementCandidates.map((candidate) => (
                  <div key={candidate.id} className="rounded-lg border border-line p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-fg">{candidate.id}</span>
                      <span className="text-accent">{candidate.status}</span>
                      <span className="ml-auto truncate text-faint">{candidate.target}</span>
                    </div>
                    <p className="mt-1 text-muted">{candidate.rationale}</p>
                    {candidate.reviewEvidence ? <p className="mt-1 text-faint">评审：{candidate.reviewEvidence}</p> : null}
                    {candidate.status === "reviewed" ? <div className="mt-2 flex gap-2">
                      <button type="button" disabled={busy !== null} className="rounded bg-accent px-2.5 py-1 text-canvas" onClick={() => void mutate(`approve:${candidate.id}`, async () => {
                        await client?.call({ type: "pm.improvement.approve", payload: { workspaceId: projectWorkspaceId, sessionId: session.id, candidateId: candidate.id, approved: true } });
                      })}>批准晋级</button>
                      <button type="button" disabled={busy !== null} className="rounded border border-line px-2.5 py-1 text-fg" onClick={() => void mutate(`reject:${candidate.id}`, async () => {
                        await client?.call({ type: "pm.improvement.approve", payload: { workspaceId: projectWorkspaceId, sessionId: session.id, candidateId: candidate.id, approved: false } });
                      })}>拒绝</button>
                    </div> : null}
                    {candidate.status === "approved" ? <p className="mt-2 text-emerald-400">已由用户批准；等待 PM 执行晋级并重新验证。</p> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {error ? <p role="alert" className="text-red-400">{error}</p> : null}

          {status ? (
            <section>
              <button type="button" className="flex w-full items-center text-left font-medium text-fg" onClick={() => setSpacesExpanded((value) => !value)}>
                AgentSpace 资源 <span className="ml-2 text-muted">{status.agentSpaces.length}</span>
                <span className="ml-auto text-faint">{spacesExpanded ? "⌃" : "⌄"}</span>
              </button>
              {spacesExpanded ? <div className="mt-2 space-y-1">
                {status.agentSpaces.map((space) => (
                  <button
                    key={space.name}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-line/40"
                    onClick={() => space.workSessionId
                      ? onOpenSession(space.workSessionId)
                      : onOpenWorkspace(space.workspaceId)}
                  >
                    <span className="min-w-0 flex-1 truncate text-fg">{space.name}</span>
                    <span className={space.resourceState === "quarantined" ? "text-red-400" : "text-muted"}>{space.resourceState}</span>
                    <span className="text-faint">{space.workSessionId ? "打开会话 ↗" : "打开空间 ↗"}</span>
                  </button>
                ))}
              </div> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function Workflow({ graph, run }: { graph: PmWorkflowDefinitionStatus; run: NonNullable<PmProjectStatus["workflowRuns"]>[number] }) {
  const instanceByNode = useMemo(() => {
    const current = new Map<string, (typeof run.nodeInstances)[number]>();
    for (const instance of run.nodeInstances) {
      const previous = current.get(instance.nodeId);
      if (!previous || instance.iteration > previous.iteration) current.set(instance.nodeId, instance);
    }
    return current;
  }, [run.nodeInstances]);
  return <section>
    <p className="mb-2 font-medium text-fg">Workflow 节点</p>
    <div className="flex gap-1 overflow-x-auto pb-1">
      {graph.nodes.map((node, index) => {
        const instance = instanceByNode.get(node.id);
        const active = run.activeNodes.includes(node.id);
        return <div key={node.id} className="flex shrink-0 items-center gap-1">
          {index ? <span className="text-faint">→</span> : null}
          <div className={`max-w-40 rounded-md border px-2 py-1.5 ${active ? "border-accent bg-accent/10" : instance?.status === "completed" ? "border-emerald-500/40" : "border-line"}`}>
            <p className="truncate font-medium text-fg">{node.id}</p>
            <p className="truncate text-faint">{instance?.status ?? node.kind}{instance ? ` · #${instance.iteration}` : ""}</p>
            {instance?.fanoutSource ? <p className="truncate text-faint">{instance.fanoutSealed ? "工作包已封闭" : "筹备工作包"}</p> : null}
          </div>
        </div>;
      })}
    </div>
  </section>;
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
