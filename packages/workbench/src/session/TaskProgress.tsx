import type { SessionSummary } from "@genehub/proto";
import { useEffect, useState } from "react";

import { refreshAgentActivities, useAgentActivities } from "../workspace/useAgentActivity";
import { useWorkbench } from "./store";

const labels: Record<string, string> = {
  running: "进行中", stopping: "正在收尾", cancelling: "取消中",
  blocked: "受阻", failed: "失败", cancelled: "已取消", completed: "执行完成",
};

/** Shares the existing session-summary source with the lists. PM turn state
 * stays independent, and task cancellation never waits for an LLM answer. */
export function TaskProgress({ session }: { session: SessionSummary }) {
  const client = useWorkbench((state) => state.client);
  const connection = useWorkbench((state) => state.connection);
  const selectSession = useWorkbench((state) => state.selectSession);
  const activity = useAgentActivities();
  const summary = activity.sessions?.find((item) => item.id === session.id)?.workSummary ?? session.workSummary;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (client && connection === "ready") void refreshAgentActivities(client);
  }, [client, connection, session.id, session.status]);
  if (!summary || session.managed) return null;
  const active = summary.running + summary.stopping > 0;
  const pendingReport = summary.tasks.some(task => task.reportPending);
  const input = activity.sessions?.find(item => item.id === session.id)?.inputSummary ?? session.inputSummary;
  const heading = active ? `任务进行中 · PM ${session.status === "running" ? "处理中" : session.status === "waiting" ? "等待你的回答" : "待命"}`
    : summary.blocked > 0 ? "任务受阻，待处理" : pendingReport ? "执行完成 · 待 PM 核对与汇报" : "任务执行记录";
  const ready = connection === "ready" && !activity.error && !summary.error;
  const canCancel = ready && client?.identity?.features?.includes("workflow.control.v1");
  return <section aria-label="任务进度" className="max-h-56 shrink-0 overflow-y-auto border-b border-line bg-raised px-4 py-3 text-sm">
    <details open={active || pendingReport || summary.blocked > 0 || !!summary.error}>
      <summary className="cursor-pointer font-medium">{heading}</summary>
      {!ready && <p role="status" className="mt-2 text-muted">{summary.error ?? "任务状态待核对，连接恢复后更新。"}</p>}
      {!ready && summary.checkedAtMs > 0 && <p className="mt-1 text-xs text-muted">最近核对：{new Date(summary.checkedAtMs).toLocaleTimeString()}。</p>}
      {input?.pendingMessageIds.length ? <p role="status" className="mt-2 text-xs text-muted">{input.pendingMessageIds.length} 条消息已接收，{input.paused ? "PM 续接已暂停，发送新消息后继续" : "待 PM 处理"}。</p> : null}
      {input?.error && <p role="alert" className="mt-2 text-xs text-danger">{input.error}</p>}
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      <ul className="mt-2 space-y-3">
        {summary.tasks.map((task) => <li key={task.runId} className="border-t border-line pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{task.taskId} · {labels[task.status] ?? task.status}</span>
            {canCancel && !["completed", "cancelled"].includes(task.status) && <button type="button"
              className="min-h-9 px-2 text-danger disabled:opacity-50" disabled={!!busy || task.status === "cancelling"}
              onClick={() => {
                if (!client) return;
                const owner = client;
                setBusy(task.runId); setError(null);
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
              }}>{busy === task.runId ? "正在提交终止…" : task.status === "cancelling" ? "取消中" : "终止任务"}</button>}
          </div>
          {task.reportPending && <p className="mt-1 text-xs text-muted">{task.status === "running" ? "任务有新情况，待 PM 处理。" : "执行结果待 PM 核对新消息并汇报。"}</p>}
          {task.activeNodes.length > 0 && <p className="mt-1 text-xs text-muted">当前步骤：{task.activeNodes.join("、")}</p>}
          {task.reason && <p className="mt-1 whitespace-pre-wrap text-xs">{task.reason}</p>}
          {task.waiting?.map(waiting => <button key={waiting.requestId} type="button"
            className="block min-h-9 text-left text-xs text-accent"
            aria-label={`查看 ${waiting.nodeId} 待处理问题`}
            onClick={() => void selectSession(waiting.sessionId)}>
            {waiting.nodeId}：{waiting.title} · 查看问题
          </button>)}
          {task.cleanupError && <p className="mt-1 text-xs text-danger">收尾待处理：{task.cleanupError}</p>}
          {task.executorSessionId && <button type="button" className="min-h-9 text-xs text-accent"
            onClick={() => void selectSession(task.executorSessionId!)}>查看执行记录</button>}
        </li>)}
      </ul>
      {summary.more > 0 && <p className="mt-2 text-xs text-muted">另有 {summary.more} 项历史任务；可通过 Workflow 检查查看详情。</p>}
    </details>
  </section>;
}
