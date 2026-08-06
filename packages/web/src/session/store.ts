import type {
  AgentInfo,
  Attachment,
  DeviceInfo,
  DeviceInvite,
  FileContent,
  FileNode,
  GitStatus,
  HubClaim,
  HubStatus,
  LogTail,
  RemoteAccess,
  PermissionOutcome,
  BlobRef,
  SequencedEvent,
  SessionSnapshot,
  SessionSummary,
  Settings,
  UpdateDownload,
  UpdateStatus,
  WorkspaceInfo,
} from "@genehub/proto";
import { create } from "zustand";

import type { Host } from "../host";
import type { Client, ConnectionState } from "../protocol/client";
import { canStartAgent } from "../presentation/catalog/resolve";
import { applySequenced, emptyTimeline, fromSnapshot, type TimelineState } from "./timeline";

/**
 * A closable work surface, not a global mode switch.
 *
 * `extra:*` belongs to whoever embedded the workbench; the store carries it
 * around and never looks inside.
 */
export type TabKind =
  | "chat"
  | "files"
  | "terminal"
  | "settings"
  | "devices"
  | "logs"
  | `extra:${string}`;

export interface WorkbenchTab {
  id: string;
  kind: TabKind;
  title: string;
  sessionId?: string;
  /** Used to evict the least recently used inactive tab when the strip is full. */
  lastActivatedAt?: number;
}

export type RightPanel = "changes" | "files" | null;

/**
 * A conversation that has been opened but not started.
 *
 * Nothing exists on the machine while this is all there is: `session.create`
 * waits for the first message. Pressing "new session" used to write a session
 * to disk straight away, so every one that was opened and then abandoned —
 * every mis-tap, every look around — stayed in the list forever as another row
 * called "新会话", indistinguishable from the rest.
 *
 * It carries the choices made before there was anywhere to put them, so picking
 * a model in an empty chat is not silently dropped.
 */
export interface Draft {
  workspaceId: string;
  agentId: string | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
}

/**
 * The agent a new conversation can actually send a first turn through.
 *
 * Prefer our own adapter when it is usable, but do not require every external
 * CLI to publish a model catalog before its first session. OpenCode and ACP
 * Agents may intentionally use their own default and discover choices only
 * after startup; Genet still needs a provider-backed catalog. A ready Agent
 * with a concrete catalog remains the least surprising default when both kinds
 * are installed, while the catalog-less Agent stays selectable and usable.
 */
export function defaultAgent(agents: AgentInfo[]): AgentInfo | undefined {
  const usable = agents.filter(canStartAgent);
  const catalogued = usable.filter((agent) => agent.catalog.models.length > 0);
  return (
    catalogued.find((agent) => agent.builtin) ??
    catalogued[0] ??
    usable.find((agent) => agent.builtin) ??
    usable[0]
  );
}

/** The tab an unstarted conversation lives in. There is only ever one. */
const DRAFT_TAB = "chat:draft";

interface WorkbenchState {
  client: Client | null;
  connection: ConnectionState;
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** Set while an unstarted conversation is on screen. See `Draft`. */
  draft: Draft | null;
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  rightPanel: RightPanel;
  timeline: TimelineState;
  /**
   * Warm snapshots for every chat tab still in the strip. Switching back to a
   * warm tab must not throw its rendered history away and ask the daemon to
   * replay it again.
   */
  sessionTimelines: Record<string, TimelineState>;
  /** Sessions whose live event stream we intentionally keep while their tab is open. */
  subscribedSessionIds: string[];
  /** Six tabs fit a phone; a desktop can keep sixteen useful work surfaces. */
  tabLimit: number;
  notice: string | null;
  hub: HubStatus | null;
  /**
   * The last way into this machine's identity the Hub handed out.
   *
   * Kept here rather than in the component that asked for it: the tray can ask
   * too, and both have to end up on the same screen. Never fetched on mount —
   * a recovery key comes back once, so it exists only where it was minted.
   */
  claim: HubClaim | null;
  /** Who this machine lets in from outside. Owned by the daemon, not by us. */
  devices: DeviceInfo[];
  remote: RemoteAccess | null;
  tree: FileNode | null;
  file: FileContent | null;
  git: GitStatus | null;
  diff: string | null;
  settings: Settings | null;
  /** The log being read, if the log tab has been opened. */
  log: LogTail | null;
  /**
   * The answer to the last update check, or null because nobody has asked.
   *
   * Never fetched on mount, and never on a timer: this is the one piece of state
   * here that only exists because a person pressed something (`UpdateStatus`).
   * It lives in the store rather than in the About section because the tray can
   * ask too, and both have to end up on the same screen.
   */
  update: UpdateStatus | null;
  /** The desktop shell's answer, independent of the selected machine. */
  appUpdate: UpdateStatus | null;
  /** A check is in flight. Shared, for the same reason `update` is. */
  updating: boolean;
  appUpdating: boolean;
  /**
   * How far the machine has got fetching the installer.
   *
   * Owned by the machine, not by us: this is the one piece of state here that
   * keeps moving after the panel that started it is closed, and two windows
   * watching the same download have to agree. What arrives is either the answer
   * to `update.downloadState` or a push, and both write the same field.
   */
  download: UpdateDownload;

