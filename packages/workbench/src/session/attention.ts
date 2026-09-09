import type { SessionSummary } from "@genehub/proto";

export type AttentionFilter = "all" | "pending" | "running" | "blocked" | "unread";
export const attentionFilters: readonly [AttentionFilter, string][] = [
  ["all", "全部"], ["pending", "待你处理"], ["running", "进行中"], ["blocked", "异常／受阻"], ["unread", "未读"],
];

export function canHandleInteraction(session: SessionSummary): boolean {
  return !session.unsupported && session.imported?.continuation !== "readOnly" && session.managed?.userInteraction !== "readOnly";
}

export function humanController(session: SessionSummary, sessions: readonly SessionSummary[]): SessionSummary | undefined {
  const seen = new Set<string>();
  let owner: SessionSummary | undefined = session;
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id);
    if (canHandleInteraction(owner)) return owner;
    if (!owner.managed) return undefined;
    const runId = owner.managed.workflowRunId;
    const pm = sessions.find(item => canHandleInteraction(item) && item.workSummary?.tasks.some(task => task.runId === runId));
    if (pm) return pm;
    const parentId: string = owner.managed.parentSessionId;
    owner = sessions.find(item => item.id === parentId);
  }
  return undefined;
}

/** Only actual, accessible requests count as Human work. References to a
 * managed read-only worker are an obligation for its controller instead. */
export function pendingOwners(session: SessionSummary, sessions: readonly SessionSummary[] = []): SessionSummary[] {
  const owners = new Map<string, SessionSummary>();
  const add = (owner: SessionSummary | undefined) => {
    if (owner && canHandleInteraction(owner) && (owner.interactionSummary?.count ?? 0) > 0) owners.set(owner.id, owner);
  };
  add(session);
  for (const task of session.workSummary?.tasks ?? []) {
    for (const wait of task.waiting ?? []) {
      const owner = sessions.find(item => item.id === wait.sessionId);
      if (owner?.interactionSummary?.requests.some(request => request.requestId === wait.requestId)) add(owner);
    }
  }
  return [...owners.values()];
}

/** A task reference and its member's row lead to one actual request owner. */
export function pendingSessions(sources: readonly SessionSummary[], sessions: readonly SessionSummary[]): SessionSummary[] {
  const owners = new Map<string, SessionSummary>();
  for (const source of sources) {
    for (const owner of pendingOwners(source, sessions)) owners.set(owner.id, owner);
  }
  return [...owners.values()];
}

export function sessionAttention(session: SessionSummary, sessions: readonly SessionSummary[] = []) {
  const work = session.workSummary;
  const owners = pendingOwners(session, sessions);
  const pending = owners.reduce((count, owner) => count + (owner.interactionSummary?.count ?? 0), 0);
  const pmRunning = session.status === "running";
  const teamRunning = (work?.executing ?? 0) > 0;
  const blocked = session.status === "failed" || (work?.blocked ?? 0) > 0;
  const inProgress = pmRunning || teamRunning || session.status === "waiting" ||
    (work?.running ?? 0) + (work?.stopping ?? 0) + (work?.blocked ?? 0) > 0;
  const ownLabel = work ? "PM" : "Agent";
  const activity = pmRunning && teamRunning ? "PM 与小队执行中"
    : teamRunning ? "小队执行中" : pmRunning ? `${ownLabel} 处理中` : "";
  const taskState = (work?.stopping ?? 0) > 0 ? "任务停止中"
    : (work?.blocked ?? 0) > 0 ? "任务受阻"
    : !teamRunning && (work?.running ?? 0) > 0
      ? work?.tasks.some(task => task.waiting?.length) ? "任务等待处理" : "任务进行中"
      : "";
  const waiting = !pending && session.status === "waiting"
    ? session.managed?.userInteraction === "readOnly" ? "等待上级处理"
      : session.interactionSummary ? "等待继续执行" : "等待交互 · 待核对"
    : "";
  const attention = pending ? `待你处理${pending > 1 ? ` ${pending}` : ""}` : "";
  const label = [attention, taskState, session.status === "failed" ? "运行异常" : "", activity, waiting]
    .filter(Boolean).join(" · ");
  return {
    pending, owners, pmRunning, teamRunning, inProgress, blocked,
    label: work?.error ? [attention, "任务状态待同步", activity].filter(Boolean).join(" · ") : label,
    kind: pending ? "pending" : work?.error ? "unknown" : blocked ? "blocked"
      : pmRunning || teamRunning ? "running" : inProgress ? "task" : null,
  } as const;
}

export function matchesAttention(session: SessionSummary, filter: AttentionFilter, unread: boolean, sessions: readonly SessionSummary[] = []) {
  const facts = sessionAttention(session, sessions);
  return filter === "all" || (filter === "pending" ? facts.pending > 0
    : filter === "running" ? facts.inProgress : filter === "blocked" ? facts.blocked || !!session.workSummary?.error : unread);
}

export function hasCurrentWork(session: SessionSummary, sessions: readonly SessionSummary[] = []) {
  const facts = sessionAttention(session, sessions);
  return facts.inProgress || facts.pending > 0;
}
