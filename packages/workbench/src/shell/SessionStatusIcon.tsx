import type { SessionSummary } from "@genehub/proto";
import { Loader2 } from "lucide-react";

/** A compact, readable status mark shared by tabs and every session list. */
export function SessionStatusIcon({
  status,
  workSummary,
  unread: _unread = false,
}: {
  status: SessionSummary["status"] | undefined;
  workSummary?: SessionSummary["workSummary"];
  unread?: boolean;
}) {
  if (workSummary?.error) {
    return <span role="img" aria-label="任务状态待核对" title={workSummary.error} className="text-danger">⚠</span>;
  }
  if ((workSummary?.running ?? 0) + (workSummary?.stopping ?? 0) > 0) {
    return <span role="img" aria-label="任务进行中" title={status === "running" ? "任务进行中 · PM 处理中" : "任务进行中 · PM 待命"}
      className="inline-flex w-3.5 shrink-0 justify-center text-ok"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /></span>;
  }
  if ((workSummary?.blocked ?? 0) > 0 && status !== "running") {
    return <span role="img" aria-label="任务受阻" title="任务受阻，待处理" className="text-danger">⚠</span>;
  }
  if (status !== "failed" && status !== "waiting" && status !== "running") return null;
  const state =
    status === "failed"
      ? { icon: "⚠", label: "运行异常", tone: "text-danger" }
      : status === "waiting"
        ? { icon: "✋", label: "等待交互", tone: "text-accent" }
        : { icon: null, label: "运行中", tone: "text-ok" };

  return (
    <span
      className={`inline-flex w-3.5 shrink-0 items-center justify-center text-[11px] leading-none ${state.tone}`}
      role="img"
      aria-label={state.label}
      title={state.label}
    >
      {status === "running" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : state.icon}
    </span>
  );
}
