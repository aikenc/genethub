import type { SessionSummary } from "@genehub/proto";
import { Circle, CircleDashed, Hand, Inbox, Loader2, Pause, TriangleAlert, Users } from "lucide-react";
import { sessionAttention } from "../session/attention";

/** Existing state priority is unchanged. Collaboration and unread are additional facts. */
export function SessionStatusIcon({ session, sessions, showLabel = false, unread = false, stale = false, disconnected = false, observedAtMs = 0 }: {
  session: SessionSummary; sessions?: readonly SessionSummary[]; showLabel?: boolean; unread?: boolean;
  stale?: boolean; disconnected?: boolean; observedAtMs?: number;
}) {
  const facts = sessionAttention(session, sessions);
  const kind = facts.kind || (stale ? "unknown" : null);
  const previous = facts.label || "空闲";
  const label = stale ? `${disconnected ? "连接中断 · " : ""}${observedAtMs ? `上次确认 ${new Date(observedAtMs).toLocaleTimeString()}：${previous}` : "尚未确认状态"}` : facts.label;
  const Icon = kind === "pending" ? Hand : kind === "blocked" ? TriangleAlert : kind === "running" ? Loader2 : kind === "unknown" ? CircleDashed : Circle;
  const tone = kind === "pending" ? "text-accent" : kind === "blocked" ? "text-danger" : kind === "running" ? "text-ok" : "text-muted";
  const coord = session.coordination;
  const mark = (name: string, icon: typeof Pause, count?: number) => {
    const Extra = icon;
    return <span role="img" aria-label={name} title={name} className="inline-flex shrink-0 items-center gap-0.5 text-muted"><Extra aria-hidden className="h-4 w-4" />{count ? <span className="text-[11px]">{count}</span> : null}</span>;
  };
  return <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
    {kind && <span role="img" aria-label={label} title={label} className={`inline-flex min-w-0 items-center gap-1 ${tone}`}>
      <Icon className={`h-4 w-4 shrink-0 ${kind === "running" && !stale ? "animate-spin" : ""}`} aria-hidden />
      {facts.pending > 1 && !showLabel && <span className="text-[11px]">{facts.pending}</span>}
      {showLabel && <span className="truncate">{label}</span>}
    </span>}
    {!showLabel && <>
      {session.inputSummary?.paused && mark("已暂停", Pause)}
      {coord?.pending ? mark(`等待协作 ${coord.pending} 项`, Users, coord.pending) : null}
      {coord?.ready ? mark(`${coord.ready} 项结果待处理`, Inbox, coord.ready) : null}
      {(coord?.stale || coord?.unknown) ? mark("协作状态待核对", CircleDashed) : null}
    </>}
    {unread && <span role="img" aria-label="有未读新回复" title="有未读新回复" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
  </span>;
}

/** Counts describe this supplied set, never an unqueried project's total. */
export function SessionActivityIcons({ sessions, partial = false, stale = false }: {
  sessions: readonly SessionSummary[]; partial?: boolean; stale?: boolean;
}) {
  const facts = sessions.map(s => sessionAttention(s, sessions));
  const counts = [facts.reduce((n, f) => n + f.pending, 0), facts.filter(f => f.kind === "blocked").length,
    facts.filter(f => f.kind === "running").length, facts.filter(f => f.kind === "task").length];
  const icons = [Hand, TriangleAlert, Loader2, Circle];
  const names = ["待你处理", "运行异常", "Agent 处理中", "进行中"];
  const tones = ["text-accent", "text-danger", "text-ok", "text-muted"];
  return <span className="inline-flex min-w-0 items-center gap-2" title={stale ? "上次同步状态" : partial ? "≥ 表示已读取会话中的活动下限" : "当前会话活动"}>
    {counts.map((n, i) => { const Icon = icons[i]!; return n ? <span key={i} role="img" aria-label={`${partial ? "至少 " : ""}${n} ${names[i]}`} className={`inline-flex items-center gap-0.5 text-[11px] ${tones[i]}`}><Icon aria-hidden className={`h-4 w-4 ${i === 2 && !stale ? "animate-spin" : ""}`} />{partial ? "≥" : ""}{n}</span> : null; })}
    {stale && <CircleDashed role="img" aria-label="状态待同步" className="h-4 w-4 text-faint" />}
  </span>;
}
