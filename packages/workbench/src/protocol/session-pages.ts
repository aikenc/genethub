import type { SessionSummary } from "@genehub/proto";
import type { Client } from "./client";

/** Bounded summary reads. Older daemons must upgrade; never fall back to a full scan. */
export async function readSessionPage(client: Client, workspaceId: string | null = null, cursor: string | null = null, limit = 100, includeArchived = false) {
  if (!client.identity?.features?.includes("session.page.v1")) throw new Error("请更新此机器以读取分页会话。");
  const reply = await client.call({ type: "session.page", payload: {
    requests: [{ workspaceId, cursor, limit }], includeArchived,
  } }, { timeoutMs: 10_000 });
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