  attach(client: Client): Promise<void>;
  /** Refreshes daemon-owned session status for the sidebar. */
  refreshSessions(): Promise<void>;
  openWorkspace(root: string): Promise<void>;
  selectWorkspace(workspaceId: string): Promise<void>;
  /** Changes a workspace's display name without moving its directory. */
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  loadTree(path?: string): Promise<void>;
  openFile(path: string): Promise<void>;
  saveFile(content: string): Promise<void>;
  refreshGit(): Promise<void>;
  loadDiff(path?: string): Promise<void>;
  commit(message: string, paths?: string[]): Promise<void>;
  loadSettings(): Promise<void>;
  /**
   * Fetches the end of a log file.
   *
   * Over the connection rather than off the disk, because the browser asking may
   * be on a phone: a path under the machine's data directory is not something it
   * can open.
   */
  loadLog(name?: string): Promise<void>;
  /** Asks the machine whether a newer build has been published. */
  checkUpdate(): Promise<void>;
  /** Checks both the selected daemon and, when present, this desktop App. */
  checkUpdates(host: Host): Promise<void>;
  /**
   * Asks the machine to fetch the installer. Returns once it has started, not
   * once it has finished: what happens after that arrives as pushes.
   */
  downloadUpdate(): Promise<void>;
  /** Stops the prompt asking, without throwing the downloaded file away. */
  dismissUpdate(): Promise<void>;
  setProvider(input: {
    providerId: string;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
    dialect?: string;
    /** Written by hand, for an endpoint that cannot list its own models. */
    models?: string[];
  }): Promise<void>;
  /** Removes a provider the user added. */
  forgetProvider(providerId: string): Promise<void>;
  /**
   * Opens an empty conversation. Writes nothing until the first message.
   *
   * Both arguments default to what is already on screen, so the "+" in the
   * header needs to know nothing about projects or agents.
   */
  newSession(workspaceId?: string | null, agentId?: string | null): void;
  selectSession(sessionId: string): Promise<void>;
  loadRound(roundId: string): Promise<void>;
  loadOlderTrunks(roundId: string): Promise<void>;
  loadTrunk(roundId: string, trunkIndex: number): Promise<void>;
  loadBlob(blob: BlobRef): Promise<void>;
  /** Gives a session the name the user typed, on the machine and here. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Erases a session. There is no undo; the caller does the asking. */
  deleteSession(sessionId: string): Promise<void>;
  openTab(kind: TabKind, title?: string): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  setTabLimit(limit: number): void;
  setRightPanel(panel: RightPanel): void;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  /** Creates an independent Agent context through one completed turn. */
  forkSession(turnId: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setEffort(effortId: string): Promise<void>;
  answerPermission(outcome: PermissionOutcome): Promise<void>;
  refreshHub(): Promise<void>;
  pair(hubUrl: string): Promise<void>;
  /** Pairs with an identity the Hub makes up on the spot, nobody to approve it. */
  trial(hubUrl: string): Promise<HubClaim | null>;
  /** A fresh link into this machine's identity, to open on another device. */
  claimLink(): Promise<HubClaim | null>;
  unpair(): Promise<void>;
  refreshDevices(): Promise<void>;
  invite(): Promise<DeviceInvite | null>;
  revokeDevice(deviceId: string): Promise<void>;
  attachRelay(relayUrl: string, joinToken: string): Promise<void>;
  detachRelay(): Promise<void>;
}

/**
 * One session's view, whether it is on screen or warm in a background tab.
 *
 * Round and blob state lives inside `TimelineState` rather than beside it, so
 * a warm tab keeps its expanded rounds along with its messages. Held apart,
 * switching back to a warm tab would show the previous session's rounds until
 * a refresh that a warm tab deliberately never makes.
 */
function timelineOf(state: WorkbenchState, sessionId: string): TimelineState {
  return state.sessionTimelines[sessionId] ?? emptyTimeline();
}

function patchTimeline(
  sessionId: string,
  set: (updater: (state: WorkbenchState) => Partial<WorkbenchState>) => void,
  patch: (timeline: TimelineState) => Partial<TimelineState>,
): void {
  set((state) => {
    const current = timelineOf(state, sessionId);
    const timeline = { ...current, ...patch(current) };
    return {
      sessionTimelines: { ...state.sessionTimelines, [sessionId]: timeline },
      ...(state.activeSessionId === sessionId ? { timeline } : {}),
    };
  });
}

/**
 * Whether an event can have changed how the daemon grouped work into trunks.
 *
 * That grouping is the daemon's alone, so it cannot be derived from the event.
 * But most events cannot have moved it, and asking after every one would put a
 * request behind every token.
 */
function changesTheRoundLayer(event: SequencedEvent): boolean {
  switch (event.event.type) {
    case "turnCompleted":
    case "turnFailed":
    case "turnCanceled":
      return true;
    case "item":
      return (
        event.event.item.type === "userMessage" ||
        event.event.item.type === "assistantMessage" ||
        event.event.item.type === "reasoning" ||
        event.event.item.type === "toolCall"
      );
    default:
      return false;
  }
}

function shouldExpandLastRound(summary: SessionSummary | undefined): boolean {
  if (!summary || summary.status === "running" || summary.status === "waiting") return true;
  try {
    const readAt = Number(localStorage.getItem(`genehub:session-read:${summary.id}`) ?? "0");
    return !Number.isFinite(readAt) || readAt < summary.updatedAtMs;
  } catch {
    return true;
  }
}

function markSessionRead(summary: SessionSummary): void {
  try {
    localStorage.setItem(`genehub:session-read:${summary.id}`, String(summary.updatedAtMs));
  } catch {
    // Storage can be disabled; the safe fallback is to prefetch next time.
  }
}

let roundRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRoundRefresh(get: () => WorkbenchState): void {
  if (roundRefreshTimer) clearTimeout(roundRefreshTimer);
  roundRefreshTimer = setTimeout(() => {
    roundRefreshTimer = null;
    void get()
      .loadRound("latest")
      .then(() => {
        const round = Object.values(get().timeline.roundLayers)
          .reverse()
          .find((layer) => layer.round.outcome === "running")?.round;
        if (!round) return;
        const trunks = get().timeline.roundLayers[round.roundId]?.trunks;
        const last = trunks?.at(-1);
        if (last) return get().loadTrunk(round.roundId, last.index);
      });
  }, 250);
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  client: null,
  connection: "connecting",
  agents: [],
  workspaces: [],
  activeWorkspaceId: null,
  sessions: [],
  activeSessionId: null,
  draft: null,
  tabs: [],
  activeTabId: null,
  rightPanel: null,
  timeline: emptyTimeline(),
  sessionTimelines: {},
  subscribedSessionIds: [],
  tabLimit: 16,
  notice: null,
  hub: null,
  claim: null,
  devices: [],
  remote: null,
  tree: null,
  file: null,
  git: null,
  diff: null,
  settings: null,
  log: null,
  update: null,
  appUpdate: null,
  updating: false,
  appUpdating: false,
  download: { state: "idle" },

  async attach(client) {
    set({ client, notice: null });
    client.onStateChange((connection) => {
      set({ connection });
      // A connection that was refused knows why — wrong credential, revoked
      // device, protocol mismatch — and none of those are fixed by waiting. Say
      // it, instead of leaving a spinner and a guess about ports.
      if (connection === "closed" && client.failure) set({ notice: client.failure.message });
      // A reconnect on its own is routine and worth no words. One the far side
      // explained is not: that sentence is the only account anyone will ever
      // get of why the work in flight was lost.
      if (connection === "reconnecting") {
        const closed = client.lastCloseReason;
        if (closed?.reason) {
          set({ notice: `连接被断开（${closed.code ?? "?"} ${closed.reason}），正在重连` });
        }
      }
    });
    client.onNotice((_level, message) => set({ notice: message }));
    client.onUpdateDownload((download) => set({ download }));
    try {
      await refreshCatalog(client, set);
      if (get().client === client) await land(get);
      await get().refreshHub();
      // Asked on connect, unlike the update check itself. A download that was
      // running when the window closed is still running, and the prompt to
      // install it has to come back with the window rather than wait for
      // someone to go looking in settings for a file they already have.
      const download = await client.call({ type: "update.downloadState" });
      if (download?.type === "updateDownload") set({ download: download.data });
    } catch (error) {
      // A connection can disappear halfway through being asked things: the tab
      // is closing, or the daemon restarted and the shell has already pointed
      // us at its replacement. Neither is worth reporting — but an error on the
      // connection we are still using is, and it used to go nowhere at all.
      if (get().client !== client) return;
      set({ notice: error instanceof Error ? error.message : String(error) });
    }
  },

  async refreshSessions() {
    const client = get().client;
    if (!client) return;
    await loadSessions(client, set).catch(unattended(client, get, set));
  },

  async openWorkspace(root) {
    const client = require_(get().client);
    const reply = await client.call({ type: "workspace.open", payload: { root } });
    if (reply?.type !== "workspace") return;
    set((state) => ({
      workspaces: upsertBy(state.workspaces, reply.data, (w) => w.id),
      activeWorkspaceId: reply.data.id,
      activeSessionId: null,
      timeline: emptyTimeline(),
    }));
    await loadSessions(client, set);
    await land(get);
  },

  async selectWorkspace(workspaceId) {
    // No refetch: the list already holds every workspace's sessions, so
    // switching projects is a change of which ones are on screen, not a
    // question for the daemon.
    require_(get().client);
    set({ activeWorkspaceId: workspaceId, activeSessionId: null, timeline: emptyTimeline() });
    await land(get);
  },

  async renameWorkspace(workspaceId, name) {
    const wanted = name.trim();
    if (!wanted) return;
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "workspace.rename",
        payload: { workspaceId, name: wanted },
      }),
    );
    if (reply?.type !== "workspace") return;
    set((state) => ({
      workspaces: upsertBy(state.workspaces, reply.data, (workspace) => workspace.id),
    }));
  },

  newSession(workspaceId, agentId) {
    const state = get();
    const target = workspaceId ?? currentWorkspace(state);
    if (!target) return;
    const opened = state.tabs.some((tab) => tab.id === DRAFT_TAB)
      ? state.tabs
      : [
          ...state.tabs,
          {
            id: DRAFT_TAB,
            kind: "chat" as const,
            title: "新会话",
            lastActivatedAt: Date.now(),
          },
        ];
    const limited = limitTabs(opened, DRAFT_TAB, state.tabLimit, state.sessions);
    const evictedSessionIds = tabSessionIds(limited.evicted);
    set({
      draft: {
        workspaceId: target,
        // Whatever is already in front of the user, unless the caller named
        // one. "New chat" while talking to Claude Code means another one with
        // Claude Code — being dropped back onto the built-in agent is a
        // surprise, and one that only shows up at the first reply.
        agentId:
          agentId ??
          state.draft?.agentId ??
          state.sessions.find((entry) => entry.id === state.activeSessionId)?.agentId ??
          null,
        modelId: null,
        modeId: null,
        effortId: null,
      },
      activeWorkspaceId: target,
      activeSessionId: null,
      timeline: emptyTimeline(),
      tabs: limited.tabs,
      sessionTimelines: omitMany(state.sessionTimelines, evictedSessionIds),
      subscribedSessionIds: state.subscribedSessionIds.filter(
        (id) => !evictedSessionIds.includes(id),
      ),
      activeTabId: DRAFT_TAB,
    });
    discardSubscriptions(state.client, limited.evicted);
  },

  async selectSession(sessionId) {
    const client = require_(get().client);
    const summary = get().sessions.find((entry) => entry.id === sessionId);
    const tabId = `chat:${sessionId}`;
    let evicted: WorkbenchTab[] = [];
    let warm = false;
    set((state) => {
      // The unstarted conversation gives way to a real one, whether because it
      // just became this session or because the user went elsewhere. Keeping
      // its tab would leave a second "新会话" strip that opens onto nothing.
      const kept = state.tabs.filter((tab) => tab.id !== DRAFT_TAB);
      const existing = kept.find((tab) => tab.id === tabId);
      const opened = existing
        ? kept.map((tab) =>
            tab.id === tabId
              ? { ...tab, title: summary?.title ?? tab.title, lastActivatedAt: Date.now() }
              : tab,
          )
        : [
            ...kept,
            {
              id: tabId,
              kind: "chat" as const,
              title: summary?.title ?? "新会话",
              sessionId,
              lastActivatedAt: Date.now(),
            },
          ];
      const limited = limitTabs(opened, tabId, state.tabLimit, state.sessions);
      evicted = limited.evicted;
      warm = state.subscribedSessionIds.includes(sessionId);
      return {
        activeSessionId: sessionId,
        draft: null,
        // The project follows the conversation. Every workspace's sessions are
        // in the list at once now, so the one just clicked may belong to a
        // different project than the one on screen — and the file tree, the
        // terminal and the diff all read `activeWorkspaceId`. Without this they
        // would go on showing the project the user just navigated away from.
        activeWorkspaceId: summary?.workspaceId ?? state.activeWorkspaceId,
        timeline: state.sessionTimelines[sessionId] ?? emptyTimeline(),
        tabs: limited.tabs,
        sessionTimelines: omitMany(state.sessionTimelines, tabSessionIds(limited.evicted)),
        subscribedSessionIds: state.subscribedSessionIds.filter(
          (id) => !tabSessionIds(limited.evicted).includes(id),
        ),
        activeTabId: tabId,
      };
    });

    discardSubscriptions(client, evicted);
    // A tab stays warm until it is explicitly closed or LRU-evicted. Its
    // current snapshot and event subscription are already live, so selecting
    // it is a synchronous state change rather than a network round trip.
    if (warm) return;

    const { snapshot, replayed } = await client.subscribe(
      sessionId,
      {
        onEvent: (event) => {
        if (event.event.type === "titleChanged") {
          applyTitle(sessionId, event.event.title, set);
        }
        applySessionStatus(sessionId, event.event, set);
        set((state) => {
          const timeline = applySequenced(
            state.sessionTimelines[sessionId] ?? emptyTimeline(),
            event,
          );
          return {
            sessionTimelines: { ...state.sessionTimelines, [sessionId]: timeline },
            ...(state.activeSessionId === sessionId ? { timeline } : {}),
          };
        });
          // The round layer is not derivable from the event stream: only the
          // daemon knows how work was grouped into trunks. Refresh it for the
          // session on screen, which is the only one rendering rounds.
          if (get().activeSessionId === sessionId && changesTheRoundLayer(event)) {
            scheduleRoundRefresh(get);
          }
        },
        onResync: (resnapshot, events, reset) => {
        const base = reset
          ? fromSnapshot(resnapshot as SessionSnapshot)
          : get().sessionTimelines[sessionId] ?? emptyTimeline();
        for (const event of events) {
          if (event.event.type === "titleChanged") applyTitle(sessionId, event.event.title, set);
          applySessionStatus(sessionId, event.event, set);
        }
        const timeline = events.reduce(applySequenced, base);
        set((state) => ({
          sessionTimelines: { ...state.sessionTimelines, [sessionId]: timeline },
          ...(state.activeSessionId === sessionId ? { timeline } : {}),
        }));
        },
      },
      { expandLastRound: shouldExpandLastRound(summary) },
    );

    const typedSnapshot = snapshot as SessionSnapshot;
    const base = fromSnapshot(typedSnapshot);
    // A slower subscription must not repaint whichever session the user opened
    // next. This is easy to hit when switching pages over a relay: both replies
    // are valid, but only the currently selected session owns the timeline.
    markSessionRead(typedSnapshot.summary);
    const timeline = replayed.reduce(applySequenced, base);
    set((state) => ({
      subscribedSessionIds: state.subscribedSessionIds.includes(sessionId)
        ? state.subscribedSessionIds
        : [...state.subscribedSessionIds, sessionId],
      sessionTimelines: { ...state.sessionTimelines, [sessionId]: timeline },
      ...(state.activeSessionId === sessionId ? { timeline } : {}),
    }));
  },

  async loadRound(roundId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const reply = await require_(get().client).call({
      type: "round.trunk.list",
      payload: { sessionId, roundId, cursor: null, limit: 20 },
    });
    if (reply?.type !== "roundLayer") return;
    const layer = reply.data;
    patchTimeline(sessionId, set, (timeline) => ({
      rounds: [
        ...timeline.rounds.filter((round) => round.roundId !== layer.round.roundId),
        layer.round,
      ],
      roundLayers: { ...timeline.roundLayers, [layer.round.roundId]: layer },
    }));
  },

  async loadOlderTrunks(roundId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const cursor = timelineOf(get(), sessionId).roundLayers[roundId]?.nextCursor;
    if (!cursor) return;
    const reply = await require_(get().client).call({
      type: "round.trunk.list",
      payload: { sessionId, roundId, cursor, limit: 20 },
    });
    if (reply?.type !== "roundLayer") return;
    const older = reply.data;
    patchTimeline(sessionId, set, (timeline) => {
      const existing = timeline.roundLayers[roundId];
      if (!existing) return {};
      return {
        roundLayers: {
          ...timeline.roundLayers,
          [roundId]: {
            ...existing,
            trunks: [...older.trunks, ...existing.trunks],
            nextCursor: older.nextCursor,
          },
        },
      };
    });
  },

  async loadTrunk(roundId, trunkIndex) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const reply = await require_(get().client).call({
      type: "round.trunk.get",
      payload: { sessionId, roundId, trunkIndex },
    });
    if (reply?.type !== "roundTrunk") return;
    const trunk = reply.data;
    patchTimeline(sessionId, set, (timeline) => ({
      roundTrunks: { ...timeline.roundTrunks, [`${roundId}:${trunkIndex}`]: trunk },
    }));
  },

  async loadBlob(blob) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if (timelineOf(get(), sessionId).blobs[blob.id]) return;
    // The whole reference goes back, not just the id: the locator inside it is
    // what lets the daemon seek straight to the payload.
    const reply = await require_(get().client).call({
      type: "blob.get",
      payload: { sessionId, blob },
    });
    if (reply?.type !== "blob") return;
    const payload = reply.data;
    patchTimeline(sessionId, set, (timeline) => ({
      blobs: { ...timeline.blobs, [blob.id]: payload },
    }));
  },

  openTab(kind, title) {
    const id = kind === "chat" ? `chat:${get().activeSessionId ?? "draft"}` : kind;
    const defaults: Record<string, string> = {
      chat: "新会话",
      files: "文件",
      terminal: "终端",
      settings: "设置",
      devices: "设备",
      logs: "日志",
    };
    set((state) => {
      if (state.tabs.some((tab) => tab.id === id)) {
        return {
          activeTabId: id,
          tabs: state.tabs.map((tab) =>
            tab.id === id ? { ...tab, lastActivatedAt: Date.now() } : tab,
          ),
        };
      }
      const limited = limitTabs(
        [
          ...state.tabs,
          { id, kind, title: title ?? defaults[kind] ?? kind, lastActivatedAt: Date.now() },
        ],
        id,
        state.tabLimit,
        state.sessions,
      );
      discardSubscriptions(state.client, limited.evicted);
      return {
        tabs: limited.tabs,
        sessionTimelines: omitMany(state.sessionTimelines, tabSessionIds(limited.evicted)),
        subscribedSessionIds: state.subscribedSessionIds.filter(
          (sessionId) => !tabSessionIds(limited.evicted).includes(sessionId),
        ),
        activeTabId: id,
      };
    });
  },

  activateTab(tabId) {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    set((state) => ({
      activeTabId: tabId,
      tabs: state.tabs.map((entry) =>
        entry.id === tabId ? { ...entry, lastActivatedAt: Date.now() } : entry,
      ),
    }));
    if (tab.kind === "chat" && tab.sessionId && tab.sessionId !== get().activeSessionId) {
      void get().selectSession(tab.sessionId);
    }
  },

  closeTab(tabId) {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const next = tabs.filter((tab) => tab.id !== tabId);
    const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? null;
    set({
      tabs: next,
      sessionTimelines: omitMany(get().sessionTimelines, tabSessionIds([tabs[index]!])),
      subscribedSessionIds: get().subscribedSessionIds.filter(
        (sessionId) => !tabSessionIds([tabs[index]!]).includes(sessionId),
      ),
      activeTabId: activeTabId === tabId ? (fallback?.id ?? null) : activeTabId,
    });
    discardSubscriptions(get().client, [tabs[index]!]);
    if (fallback?.kind === "chat" && fallback.sessionId) {
      void get().selectSession(fallback.sessionId);
    }
  },

  setTabLimit(limit) {
    const bounded = Math.max(1, Math.floor(limit));
    let evicted: WorkbenchTab[] = [];
    set((state) => {
      const limited = limitTabs(state.tabs, state.activeTabId, bounded, state.sessions);
      evicted = limited.evicted;
      return {
        tabLimit: bounded,
        tabs: limited.tabs,
        sessionTimelines: omitMany(state.sessionTimelines, tabSessionIds(limited.evicted)),
        subscribedSessionIds: state.subscribedSessionIds.filter(
          (sessionId) => !tabSessionIds(limited.evicted).includes(sessionId),
        ),
      };
    });
    discardSubscriptions(get().client, evicted);
  },

  setRightPanel(panel) {
    set({ rightPanel: panel });
  },

  async send(text, attachments = []) {
    // The previous complaint goes away as the next attempt starts, so a stale
    // line does not get read as a description of what just happened.
    set({ notice: null });
    // This is where a draft becomes a conversation: the machine hears about it
    // at the first message, not when the button was pressed.
    const sessionId = await start(get, set);
    if (!sessionId) return;
    await asked(set, () =>
      require_(get().client).call({
        type: "session.send",
        // Continuing a round after an interrupt is not wired into the UI
        // yet — every message from here is a fresh round until it is
        // (docs/agent-analysis-substrate-proposal.md §3.2).
        payload: { sessionId, text, attachments, continuesRound: null },
      }),
    );
  },

  async forkSession(turnId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "session.fork",
        payload: { sessionId, turnId },
      }),
    );
    if (reply?.type !== "session") return;
    set((state) => ({ sessions: [reply.data, ...state.sessions] }));
    await get().selectSession(reply.data.id);
  },

  async interrupt() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await asked(set, () =>
      require_(get().client).call({ type: "session.interrupt", payload: { sessionId } }),
    );
  },

  // Each of these has two homes. With a session, the machine is told now; with
  // only a draft there is nothing to tell yet, so the choice is held and
  // applied at `session.create`. Dropping it — which is what happened before —
  // meant picking a model in a new chat did nothing at all.
  async setModel(modelId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { modelId });
    await asked(set, () =>
      require_(get().client).call({ type: "session.setModel", payload: { sessionId, modelId } }),
    );
  },

  async setMode(modeId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { modeId });
    await asked(set, () =>
      require_(get().client).call({ type: "session.setMode", payload: { sessionId, modeId } }),
    );
  },

  async setEffort(effortId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { effortId });
    await asked(set, () =>
      require_(get().client).call({ type: "session.setEffort", payload: { sessionId, effortId } }),
    );
  },

  async renameSession(sessionId, title) {
    const wanted = title.trim();
    if (!wanted) return;
    const reply = await asked(set, () =>
      require_(get().client).call({ type: "session.rename", payload: { sessionId, title: wanted } }),
    );
    if (reply?.type !== "session") return;
    // From the reply rather than from what was typed: the daemon trims and
    // caps, and the sidebar should show the name that was actually stored.
    applyTitle(sessionId, reply.data.title ?? wanted, set);
  },

  async deleteSession(sessionId) {
    await asked(set, () =>
      require_(get().client).call({ type: "session.delete", payload: { sessionId } }),
    );
    const wasOpen = get().activeSessionId === sessionId;
    const tabId = `chat:${sessionId}`;
    set((state) => ({
      sessions: state.sessions.filter((entry) => entry.id !== sessionId),
      tabs: state.tabs.filter((tab) => tab.id !== tabId),
      sessionTimelines: omit(state.sessionTimelines, sessionId),
      subscribedSessionIds: state.subscribedSessionIds.filter((id) => id !== sessionId),
      activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
      ...(wasOpen ? { activeSessionId: null, timeline: emptyTimeline() } : {}),
    }));
    void get().client?.unsubscribe(sessionId);
    // Deleting what you were reading leaves a blank pane otherwise. `land`
    // picks the next conversation, or opens an empty one.
    if (wasOpen) await land(get);
  },

  /**
   * Loads a directory's children. Passing no path loads the root.
   *
   * The reply is a subtree, and it is grafted onto the tree already on screen
   * rather than replacing it — otherwise expanding a folder would collapse
   * every other folder the user had opened.
   */
  async loadTree(path) {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    if (!workspaceId) return;
    const reply = await client
      .call({ type: "file.tree", payload: { workspaceId, path: path ?? null, depth: 1 } })
      .catch(unattended(client, get, set));
    if (reply?.type !== "fileTree") return;
    set((state) => ({
      tree: path && state.tree ? graft(state.tree, path, reply.data) : reply.data,
    }));
  },

  async openFile(path) {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    if (!workspaceId) return;
    const reply = await client.call({ type: "file.read", payload: { workspaceId, path } });
    if (reply?.type === "fileContent") set({ file: reply.data });
  },

  async saveFile(content) {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    const open = get().file;
    if (!workspaceId || !open) return;
    await client.call({ type: "file.write", payload: { workspaceId, path: open.path, content } });
    set({ file: { ...open, content } });
    // Saving is the most common way the change list stops being accurate.
    await get().refreshGit();
  },

  async refreshGit() {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    if (!workspaceId) return;
    const reply = await client
      .call({ type: "git.status", payload: { workspaceId } })
      .catch(unattended(client, get, set));
    if (reply?.type === "gitStatus") set({ git: reply.data });
  },

  async loadDiff(path) {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    if (!workspaceId) return;
    const reply = await client.call({
      type: "git.diff",
      payload: { workspaceId, path: path ?? null },
    });
    if (reply?.type === "gitDiff") set({ diff: reply.data.diff });
  },

  async commit(message, paths = []) {
    const client = require_(get().client);
    const workspaceId = currentWorkspace(get());
    if (!workspaceId) return;
    await client.call({ type: "git.commit", payload: { workspaceId, message, paths } });
    set({ diff: null });
    await get().refreshGit();
  },

  async loadSettings() {
    const client = require_(get().client);
    const reply = await client
      .call({ type: "settings.get" })
      .catch(unattended(client, get, set));
    if (reply?.type === "settings") set({ settings: reply.data });
  },

  async loadLog(name) {
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "log.tail",
        payload: { name: name ?? null },
      }),
    );
    if (reply?.type === "log") set({ log: reply.data });
  },

  async checkUpdate() {
    // The previous answer goes away as the next check starts, so a stale "已是
    // 最新" cannot be read as the result of the press that just happened.
    set({ notice: null, update: null, updating: true });
    try {
      const reply = await asked(set, () =>
        require_(get().client).call({ type: "update.check" }),
      );
      if (reply?.type === "update") set({ update: reply.data });
    } finally {
      set({ updating: false });
    }
  },

  async checkUpdates(host) {
    set({ appUpdate: null, appUpdating: Boolean(host.checkAppUpdate) });
    await Promise.all([
      get().checkUpdate(),
      host.checkAppUpdate
        ? host
            .checkAppUpdate()
            .then((appUpdate) => set({ appUpdate }))
            .finally(() => set({ appUpdating: false }))
        : Promise.resolve(),
    ]);
  },

  async downloadUpdate() {
    const reply = await asked(set, () =>
      require_(get().client).call({ type: "update.download" }),
    );
    if (reply?.type === "updateDownload") set({ download: reply.data });
  },

  async dismissUpdate() {
    // Set here as well as from the reply, so the prompt goes away on the click
    // rather than after a round trip. The machine's answer overwrites it a
    // moment later and they agree, except when the download is still running —
    // and then the machine is right and this was never dismissed.
    set({ download: { state: "idle" } });
    const reply = await asked(set, () =>
      require_(get().client).call({ type: "update.dismiss" }),
    );
    if (reply?.type === "updateDownload") set({ download: reply.data });
  },

  async setProvider({ providerId, apiKey, baseUrl, label, dialect, models }) {
    set({ notice: null });
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "settings.setProvider",
        payload: {
          providerId,
          apiKey: apiKey ?? null,
          baseUrl: baseUrl ?? null,
          label: label ?? null,
          dialect: dialect ?? null,
          models: models ?? null,
        },
      }),
    );
    if (reply?.type === "settings") set({ settings: reply.data });
    // A key that just landed can change which agents are usable, and it is what
    // fills the model picker.
    const agents = await require_(get().client).call({ type: "agent.refresh" });
    if (agents?.type === "agents") set({ agents: agents.data });
  },

  async forgetProvider(providerId) {
    set({ notice: null });
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "settings.forgetProvider",
        payload: { providerId },
      }),
    );
    if (reply?.type === "settings") set({ settings: reply.data });
    const agents = await require_(get().client).call({ type: "agent.refresh" });
    if (agents?.type === "agents") set({ agents: agents.data });
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

  async trial(hubUrl) {
    const reply = await require_(get().client).call({
      type: "hub.trial",
      payload: { hubUrl, displayName: null },
    });
    if (reply?.type !== "hubClaim") return null;
    set({ hub: reply.data.status, claim: reply.data.claim });
    return reply.data.claim;
  },

  async claimLink() {
    const reply = await require_(get().client).call({ type: "hub.claimLink" });
    if (reply?.type !== "hubClaim") return null;
    set({ hub: reply.data.status, claim: reply.data.claim });
    return reply.data.claim;
  },

  async unpair() {
    const reply = await require_(get().client).call({ type: "hub.unpair" });
    if (reply?.type === "hubStatus") set({ hub: reply.data });
  },

  async refreshDevices() {
    const reply = await require_(get().client).call({ type: "device.list" });
    if (reply?.type === "devices") set({ devices: reply.data.devices, remote: reply.data.remote });
  },

  async invite() {
    const reply = await require_(get().client).call({ type: "device.invite" });
    return reply?.type === "invite" ? reply.data : null;
  },

  async revokeDevice(deviceId) {
    const reply = await require_(get().client).call({
      type: "device.revoke",
      payload: { deviceId },
    });
    if (reply?.type === "devices") set({ devices: reply.data.devices, remote: reply.data.remote });
  },

  async attachRelay(relayUrl, joinToken) {
    const reply = await require_(get().client).call({
      type: "device.remoteAttach",
      payload: { relayUrl, joinToken: joinToken || null },
    });
    if (reply?.type === "remoteAccess") set({ remote: reply.data });
  },

  async detachRelay() {
    const reply = await require_(get().client).call({ type: "device.remoteDetach" });
    if (reply?.type === "remoteAccess") set({ remote: reply.data });
  },

  async answerPermission(outcome) {
    const sessionId = get().activeSessionId;
    const request = get().timeline.pendingPermission;
    if (!sessionId || !request) return;
    await asked(set, () =>
      require_(get().client).call({
        type: "session.respondPermission",
        payload: { sessionId, requestId: request.id, outcome },
      }),
    );
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
    if (!first) return;
    const sessions = await loadSessions(client, set);
    // Which project to open on. The newest conversation anywhere, rather than
    // whichever workspace the daemon listed first: "coming back means
    // continuing the last thing" is the whole point of landing somewhere, and
    // the last thing is rarely in the first project alphabetically. Checked
    // against the list, because a session can outlive the workspace's entry.
    const last = newest(sessions);
    const known = workspaces.data.some((entry) => entry.id === last?.workspaceId);
    set({ activeWorkspaceId: known && last ? last.workspaceId : first.id });
  }
}

