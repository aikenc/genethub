import type { SessionSummary } from "@genehub/proto";
import { Loader2 } from "lucide-react";

/** A compact, readable status mark shared by tabs and every session list. */
export function SessionStatusIcon({
  status,
  unread = false,
}: {
  status: SessionSummary["status"] | undefined;
  unread?: boolean;
}) {
  const state =
    status === "failed"
      ? { icon: "⚠", label: "运行异常", tone: "text-danger" }
      : status === "waiting"
        ? { icon: "✋", label: "等待交互", tone: "text-accent" }
        : status === "running"
          ? { icon: null, label: "运行中", tone: "text-ok" }
          : unread
            ? { icon: "●", label: "已完成未阅读", tone: "text-accent" }
            : { icon: "✓", label: "已完成已阅读", tone: "text-faint" };

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
