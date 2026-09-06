import { useMemo, useSyncExternalStore } from "react";
import { useWorkbench } from "../session/store";

type Client = NonNullable<ReturnType<typeof useWorkbench.getState>["client"]>;
type Activity = { count: number; recent: number; status?: "waiting" | "running" };
type Snapshot = { agents: Map<string, Activity> | null; error: boolean };
const empty: Snapshot = { agents: null, error: false };
const offline: Snapshot = { agents: null, error: true };
const noSessions: Activity = { count: 0, recent: 0 };

/** One summary query per connected client, shared by every visible Agent row.
 * Independent of inbox filters/archives. Never fetches conversation histories. */
function createSource(client: Client) {
  let snapshot = empty;
  let pending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const refresh = async () => {
    if (pending) return;
    pending = true;
    try {
      const reply = await client.call({ type: "session.list", payload: { workspaceId: null, includeArchived: true } });
      if (reply?.type !== "sessions") throw new Error("Missing session summary");
      const agents = new Map<string, Activity>();
      for (const session of reply.data) {
        const activity = agents.get(session.workspaceId) ?? { count: 0, recent: 0 };
        activity.count++;
        activity.recent = Math.max(activity.recent, session.messagePreview?.atMs ?? session.updatedAtMs);
        if (session.status === "waiting") activity.status = "waiting";
        else if (session.status === "running" && activity.status !== "waiting") activity.status = "running";
        agents.set(session.workspaceId, activity);
      }
      snapshot = { agents, error: false };
    } catch {
      snapshot = { agents: null, error: true };
    } finally {
      pending = false;
      listeners.forEach((listener) => listener());
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => void refresh(), 10_000);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) clearInterval(timer);
      };
    },
  };
}
const sources = new WeakMap<Client, ReturnType<typeof createSource>>();
const disconnected = { getSnapshot: () => offline, subscribe: (_listener: () => void) => () => {} };

export function useAgentActivity(workspaceId: string) {
  const client = useWorkbench((s) => s.client);
  const ready = useWorkbench((s) => s.connection === "ready");
  const source = useMemo(() => {
    if (!client || !ready) return disconnected;
    let source = sources.get(client);
    if (!source) { source = createSource(client); sources.set(client, source); }
    return source;
  }, [client, ready]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const activity = snapshot.agents ? snapshot.agents.get(workspaceId) ?? noSessions : undefined;
  return { count: activity?.count, recent: activity?.recent, status: activity?.status, error: snapshot.error };
}
