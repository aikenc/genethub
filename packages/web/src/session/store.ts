import type {
  AgentInfo,
  HubStatus,
  PermissionOutcome,
  SessionSnapshot,
  SessionSummary,
  WorkspaceInfo,
} from "@genehub/proto";
import { create } from "zustand";

import type { Client, ConnectionState } from "../protocol/client";
import { applySequenced, emptyTimeline, fromSnapshot, type TimelineState } from "./timeline";

interface WorkbenchState {
  client: Client | null;
  connection: ConnectionState;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  timeline: TimelineState;
  notice: string | null;
  hub: HubStatus | null;

  attach(client: Client): Promise<void>;
  openWorkspace(root: string): Promise<void>;
  createSession(workspaceId: string, agentId: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  answerPermission(outcome: PermissionOutcome): Promise<void>;
  refreshHub(): Promise<void>;
  pair(hubUrl: string): Promise<void>;
  unpair(): Promise<void>;
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  client: null,
  connection: "connecting",
  agents: [],
  workspaces: [],
  sessions: [],
  activeSessionId: null,
  timeline: emptyTimeline(),
  notice: null,
  hub: null,

  async attach(client) {
    set({ client });
    client.onStateChange((connection) => set({ connection }));
    client.onNotice((_level, message) => set({ notice: message }));
    await refreshCatalog(client, set);
    await get().refreshHub();
  },

  async openWorkspace(root) {
    const client = require_(get().client);
    const reply = await client.call({ type: "workspace.open", payload: { root } });
    if (reply?.type !== "workspace") return;
    set((state) => ({
      workspaces: upsertBy(state.workspaces, reply.data, (w) => w.id),
    }));
    await loadSessions(client, reply.data.id, set);
  },

  async createSession(workspaceId, agentId) {
    const client = require_(get().client);
    const reply = await client.call({
      type: "session.create",
      payload: { workspaceId, agentId, modelId: null, modeId: null, title: null },
    });
    if (reply?.type !== "session") return;
    set((state) => ({ sessions: [reply.data, ...state.sessions] }));
    await get().selectSession(reply.data.id);
  },

  async selectSession(sessionId) {
    const client = require_(get().client);
    const previous = get().activeSessionId;
    if (previous && previous !== sessionId) await client.unsubscribe(previous);

    set({ activeSessionId: sessionId, timeline: emptyTimeline() });

    const { snapshot, replayed } = await client.subscribe(sessionId, {
      onEvent: (event) => {
        // Events for a session the user has already left would rewrite the
        // timeline they are looking at.
        if (get().activeSessionId !== sessionId) return;
        set((state) => ({ timeline: applySequenced(state.timeline, event) }));
      },
      onResync: (resnapshot, events, reset) => {
        if (get().activeSessionId !== sessionId) return;
        const base = reset
          ? fromSnapshot(resnapshot as SessionSnapshot)
          : get().timeline;
        set({ timeline: events.reduce(applySequenced, base) });
      },
    });

    const base = fromSnapshot(snapshot as SessionSnapshot);
    set({ timeline: replayed.reduce(applySequenced, base) });
  },

  async send(text) {
    const client = require_(get().client);
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await client.call({ type: "session.send", payload: { sessionId, text, attachments: [] } });
  },

  async interrupt() {
    const client = require_(get().client);
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await client.call({ type: "session.interrupt", payload: { sessionId } });
  },

  async setModel(modelId) {
    const client = require_(get().client);
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await client.call({ type: "session.setModel", payload: { sessionId, modelId } });
  },

  async setMode(modeId) {
    const client = require_(get().client);
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await client.call({ type: "session.setMode", payload: { sessionId, modeId } });
  },

  async refreshHub() {
    const reply = await require_(get().client).call({ type: "hub.status" });
    if (reply?.type === "hubStatus") set({ hub: reply.data });
  },

  async pair(hubUrl) {
    const reply = await require_(get().client).call({
      type: "hub.pair",
      payload: { hubUrl, displayName: null },
    });
    if (reply?.type === "hubStatus") set({ hub: reply.data });
  },

  async unpair() {
    const reply = await require_(get().client).call({ type: "hub.unpair" });
    if (reply?.type === "hubStatus") set({ hub: reply.data });
  },

  async answerPermission(outcome) {
    const client = require_(get().client);
    const sessionId = get().activeSessionId;
    const request = get().timeline.pendingPermission;
    if (!sessionId || !request) return;
    await client.call({
      type: "session.respondPermission",
      payload: { sessionId, requestId: request.id, outcome },
    });
  },
}));

type Setter = (
  partial:
    | Partial<WorkbenchState>
    | ((state: WorkbenchState) => Partial<WorkbenchState>),
) => void;

async function refreshCatalog(client: Client, set: Setter): Promise<void> {
  const [agents, workspaces] = await Promise.all([
    client.call({ type: "agent.list" }),
    client.call({ type: "workspace.list" }),
  ]);
  if (agents?.type === "agents") set({ agents: agents.data });
  if (workspaces?.type === "workspaces") {
    set({ workspaces: workspaces.data });
    const first = workspaces.data[0];
    if (first) await loadSessions(client, first.id, set);
  }
}

async function loadSessions(client: Client, workspaceId: string, set: Setter): Promise<void> {
  const reply = await client.call({
    type: "session.list",
    payload: { workspaceId, includeArchived: false },
  });
  if (reply?.type === "sessions") set({ sessions: reply.data });
}

function upsertBy<T>(list: T[], item: T, key: (value: T) => string): T[] {
  const index = list.findIndex((existing) => key(existing) === key(item));
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function require_(client: Client | null): Client {
  if (!client) throw new Error("the workbench is not connected yet");
  return client;
}
