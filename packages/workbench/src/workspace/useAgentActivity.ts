import type { SessionSummary } from "@genehub/proto";
import { useEffect, useMemo } from "react";
import { useWorkbench } from "../session/store";
import { hasCurrentWork, pendingOwners, sessionAttention } from "../session/attention";

type Client = NonNullable<ReturnType<typeof useWorkbench.getState>["client"]>;
type Activity = { count: number; recent: number; pending: number; running: boolean; ownRunning: boolean; teamRunning: boolean; tasks: boolean; blocked: boolean; label: string };
const noSessions: Activity = { count: 0, recent: 0, pending: 0, running: false, ownRunning: false, teamRunning: false, tasks: false, blocked: false, label: "" };
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const SLOW_REFRESH_MS = 2_000;
const FAST_REFRESH_MS = 500;
type Poll = { users: number; timer: ReturnType<typeof setTimeout> | null; delay: number; closed: boolean; visibilityChanged(): void };
const polls = new WeakMap<Client, Poll>();
const aggregates = new WeakMap<SessionSummary[], Map<string, Activity>>();

/** The store owns the only summary snapshot. All mounted consumers share one
 * lightweight poll; live events and explicit mutations refresh that same store. */
function subscribe(client: Client) {
  let poll = polls.get(client);
  if (!poll) {
    const state: Poll = {
      users: 0,
      timer: null,
      delay: MIN_POLL_MS,
      closed: false,
      visibilityChanged: () => {},
    };
    const schedule = () => {
      if (state.closed) return;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = setTimeout(() => { void refresh(); }, state.delay);
    };
    const refresh = async () => {
      state.timer = null;
      if (state.closed) return;
      const wb = useWorkbench.getState();
      if (wb.client !== client || wb.connection !== "ready" || document.visibilityState === "hidden") {
        schedule();
        return;
      }
      const began = performance.now();
      try {
        await wb.refreshSessions();
      } finally {
        if (state.closed) return;
        const elapsed = performance.now() - began;
        // A list that already costs seconds must not be re-requested every
        // five seconds: back off until it is cheap again.
        if (elapsed >= SLOW_REFRESH_MS) state.delay = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS * 2, state.delay * 2));
        else if (elapsed <= FAST_REFRESH_MS) state.delay = MIN_POLL_MS;
        schedule();
      }
    };
    state.visibilityChanged = () => {
      if (state.closed || document.visibilityState === "hidden") return;
      state.delay = MIN_POLL_MS;
      if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
      void refresh();
    };
    document.addEventListener("visibilitychange", state.visibilityChanged);
    poll = state;
    polls.set(client, poll);
    void refresh();
  }
  poll.users++;
  return () => {
    if (--poll.users === 0) {
      poll.closed = true;
      if (poll.timer !== null) clearTimeout(poll.timer);
      document.removeEventListener("visibilitychange", poll.visibilityChanged);
      polls.delete(client);
    }
  };
}

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
  if (wb.client === client && wb.connection === "ready") await wb.refreshSessions();
}

export function useAgentActivities() {
  const client = useWorkbench(s => s.client);
  const ready = useWorkbench(s => s.connection === "ready");
  const sessions = useWorkbench(s => s.sessions);
  const loaded = useWorkbench(s => s.sessionsLoaded);
  const error = useWorkbench(s => s.sessionsError);
  useEffect(() => client && ready ? subscribe(client) : undefined, [client, ready]);
  return useMemo(() => ({ sessions: loaded ? sessions : undefined, agents: loaded ? summarize(sessions) : null, error: error || !ready }), [sessions, loaded, error, ready]);
}

export function useAgentActivity(workspaceId: string) {
  const snapshot = useAgentActivities();
  const activity = snapshot.agents?.get(workspaceId) ?? (snapshot.agents ? noSessions : undefined);
  return { ...activity, error: snapshot.error };
}