/**
 * Puts the user in a conversation instead of in front of a button.
 *
 * Coming back nearly always means continuing the last thing, and a machine
 * that has never been used should still be able to take a first message. The
 * one case that still gets a splash screen is the one nothing here can act
 * on: no model to run the turn with, which is a key the user has to go and
 * paste in.
 */
async function land(get: () => WorkbenchState): Promise<void> {
  const state = get();
  if (state.activeSessionId) return;
  const workspaceId = state.activeWorkspaceId;
  if (!workspaceId) return;

  const latest = newest(
    state.sessions.filter((session) => session.workspaceId === workspaceId),
  );
  if (latest) {
    await get().selectSession(latest.id);
    return;
  }

  const agent = defaultAgent(state.agents);
  if (!agent) return;
  // An empty conversation, not a stored one. Landing somewhere used to write a
  // session on every first visit to a project, whether or not anything was ever
  // said in it.
  get().newSession(workspaceId, agent.id);
}

/**
 * The session to send into, creating it from the draft if there is not one yet.
 *
 * Returns null when there is nothing to send into and no way to make one, which
 * is a caller that should quietly do nothing: `asked` has already said why if a
 * request was made and refused.
 */
async function start(
  get: () => WorkbenchState,
  set: Setter,
): Promise<string | null> {
  const state = get();
  if (state.activeSessionId) return state.activeSessionId;
  const draft = state.draft;
  if (!draft) return null;

  const agentId =
    draft.agentId ??
    defaultAgent(state.agents)?.id ??
    null;
  if (!agentId) return null;

  const reply = await asked(set, () =>
    require_(get().client).call({
      type: "session.create",
      payload: {
        workspaceId: draft.workspaceId,
        agentId,
        modelId: draft.modelId,
        modeId: draft.modeId,
        title: null,
      },
    }),
  );
  if (reply?.type !== "session") return null;

  set((current) => ({ sessions: [reply.data, ...current.sessions] }));
  // Clears the draft and turns its tab into this session's.
  await get().selectSession(reply.data.id);
  // `session.create` has no field for it, so the one choice that cannot ride
  // along is made immediately afterwards instead of being lost.
  if (draft.effortId) await get().setEffort(draft.effortId);
  return reply.data.id;
}

