import type { SessionSummary } from "@genehub/proto";
import { Circle, Hand, Loader2, TriangleAlert } from "lucide-react";
import { sessionAttention } from "../session/attention";

/** State and unread are separate marks; an activity never hides a Human request. */
export function SessionStatusIcon({ session, sessions, showLabel = false, unread = false, stale = false }: {
  session: SessionSummary;
  sessions?: readonly SessionSummary[];
  showLabel?: boolean;
  unread?: boolean;
  stale?: boolean;
}) {
  const facts = sessionAttention(session, sessions);
  const kind = stale ? "unknown" : facts.kind;
  const label = stale ? `状态待同步${facts.pending ? ` · 上次有 ${facts.pending} 项待办` : ""}` : facts.label;
  const Icon = kind === "pending" ? Hand : kind === "blocked" ? TriangleAlert : kind === "running" ? Loader2 : Circle;
  const tone = kind === "pending" ? "text-accent" : kind === "blocked" ? "text-danger" : kind === "running" ? "text-ok" : "text-muted";
  return <span className="inline-flex min-w-0 items-center gap-1">
    {kind && <span role="img" aria-label={label} title={stale ? `最近已知：${facts.label || "空闲"}` : label} className={`inline-flex min-w-0 items-center gap-1 ${tone}`}>
      <Icon className={`h-3 w-3 shrink-0 ${kind === "running" ? "animate-spin" : ""}`} aria-hidden />
      {showLabel && <span className="truncate">{label}</span>}
    </span>}
    {unread && <span role="img" aria-label="有未读新回复" title="有未读新回复" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
  </span>;
}
