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
    const parentId: string = owner.managed.parentSessionId;
    owner = sessions.find(item => item.id === parentId);
  }
  return undefined;
}

/** Only actual, accessible requests count as Human work. References to a
 * managed read-only worker are an obligation for its controller instead. */
export function pendingOwners(session: SessionSummary, _sessions: readonly SessionSummary[] = []): SessionSummary[] {
  const owners = new Map<string, SessionSummary>();
  const add = (owner: SessionSummary | undefined) => {
    if (owner && canHandleInteraction(owner) && (owner.interactionSummary?.count ?? 0) > 0) owners.set(owner.id, owner);
  };
  add(session);
  return [...owners.values()];
}

/** A task reference and its member's row lead to one actual request owner. */
export function pendingSessions(sources: readonly SessionSummary[], _sessions: readonly SessionSummary[]): SessionSummary[] {
  const owners = new Map<string, SessionSummary>();
  for (const source of sources) {
    for (const owner of pendingOwners(source)) owners.set(owner.id, owner);
  }
  return [...owners.values()];
}

export function sessionAttention(session: SessionSummary, sessions: readonly SessionSummary[] = []) {
  const owners = pendingOwners(session, sessions);
  const pending = owners.reduce((count, owner) => count + (owner.interactionSummary?.count ?? 0), 0);
  const running = session.status === "running";
  const blocked = session.status === "failed";
  const inProgress = running || session.status === "waiting";
  const activity = running ? "Agent 处理中" : "";
  const waiting = !pending && session.status === "waiting"
    ? session.managed?.userInteraction === "readOnly" ? "等待上级处理"
      : session.interactionSummary ? "等待继续执行" : "等待交互 · 待核对"
    : "";
  const attention = pending ? `待你处理${pending > 1 ? ` ${pending}` : ""}` : "";
  const label = [attention, blocked ? "运行异常" : "", activity, waiting]
    .filter(Boolean).join(" · ");
  return {
    pending, owners, running, inProgress, blocked,
    label,
    kind: pending ? "pending" : blocked ? "blocked" : running ? "running" : inProgress ? "task" : null,
  } as const;
}

export function matchesAttention(session: SessionSummary, filter: AttentionFilter, unread: boolean, sessions: readonly SessionSummary[] = []) {
  const facts = sessionAttention(session, sessions);
  return filter === "all" || (filter === "pending" ? facts.pending > 0
    : filter === "running" ? facts.inProgress : filter === "blocked" ? facts.blocked : unread);
}

export function hasCurrentWork(session: SessionSummary, sessions: readonly SessionSummary[] = []) {
  const facts = sessionAttention(session, sessions);
  return facts.inProgress || facts.pending > 0 || facts.blocked;
}