/** Records a choice made before there was a session to make it on. */
function onDraft(get: () => WorkbenchState, set: Setter, change: Partial<Draft>): void {
  const draft = get().draft;
  if (!draft) return;
  set({ draft: { ...draft, ...change } });
}

/**
 * Every session on the machine, not just the open project's.
 *
 * `workspaceId: null` means "all of them" to the daemon
 * (`SessionManager::list`), and one call is what lets the sidebar draw the
 * whole tree — which projects exist, and what is going on inside each. Asking
 * per workspace would mean one round trip per row, and a tree that fills in
 * raggedly as the answers arrive.
 */
async function loadSessions(client: Client, set: Setter): Promise<SessionSummary[]> {
  const reply = await client.call({
    type: "session.list",
    payload: { workspaceId: null, includeArchived: false },
  });
  if (reply?.type !== "sessions") return [];
  set({ sessions: reply.data });
  return reply.data;
}

/** The most recently touched of a set, or null. */
function newest(sessions: SessionSummary[]): SessionSummary | null {
  return sessions.reduce<SessionSummary | null>(
    (best, session) => (!best || session.updatedAtMs > best.updatedAtMs ? session : best),
    null,
  );
}

/**
 * The daemon names a session once, from the user's first message
 * (`SessionManager::send`), and pushes `titleChanged` at that moment. Without
 * this the sidebar and the tab both keep showing the "新会话" placeholder
 * they were created with until something unrelated (switching workspaces,
 * reconnecting) happens to refetch `session.list`.
 */
