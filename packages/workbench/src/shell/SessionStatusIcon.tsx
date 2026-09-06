import type { SessionSummary } from "@genehub/proto";
import { Loader2 } from "lucide-react";

/** A compact, readable status mark shared by tabs and every session list. */
export function SessionStatusIcon({
  status,
  unread: _unread = false,
}: {
  status: SessionSummary["status"] | undefined;
  unread?: boolean;
}) {
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
