import type { SessionSummary } from "@genehub/proto";
import type { Client } from "./client";

/** Bounded summary reads. Older daemons must upgrade; never fall back to a full scan. */
export async function readSessionPage(client: Client, workspaceId: string | null = null, cursor: string | null = null, limit = 100, includeArchived = false, activeOnly = false) {
  if (!client.identity?.features?.includes("session.page.v1")) throw new Error("请更新此机器以读取分页会话。");
  if (activeOnly && !client.identity?.features?.includes("session.active-page.v1")) throw new Error("请更新此机器以完整读取活动会话。");
  const reply = await client.call({ type: "session.page", payload: {
    requests: [{ workspaceId, cursor, limit, ...(activeOnly ? {activeOnly: true} : {}) }], includeArchived,
  } }, { timeoutMs: 30_000 });
  if (reply?.type !== "sessionPages" || reply.data.length !== 1 || reply.data[0]?.workspaceId !== workspaceId) throw new Error("目标机器没有返回会话页。");
  const page = reply.data[0];
  if (page.error) throw new Error(page.error);
  return page;
}

/** Used by the Forward target picker; its 500-row budget is explicit. */
export async function readRecentSessions(client: Client, limit = 500): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  let cursor: string | null = null;
  do {
    const page = await readSessionPage(client, null, cursor, Math.min(100, limit - sessions.length));
    sessions.push(...page.sessions);
    if (page.nextCursor === cursor && cursor) throw new Error("会话分页游标未推进。");
    cursor = page.nextCursor;
  } while (cursor && sessions.length < limit);
  return sessions;
}

/** All current work, independent of how much history the reader has opened. */
export async function readActivitySessions(client: Client, workspaceId: string | null = null, signal?: AbortSignal): Promise<SessionSummary[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await readActivityPass(client,workspaceId,signal); }
    catch (error) {
      if (signal?.aborted || attempt >= 2 || !String(error).includes("activity changed")) throw error;
    }
  }
}
async function readActivityPass(client: Client, workspaceId: string | null, signal?: AbortSignal): Promise<SessionSummary[]> {
  const sessions = new Map<string, SessionSummary>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal?.throwIfAborted();
    const page = await readSessionPage(client, workspaceId, cursor, 100, true, true);
    for (const session of page.sessions) sessions.set(session.id, session);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("活动会话游标未推进，状态尚未完整确认。");
    if (cursor) cursors.add(cursor);
    if (sessions.size > 10000) throw new Error("活动会话超过读取预算，状态尚未完整确认。");
  } while (cursor);
  signal?.throwIfAborted();
  return [...sessions.values()];
}