function applyTitle(sessionId: string, title: string, set: Setter): void {
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    ),
    tabs: state.tabs.map((tab) =>
      tab.sessionId === sessionId ? { ...tab, title } : tab,
    ),
  }));
}

/** Mirrors live daemon status into the session list without waiting for a poll. */
function applySessionStatus(
  sessionId: string,
  event: import("@genehub/proto").SessionEvent,
  set: Setter,
): void {
  const status =
    event.type === "turnStarted" || event.type === "permissionResolved"
      ? "running"
      : event.type === "permissionRequested"
        ? "waiting"
        : event.type === "turnFailed"
          ? "failed"
          : event.type === "turnCompleted" || event.type === "turnCanceled"
            ? "idle"
            : event.type === "sessionStatusChanged"
              ? event.status
              : null;
  if (!status) return;
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId ? { ...session, status } : session,
    ),
  }));
}

function currentWorkspace(state: WorkbenchState): string | null {
  const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
  return session?.workspaceId ?? state.activeWorkspaceId ?? state.workspaces[0]?.id ?? null;
}

/** The inactive tab that has been ignored longest is the least surprising one to close. */
function limitTabs(
  tabs: WorkbenchTab[],
  activeTabId: string | null,
  limit: number,
  sessions: SessionSummary[],
): { tabs: WorkbenchTab[]; evicted: WorkbenchTab[] } {
  const kept = [...tabs];
  const evicted: WorkbenchTab[] = [];
  while (kept.length > limit) {
    const candidates = kept.filter((tab) => tab.id !== activeTabId);
    if (candidates.length === 0) break;
    // Preserve a running conversation whenever another inactive tab can make
    // room. A completed, least-recently-used chat is closed first.
    const victim = [...candidates].sort((left, right) => {
      const leftRunning = sessionIsRunning(left, sessions);
      const rightRunning = sessionIsRunning(right, sessions);
      if (leftRunning !== rightRunning) return leftRunning ? 1 : -1;
      return (left.lastActivatedAt ?? 0) - (right.lastActivatedAt ?? 0);
    })[0]!;
    kept.splice(kept.indexOf(victim), 1);
    evicted.push(victim);
  }
  return { tabs: kept, evicted };
}

