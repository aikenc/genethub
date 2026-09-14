import type { ExecutorFlowStatus, FlowMessageStatus } from "@genehub/proto";
import { useEffect, useState } from "react";

import { useWorkbench } from "./store";
import { StructuredWorkflow } from "./StructuredWorkflow";

const labels: Record<string, string> = {
  "run.requested": "收到执行任务",
  "node.assigned": "派发节点",
  "node.completed": "节点完成",
  "run.completed": "流程完成",
  "run.cancelled": "任务已取消",
  "run.blocked": "任务受阻",
  "run.failed": "任务失败",
};
const statuses: Record<string, string> = {
  pending: "待执行", ready: "就绪", running: "执行中", waiting: "等待中",
  completed: "已完成", failed: "失败", blocked: "受阻", cancelled: "已取消",
  finishing: "节点收尾中", unreached: "未选择的分支", stopping: "正在收尾", cancelling: "取消中", changesRequested: "需要修改",
  skipped: "已跳过",
};
const labelStatus = (status: string) => statuses[status] ?? status;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.slice(0, 12_000) : "";

/** A read-only projection of the daemon's durable ledger, inside the transcript.
 * Poll snapshots serially: an Executor does not emit LLM timeline events.
 * The keyed owner prevents a late reply from crossing Session/machine switches.
 */
export function ExecutorFlow({ sessionId }: { sessionId: string }) {
  const client = useWorkbench((state) => state.client);
  const connection = useWorkbench((state) => state.connection);
  const selectSession = useWorkbench((state) => state.selectSession);
  const [snapshot, setSnapshot] = useState<{
    owner: typeof client;
    data: ExecutorFlowStatus;
  } | null>(null);
  const flow = snapshot?.owner === client && snapshot.data.executorSessionId === sessionId
    ? snapshot.data : null;
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setError(null);
    if (!client || connection !== "ready") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      let completed = false;
      try {
        const reply = await client!.call({ type: "session.flow", payload: { sessionId } });
        if (disposed) return;
        if (reply?.type !== "sessionFlow" || reply.data.executorSessionId !== sessionId) {
          throw new Error("未收到当前会话的执行记录");
        }
        setSnapshot({ owner: client, data: reply.data });
        setError(null);
        completed = ["completed", "cancelled", "blocked", "failed"].includes(reply.data.run.status);
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (!disposed && !completed) timer = setTimeout(() => void refresh(), 2_000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, connection, sessionId, retry]);

  // Preserve the authoritative journal order, including equal timestamps.
  const messages = [...new Map((flow?.messages ?? []).map((message) => [message.messageId, message])).values()];
  return (
    <section aria-label="Executor 执行信息流" className="space-y-4">
      <header className="rounded-xl border border-line bg-raised px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Executor 执行信息流</h2>
          <button type="button" onClick={() => setRetry((value) => value + 1)}
            className="min-h-11 text-xs text-accent md:min-h-0">刷新执行记录</button>
        </div>
        {flow ? <>
          <p className="mt-1 text-sm">{flow.run.workflowId} · {labelStatus(flow.run.status)}</p>
          {flow.run.reason ? <p className="mt-1 text-sm">{flow.run.reason}</p> : null}
          {flow.run.cleanupError ? <p role="alert" className="mt-1 text-sm text-danger">收尾待处理：{flow.run.cleanupError}</p> : null}
          <p className="mt-1 text-xs text-muted">最后更新：{new Date(flow.run.updatedAtMs).toLocaleString()}</p>
          <button type="button" className="mt-2 min-h-11 text-xs text-accent md:min-h-0"
            onClick={() => void selectSession(flow.run.parentSessionId)}>返回发起会话</button>
        </> : null}
        {connection !== "ready" ? <p role="status" className="mt-2 text-sm text-muted">连接中断，重新连接后更新执行记录。</p>
          : !flow && !error ? <p role="status" className="mt-2 text-sm text-muted">正在读取执行记录…</p> : null}
        {error ? <p role="alert" className="mt-2 break-words text-sm text-danger">无法读取执行记录：{error}。可刷新重试；新建的 Executor 会话需要先由发起会话启动流程。</p> : null}
      </header>
      {flow?.run.structure ? <StructuredWorkflow run={flow.run} /> : null}
      <ol className="space-y-4" aria-label="执行消息">
        {messages.filter(message => message.kind !== "structure.transition").map((message) => <FlowMessage key={message.messageId} message={message} />)}
      </ol>
      {flow ? <section aria-label="当前节点状态" className="rounded-xl border border-line px-4 py-3">
        <h3 className="text-sm font-medium">当前节点状态</h3>
        {(flow.run.nodes ?? []).map((node) => <div key={node.id} className="mt-3 border-t border-line pt-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-words">{node.id} · {node.uses} · {labelStatus(node.status === "finishing" ? node.status : node.outcome ?? node.status)}</span>
            {node.sessionId ? <button type="button" className="min-h-11 text-xs text-accent md:min-h-0"
              onClick={() => void selectSession(node.sessionId!)}>查看工作会话</button> : null}
          </div>
          {node.reason ? <p className="mt-1 text-sm">{node.reason}</p> : null}
          {Object.keys(node.evidence ?? {}).length ? <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted">结果与证据</summary>
            <dl className="mt-2 space-y-1 text-xs">{Object.entries(node.evidence).map(([key, value]) =>
              <div key={key} className="break-words"><dt className="font-medium">{key}</dt><dd className="whitespace-pre-wrap">{text(value)}</dd></div>)}</dl>
          </details> : null}
        </div>)}
      </section> : null}
    </section>
  );
}

function FlowMessage({ message }: { message: FlowMessageStatus }) {
  const selectSession = useWorkbench((state) => state.selectSession);
  const payload = record(message.payload);
  const workerId = message.kind === "node.assigned" ? message.recipientSessionId
    : message.kind === "node.completed" ? message.senderSessionId : null;
  return <li className="rounded-xl border border-line bg-surface px-4 py-3" data-flow-message-id={message.messageId}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span>流程记录</span><time dateTime={new Date(message.createdAtMs).toISOString()}>{new Date(message.createdAtMs).toLocaleString()}</time>
    </div>
    <h3 className="mt-2 break-words text-sm font-medium">{labels[message.kind] ?? message.kind}{message.nodeId ? ` · ${message.nodeId}` : ""}</h3>
    {text(payload.prompt) ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">{text(payload.prompt)}</p> : null}
    {text(payload.role) ? <p className="mt-1 text-xs text-muted">执行者：{text(payload.role)}</p> : null}
    {workerId ? <button type="button" className="mt-2 min-h-11 text-xs text-accent md:min-h-0"
      onClick={() => void selectSession(workerId)}>查看工作会话</button> : null}
    {!labels[message.kind] ? <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">消息详情</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(message.payload, null, 2)?.slice(0, 12_000)}</pre>
    </details> : null}
  </li>;
}
