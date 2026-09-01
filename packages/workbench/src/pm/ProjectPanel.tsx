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
  const [overview, setOverview] = useState<PmProjectStatus | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [spacesExpanded, setSpacesExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !projectWorkspaceId) return;
    const reply = await client.call({
      type: "pm.project.status",
      payload: { workspaceId: projectWorkspaceId, sessionId: session.id },
    });
    if (reply?.type !== "projectStatus") throw new Error("项目状态响应无效");
    setStatus(reply.data);
    setError(null);
  }, [client, projectWorkspaceId, session.id]);

  const refreshOverview = useCallback(async () => {
    if (!client || !projectWorkspaceId) return;
    const reply = await client.call({
      type: "pm.project.status",
      payload: { workspaceId: projectWorkspaceId },
    });
    if (reply?.type !== "projectStatus") throw new Error("项目总览响应无效");
    setOverview(reply.data);
  }, [client, projectWorkspaceId]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    void refresh().catch((cause: unknown) => setError(messageOf(cause)));
    const timer = window.setInterval(() => {
      void refresh().catch((cause: unknown) => setError(`项目状态已停止更新：${messageOf(cause)}`));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!overviewExpanded) return;
    void refreshOverview().catch((cause: unknown) => setError(`项目总览加载失败：${messageOf(cause)}`));
    const timer = window.setInterval(() => {
      void refreshOverview().catch((cause: unknown) => setError(`项目总览已停止更新：${messageOf(cause)}`));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [overviewExpanded, refreshOverview]);

  const run = status?.workflowRuns.find(
    (item) => item.controllerSessionId === session.id,
  );
  const graph = run?.definition ?? status?.workflowCatalog.workflows.find(
    (item) => item.id === run?.graphId,
  );
  const runPackages = status?.workPackages.filter(
    (item) => item.controllerSessionId === session.id,
  ) ?? [];
  const completedNodes = run?.nodeInstances.filter((item) => item.status === "completed").length ?? 0;
  const activeNodes = run?.nodeInstances.filter((item) => item.status === "active").length ?? 0;
  const exceptions = runPackages.filter(
    (item) => item.status === "blocked" || item.integrationError,
  );
  const reviewerFindings = runPackages.flatMap((item) =>
    (item.reviewFindings ?? []).map((finding) => ({ package: item, finding })),
  );
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
          {run ? `已完成节点 ${completedNodes}` : "准备中"}
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
              <p className="mt-1 text-muted">
                阶段 {status?.phase} · 已完成节点 {completedNodes} · 活动节点 {activeNodes} · 验收修订 {intent.revision}
              </p>
            </section>
          ) : <p className="text-muted">PM 正在澄清需求，尚未锁定验收口径。</p>}

          <section>
            <button
              type="button"
              className="flex w-full items-center text-left font-medium text-fg"
              onClick={() => setOverviewExpanded((value) => !value)}
            >
              项目管理总览
              <span className="ml-2 text-muted">{overview?.workflowRuns.length ?? "按需加载"}</span>
              <span className="ml-auto text-faint">{overviewExpanded ? "⌃" : "⌄"}</span>
            </button>
            {overviewExpanded ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {overview?.workflowRuns.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`rounded-lg border p-2 text-left hover:border-accent ${item.controllerSessionId === session.id ? "border-accent bg-accent/5" : "border-line"}`}
                    onClick={() => item.controllerSessionId && onOpenSession(item.controllerSessionId)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-fg">{item.intent?.outcome ?? item.outcome ?? item.graphId ?? "待选择工作流"}</span>
                      <span className="ml-auto shrink-0 text-accent">{item.status}</span>
                    </div>
                    <p className="mt-1 truncate text-faint">
                      {item.controllerSessionId ?? "无所属会话"} · {item.graphId ?? "discussion"}
                    </p>
                    {item.budget ? (
                      <p className="mt-1 text-muted">
                        剩余 {formatDuration(item.budget.remainingMs)} · 活动会话 {item.budget.activeWorkSessions}/{item.budget.maxConcurrentWorkSessions}
                      </p>
                    ) : null}
                  </button>
                )) ?? <p className="text-muted">正在加载跨 Session 项目状态…</p>}
              </div>
            ) : null}
          </section>

          {status?.template.upgradeAvailable ? (
            <section role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-amber-200">
              <p className="font-medium">项目 Workflow 模板有可选升级</p>
              <p className="mt-1 text-amber-100/80">
                当前基线 {status.template.installedVersion || "未标记"} · 可用基线 {status.template.availableVersion}。
                项目现有图与提示词仍可继续使用，系统不会自动覆盖。
              </p>
              <p className="mt-1 text-amber-100/70">
                先生成并合并 template bundle，再依次完成独立评审、用户批准和事务式晋级；已开始的 Run 继续使用自己固定的旧定义。
              </p>
            </section>
          ) : null}

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

          {run?.interpreterError ? (
            <p role="alert" className="rounded border border-red-500/30 bg-red-500/5 p-2 text-red-300">
              Workflow 解释器需要人工介入：{run.interpreterError}
            </p>
          ) : null}

          {run?.budget ? (
            <section
              role={run.status === "budgetExhausting" || run.status === "budgetExhausted" ? "alert" : undefined}
              className={`rounded border p-2 ${run.status === "budgetExhausting" || run.status === "budgetExhausted"
                ? "border-red-500/30 bg-red-500/5 text-red-300"
                : "border-line bg-canvas/40 text-muted"}`}
            >
              <p className="font-medium text-fg">
                {run.budget.userWaitStartedAtMs != null
                  ? "等待用户决定（执行计时已暂停）"
                  : run.status === "budgetExhausted"
                  ? "本轮执行预算已耗尽"
                  : run.status === "budgetExhausting"
                    ? "本轮预算已到期，正在停止所属工作会话"
                    : `执行预算剩余 ${formatDuration(run.budget.remainingMs)}`}
              </p>
              <p className="mt-1">
                并发会话 {run.budget.activeWorkSessions}/{run.budget.maxConcurrentWorkSessions}
                {" · "}累计会话 {run.budget.workSessionsStarted}/{run.budget.maxWorkSessions}
              </p>
              {run.budget.userWaitMs > 0 ? (
                <p className="mt-1">用户等待 {formatDuration(run.budget.userWaitMs)}</p>
              ) : null}
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
                              expectedRevision: run.revision,
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

          {reviewerFindings.length ? (
            <section>
              <p className="mb-2 font-medium text-fg">独立 Reviewer findings</p>
              <div className="space-y-2">
                {reviewerFindings.map(({ package: item, finding }, index) => (
                  <div key={`${item.id}:${index}`} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-fg">{item.title}</span>
                      <span className="text-amber-300">{finding.severity}</span>
                      <span className="ml-auto text-faint">
                        {finding.estimatedRequests == null ? "返工请求数待估" : `预计 ${finding.estimatedRequests} 次请求`}
                      </span>
                    </div>
                    <p className="mt-1 text-fg">{finding.title}</p>
                    <p className="mt-1 text-muted">验收影响：{finding.acceptanceImpact}</p>
                    <p className="mt-1 text-muted">Reviewer 建议：{finding.recommendedAction}</p>
                    <p className="mt-1 text-faint">由 PM 结合目标与本 Run 剩余预算决定返工或升级；PM 不复查代码。</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {exceptions.map((item) => (
            <p key={item.id} role="alert" className="rounded border border-red-500/30 bg-red-500/5 p-2 text-red-300">
              {item.title}：{item.integrationError ?? item.blockReason ?? "执行受阻，等待 PM 选择异常分支"}
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
  const capacityByNode = useMemo(
    () => new Map(run.resourceCapacities.map((capacity) => [capacity.nodeId, capacity])),
    [run.resourceCapacities],
  );
  const incomingByNode = useMemo(() => {
    const values = new Map<string, number>();
    for (const edge of graph.edges) values.set(edge.to, (values.get(edge.to) ?? 0) + 1);
    return values;
  }, [graph.edges]);
  const outgoingByNode = useMemo(() => {
    const values = new Map<string, number>();
    for (const edge of graph.edges) values.set(edge.from, (values.get(edge.from) ?? 0) + 1);
    return values;
  }, [graph.edges]);
  return <section>
    <div className="mb-2 flex items-center gap-2">
      <p className="font-medium text-fg">Workflow 真实拓扑</p>
      <span className="text-faint">入口：{graph.entry}</span>
    </div>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {graph.nodes.map((node) => {
        const instance = instanceByNode.get(node.id);
        const capacity = capacityByNode.get(node.id);
        const active = run.activeNodes.includes(node.id);
        return <div key={node.id} className={`rounded-md border px-2 py-1.5 ${active ? "border-accent bg-accent/10" : instance?.status === "completed" ? "border-emerald-500/40" : "border-line"}`}>
            <div className="flex items-center gap-2">
              <p className="truncate font-medium text-fg">{node.id}</p>
              {node.id === graph.entry ? <span className="rounded bg-accent/10 px-1 text-accent">入口</span> : null}
            </div>
            <p className="truncate text-faint">
              {node.activity ?? node.kind}{node.actor ? ` · ${node.actor}` : ""}{instance ? ` · ${instance.status} #${instance.iteration}` : ""}
            </p>
            <p className="truncate text-faint">
              入边 {incomingByNode.get(node.id) ?? 0} · 出边 {outgoingByNode.get(node.id) ?? 0}
            </p>
            {instance?.fanoutSource ? <p className="truncate text-faint">{instance.fanoutSealed ? "工作包已封闭" : "筹备工作包"}</p> : null}
            {capacity ? (
              <p className="truncate text-faint" title={`匹配 ${capacity.matchingSpaces} 个 Space；当前空闲 ${capacity.availableSpaces} 个`}>
                可分配 {capacity.availableSlots}/{capacity.maxItems} · 已占 {capacity.allocatedItems}
              </p>
            ) : null}
        </div>;
      })}
    </div>
    <div className="mt-2 space-y-1 rounded-md border border-line bg-canvas/30 p-2">
      <p className="font-medium text-fg">边与分支</p>
      {graph.edges.map((edge) => (
        <div key={edge.id} className="grid gap-x-2 text-faint sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <span className="truncate text-fg">{edge.from} → {edge.to}</span>
          <span className="truncate" title={edge.condition}>
            {edge.label ?? edge.id}{edge.chooseBy ? ` · ${edge.chooseBy} 决策` : " · 自动"} · {edge.condition}
          </span>
        </div>
      ))}
    </div>
  </section>;
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatDuration(valueMs: number) {
  const seconds = Math.max(0, Math.ceil(valueMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