function sessionIsRunning(tab: WorkbenchTab, sessions: SessionSummary[]): boolean {
  const status = tab.sessionId
    ? sessions.find((session) => session.id === tab.sessionId)?.status
    : null;
  return status === "running" || status === "waiting";
}

function tabSessionIds(tabs: WorkbenchTab[]): string[] {
  return tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : []));
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _discarded, ...rest } = record;
  return rest;
}

function omitMany<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  return keys.reduce((remaining, key) => omit(remaining, key), record);
}

/** An evicted tab must not keep a daemon stream or a snapshot alive invisibly. */
function discardSubscriptions(client: Client | null, tabs: WorkbenchTab[]): void {
  for (const sessionId of tabSessionIds(tabs)) void client?.unsubscribe(sessionId);
}

/** Replaces the node at `path` with a freshly loaded one, in place. */
function graft(tree: FileNode, path: string, subtree: FileNode): FileNode {
  if (tree.path === path) return subtree;
  if (!tree.children) return tree;
  return { ...tree, children: tree.children.map((child) => graft(child, path, subtree)) };
}

function upsertBy<T>(list: T[], item: T, key: (value: T) => string): T[] {
  const index = list.findIndex((existing) => key(existing) === key(item));
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/**
 * Handles the failure of a request nobody is waiting on.
 *
 * Panels load their content when they mount — which is before there is a
 * connection, and again after one has gone away — so these requests routinely
 * die with the socket. That is not news and must not surface as an unhandled
 * rejection. A failure on the connection we are still using is news, and it
 * goes somewhere the user can see it.
 */
function unattended(client: Client, get: () => WorkbenchState, set: Setter) {
  return (error: unknown): undefined => {
    if (get().client !== client) return undefined;
    set({ notice: error instanceof Error ? error.message : String(error) });
    return undefined;
  };
}

/**
 * Runs something the user just asked for, and says why if it does not happen.
 *
 * Every one of these is called from a click handler, with nobody awaiting the
 * promise. A rejection there lands in the console — which no user has open — and
 * on screen it looks like the button did nothing. "I pressed send and nothing
 * happened" is the least debuggable report a person can give, and it was ours to
 * prevent: the daemon had already said what was wrong.
 */
async function asked<T>(set: Setter, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    set({ notice: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function require_(client: Client | null): Client {
  if (!client) throw new Error("the workbench is not connected yet");
  return client;
}
