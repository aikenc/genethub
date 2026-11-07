import type { SessionSummary } from "@genehub/proto";
import { useMemo } from "react";
import { useWorkbench } from "../session/store";
import { hasCurrentWork, pendingOwners, sessionAttention } from "../session/attention";

type Client = NonNullable<ReturnType<typeof useWorkbench.getState>["client"]>;
type Activity = { count: number; recent: number; pending: number; running: boolean; ownRunning: boolean; teamRunning: boolean; tasks: boolean; blocked: boolean; label: string };
const noSessions: Activity = { count: 0, recent: 0, pending: 0, running: false, ownRunning: false, teamRunning: false, tasks: false, blocked: false, label: "" };
const aggregates = new WeakMap<SessionSummary[], Map<string, Activity>>();

function summarize(sessions: SessionSummary[]) {
  const cached = aggregates.get(sessions);
  if (cached) return cached;
  const agents = new Map<string, Activity>();
  const owners = new Map<string, Map<string, SessionSummary>>();
  for (const session of sessions) {
    if (session.archived && !hasCurrentWork(session, sessions)) continue;
    const activity = agents.get(session.workspaceId) ?? { ...noSessions };
    activity.count++;
    activity.recent = Math.max(activity.recent, session.messagePreview?.atMs ?? session.updatedAtMs);
    const facts = sessionAttention(session, sessions);
    activity.running ||= facts.running;
    activity.ownRunning ||= facts.running && !session.labels?.includes("系统发起");
    activity.teamRunning ||= facts.running && !!session.labels?.includes("系统发起");
    activity.tasks ||= facts.inProgress;
    activity.blocked ||= facts.blocked;
    const pending = owners.get(session.workspaceId) ?? new Map<string, SessionSummary>();
    for (const owner of pendingOwners(session, sessions)) pending.set(owner.id, owner);
    owners.set(session.workspaceId, pending);
    agents.set(session.workspaceId, activity);
  }
  for (const [workspaceId, activity] of agents) {
    activity.pending = [...(owners.get(workspaceId)?.values() ?? [])].reduce((count, owner) => count + (owner.interactionSummary?.count ?? 0), 0);
    activity.label = [activity.pending ? `待你处理 ${activity.pending}` : "", activity.ownRunning && activity.teamRunning ? "会话与小队执行中" : activity.teamRunning ? "小队执行中" : activity.ownRunning ? "Agent 处理中" : activity.blocked ? "有任务受阻" : activity.tasks ? "有任务进行中" : ""].filter(Boolean).join(" · ");
  }
  aggregates.set(sessions, agents);
  return agents;
}

export async function refreshAgentActivities(client: Client) {
  const wb = useWorkbench.getState();
  if (wb.client === client && wb.connection === "ready" && !client.identity?.features?.includes("catalog.sync.v1")) await wb.refreshSessions();
}

export function useAgentActivities() {
  const ready = useWorkbench(s => s.connection === "ready");
  const sessions = useWorkbench(s => s.sessions);
  const loaded = useWorkbench(s => s.sessionsLoaded);
  const error = useWorkbench(s => s.sessionsError);
  const active = useWorkbench(s => s.activitySessions);
  const complete = useWorkbench(s => s.activityComplete);
  const all = useMemo(() => [...new Map([...sessions,...active].map(s => [s.id,s])).values()], [sessions,active]);
  return useMemo(() => ({ sessions: loaded ? all : undefined, agents: complete ? summarize(active) : null, complete, error: error || !ready }), [all, active, complete, loaded, error, ready]);
}

export function useAgentActivity(workspaceId: string) {
  const snapshot = useAgentActivities();
  const partial = !snapshot.complete;
  const activity = snapshot.agents?.get(workspaceId) ?? (!partial && snapshot.agents ? noSessions : undefined);
  return { ...activity, partial, error: snapshot.error };
}
