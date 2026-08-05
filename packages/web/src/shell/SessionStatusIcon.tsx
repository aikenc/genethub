import type { SessionSummary } from "@genehub/proto";

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
          ? { icon: "↻", label: "运行中", tone: "text-ok animate-pulse" }
          : unread
            ? { icon: "●", label: "已完成未阅读", tone: "text-accent" }
            : { icon: "✓", label: "已完成已阅读", tone: "text-faint" };

  return (
    <span
      className={`inline-flex w-4 shrink-0 items-center justify-center text-[11px] leading-none ${state.tone}`}
      role="img"
      aria-label={state.label}
      title={state.label}
    >
      {state.icon}
    </span>
  );
}
