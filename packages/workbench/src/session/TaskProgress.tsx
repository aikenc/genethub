import { WorkspaceDetailsDialog } from "../workspace/WorkspaceDetailsDialog";
import type { SessionSummary } from "@genehub/proto";
import { useEffect, useState } from "react";

import { refreshAgentActivities, useAgentActivities } from "../workspace/useAgentActivity";
import { useWorkbench } from "./store";
import { WorkflowStructureDetails } from "./StructuredWorkflow";
import { canHandleInteraction } from "./attention";

const labels: Record<string, string> = {
  running: "进行中", stopping: "停止中", cancelling: "停止中",
  blocked: "受阻", failed: "失败", cancelled: "已取消", completed: "执行完成",
};

/** Shares the existing session-summary source with the lists. PM turn state
 * stays independent, and task cancellation never waits for an LLM answer. */
export function TaskProgress({ session }: { session: SessionSummary }) {
  const client = useWorkbench((state) => state.client);
  const connection = useWorkbench((state) => state.connection);
  const selectSession = useWorkbench((state) => state.selectSession);
  const activity = useAgentActivities();
  const current = activity.sessions?.find((item) => item.id === session.id) ?? session;
  const summary = current.workSummary;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (client && connection === "ready") void refreshAgentActivities(client);
  }, [client, connection, session.id, session.status]);
  if (!summary || session.managed) return null;
  const stateLabel = summary.stopping ? "停止中" : summary.blocked ? "受阻"
    : summary.tasks.some(task => task.waiting?.length) ? "等待处理"
    : summary.tasks.some(task => task.executing) ? "小队执行中"
    : summary.running ? "等待推进"
    : summary.tasks.some(task => task.status === "failed") ? "失败"
    : summary.tasks.length && summary.tasks.every(task => task.status === "cancelled") ? "已取消" : "执行记录";
  const ready = connection === "ready" && !activity.error && !summary.error;
  const heading = `小队任务 · ${ready ? stateLabel : "待同步"} · ${summary.tasks.length + summary.more} 项`;
  const canCancel = ready && client?.identity?.features?.includes("workflow.control.v1");
  return <section aria-label="任务进度" className="shrink-0 border-b border-line bg-raised px-4 text-sm">
    <button type="button" aria-expanded={expanded} aria-haspopup="dialog" className="flex min-h-11 w-full items-center justify-between gap-2 text-left font-medium"
      onClick={() => setExpanded(true)}><span className="min-w-0 truncate">{heading}</span><span aria-hidden>›</span></button>
    {error && !expanded && <p role="alert" className="pb-2 text-danger">{error}</p>}
    {expanded && <WorkspaceDetailsDialog title="小队任务" onClose={() => setExpanded(false)}>
      {!ready && <p role="status" className="mt-2 text-muted">{summary.error ?? "任务状态待核对，连接恢复后更新。"}</p>}
      {!ready && summary.checkedAtMs > 0 && <p className="mt-1 text-xs text-muted">最近核对：{new Date(summary.checkedAtMs).toLocaleTimeString()}。</p>}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      <ul className="mt-2 space-y-3">
        {summary.tasks.map((task, index) => <li key={task.runId} className="border-t border-line pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{activity.sessions?.find(item => item.id === task.executorSessionId)?.title || `任务 ${index + 1}`} · {task.executing ? "小队执行中" : task.status === "running" && task.waiting?.length ? "等待处理" : labels[task.status] ?? task.status}</span>
            {canCancel && !["completed", "cancelled"].includes(task.status) && <button type="button"
              title={`终止 ${task.taskId} 及其小队；不影响 PM 本轮和其他任务`}
              className="min-h-9 px-2 text-danger disabled:opacity-50" disabled={!!busy || task.status === "cancelling"}
              onClick={() => {
                if (!client) return;
                const owner = client;
                setBusy(task.runId); setError(null); setExpanded(true);
                void owner.call({ type: "workflow.cancel", payload: { workspaceId: session.workspaceId, runId: task.runId, expectedRevision: task.revision } })
                  .then(async (reply) => {
                    if (reply?.type !== "workflowRun") throw new Error("未收到任务终止结果，请核对后重试。");
                    await refreshAgentActivities(owner);
                  })
                  .catch((cause: unknown) => {
                    if (useWorkbench.getState().client === owner) setError(cause instanceof Error ? cause.message : String(cause));
                    void refreshAgentActivities(owner);
                  })
                  .finally(() => { if (useWorkbench.getState().client === owner) setBusy(null); });
              }}>{busy === task.runId ? "正在提交终止…" : task.status === "cancelling" ? "停止中" : "终止任务"}</button>}
          </div>
          {task.reportPending && <p className="mt-1 text-xs text-muted">{task.status === "running" ? "任务有新情况，待 PM 处理。" : "执行结果待 PM 核对新消息并汇报。"}</p>}
          {task.activeNodes.length > 0 && <p className="mt-1 text-xs text-muted">当前步骤：{task.activeNodes.join("、")}</p>}
          {task.reason && <details className="mt-1 text-xs"><summary className="cursor-pointer truncate">{task.reason.split("\n")[0]}</summary><p className="mt-2 whitespace-pre-wrap break-words">{task.reason}</p></details>}
          {task.waiting?.map(waiting => {
            const owner = activity.sessions?.find(item => item.id === waiting.sessionId);
            const actionable = owner && canHandleInteraction(owner);
            return <div key={`${waiting.sessionId}:${waiting.requestId}`} className="mt-1 text-xs">
              <button type="button" className="min-h-9 text-left text-accent"
                aria-label={`查看 ${waiting.nodeId} 待处理问题`}
                onClick={() => void selectSession(waiting.sessionId)}>
                {waiting.nodeId}：{waiting.title} · {actionable ? "前往处理" : "查看问题"}
              </button>
              {!actionable && <div className="text-muted">由上级 Agent 处理。
                <button type="button" className="min-h-9 px-2 text-accent" onClick={() => {
                  useWorkbench.getState().appendComposerDraftLine(session.id, `请跟进任务「${task.taskId}」的「${waiting.nodeId}」待处理问题：${waiting.title}`);
                }}>向 PM 补充要求</button>
              </div>}
            </div>;
          })}
          {task.cleanupError && <p className="mt-1 text-xs text-danger">收尾待处理：{task.cleanupError}</p>}
          <WorkflowStructureDetails workspaceId={session.workspaceId} runId={task.runId} revision={task.revision} />
          {task.executorSessionId && <button type="button" className="min-h-9 text-xs text-accent"
            onClick={() => void selectSession(task.executorSessionId!)}>查看执行记录</button>}
        </li>)}
      </ul>
      {summary.more > 0 && <p className="mt-2 text-xs text-muted">另有 {summary.more} 项任务未在此展开；可向 PM 查询。</p>}
    </WorkspaceDetailsDialog>}
  </section>;
}
