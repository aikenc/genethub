import type { SessionSummary } from "@genehub/proto";
import { useAgentActivities } from "../workspace/useAgentActivity";

/** Message receipt belongs to this conversation, independently of team work. */
export function InputDelivery({ session }: { session: SessionSummary }) {
  const activity = useAgentActivities();
  const input = (activity.sessions?.find(item => item.id === session.id) ?? session).inputSummary;
  if (!input || (!input.pendingMessageIds.length && !input.error)) return null;
  return <div aria-label="消息接收状态" className="shrink-0 px-4 py-2 text-xs text-muted">
    {!!input.pendingMessageIds.length && <p role="status">{input.pendingMessageIds.length} 条消息已接收，{input.paused ? "续接已暂停，发送新消息后继续" : "等待当前 Agent 处理"}。</p>}
    {input.error && <p role="alert" className="text-danger">{input.error}</p>}
  </div>;
}
