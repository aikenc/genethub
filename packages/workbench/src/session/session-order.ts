import type { SessionSummary } from "@genehub/proto";

export const sessionLatest = (session: SessionSummary) => session.messagePreview?.atMs ?? session.updatedAtMs;

/** One row per session; a session's own latest activity owns its rank. */
export function orderSessions<T extends SessionSummary>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) =>
    sessionLatest(b) - sessionLatest(a) || a.id.localeCompare(b.id));
}

/** The same rule for `{session, ...}` rows that also carry their machine. */
export function orderSessionRows<T extends { session: SessionSummary }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    sessionLatest(b.session) - sessionLatest(a.session) || a.session.id.localeCompare(b.session.id));
}

/** Pinned entries keep their own order; pinning only moves them into a block. */
export function splitPinnedSessions<T>(
  entries: readonly T[],
  isPinned: (entry: T) => boolean,
): { pinned: T[]; normal: T[] } {
  const pinned: T[] = [], normal: T[] = [];
  for (const entry of entries) (isPinned(entry) ? pinned : normal).push(entry);
  return { pinned, normal };
}
