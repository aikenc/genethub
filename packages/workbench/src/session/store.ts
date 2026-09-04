import type {
  AgentInfo,
  Attachment,
  BackgroundProcess,
  DeviceInfo,
  DeviceInvite,
  FileNode,
  ForkTarget,
  GitStatus,
  HubClaim,
  HubStatus,
  LogTail,
  RemoteAccess,
  PermissionOutcome,
  BlobPayload,
  BlobRef,
  Reply,
  RoundTrunk,
  TrunkLocator,
  SequencedEvent,
  SessionSnapshot,
  SessionImportListing,
  SessionSummary,
  Settings,
  SpeechRuntimeStatus,
  UpdateDownload,
  UpdateStatus,
  WorkspaceInfo,
} from "@genehub/proto";
import { create } from "zustand";

import { takeLandingIntent, type LandingIntent } from "../location/landing";
import {
  decodeTabToken,
  expandLocator,
  expandPreviewPath,
  NEW_SESSION_ID,
} from "../location/locator";
import type { AddressScope } from "../location/workbench";
import type { Client, ConnectionState } from "../protocol/client";
import { ConnectionOutcomeUnknownError } from "../protocol/client";
import { canStartAgent } from "../presentation/catalog/resolve";
import {
  recallRuntimeChoice,
  rememberRuntimeChoice,
  type AgentRuntimeMemory,
} from "./runtime-memory";
import {
  applySequenced,
  emptyTimeline,
  fromSnapshot,
  type PendingMessage,
  type TimelineState,
} from "./timeline";

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
  | "processes"
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

/** In-workbench Asset Preview float (default open path; not a new browser tab). */
export type PreviewFloatTarget = {
  deviceHandle: string;
  workspaceHandle: string;
  path: string;
  /** Session that owned the link when Preview was opened; stable across tab changes. */
  sessionId: string | null;
};

export type PreviewFloatRequest = Omit<PreviewFloatTarget, "sessionId"> & {
  sessionId?: string | null;
};

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
  runtimeValues: Record<string, string>;
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

const TAB_TITLES: Record<string, string> = {
  chat: "新会话",
  files: "文件",
  terminal: "终端",
  settings: "设置",
  devices: "设备",
  logs: "日志",
  processes: "此电脑的后台进程",
};

export type ComposerDraftInsert = {
  id: string;
  /** `null` is the unstarted conversation's composer. */
  sessionId: string | null;
  text: string;
};

/**
 * A forward capsule parked on a composer, shown as a removable quote card
 * rather than poured into the text field. On send the composer prepends
 * `capsule` to the user's own text, so the user reviews before anything is
 * sent (proposal §3.5).
 */
export type ForwardDraft = {
  /** `null` is the unstarted conversation's composer. */
  sessionId: string | null;
  capsule: string;
  itemCount: number;
  estimatedTokens: number;
  sourceSessionId: string;
  sourceTitle: string | null;
  /** Inlined image thumbs that travel with the capsule on send. */
  attachments?: Attachment[];
};

/**
 * A finished piece of work the user may want to act on — a Fork or forward
 * that landed on another machine. The action is theirs to take; nothing here
 * navigates on its own.
 */
export type CompletionNotice = {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
};

let composerDraftInsertSequence = 0;

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
  /**
   * How much of the current draft or conversation the address should name.
   *
   * A machine or workspace home keeps a draft on screen without rewriting a
   * bookmarked `/m-…` or `/m-…/w-…` into a session.
   */
  addressScope: AddressScope;
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  rightPanel: RightPanel;
  /** Default Preview surface; null when closed. New-tab Preview is opt-in only. */
  previewFloat: PreviewFloatTarget | null;
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
  /**
   * Content on its way back to the composer, put there by `editPending`.
   *
   * The draft itself belongs to the composer, so a failed message can only be
   * returned for editing through a channel like this one; whoever picks it up
   * clears it with `restoredDraft`.
   */
  restoreDraft: { text: string; attachments: Attachment[] } | null;
  /** Lines waiting to be appended to a session's composer without sending it. */
  composerDraftInserts: ComposerDraftInsert[];
  /** The forward capsule parked on a composer, if any. One at a time. */
  forwardDraft: ForwardDraft | null;
  /** A completed cross-machine outcome offering a follow-up action. */
  completionNotice: CompletionNotice | null;
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
  /**
   * What each session's agent left running.
   *
   * Pushed by the daemon at the end of every turn, so this is a count that can
   * sit on screen without anyone asking for it. Refetched when the panel opens
   * and after anything is ended, because those are the moments a stale answer
   * would be visible as a wrong one.
   */
  backgroundProcesses: BackgroundProcess[];
  remote: RemoteAccess | null;
  tree: FileNode | null;
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
  /** Changes a workspace's display name without moving its folders. */
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  /** Hides a workspace registration without deleting files or conversations. */
  removeWorkspace(workspaceId: string): Promise<void>;
  loadTree(path?: string): Promise<void>;
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
  /** Checks both the Live component and this machine's App build, both answered
   * by the daemon. */
  checkUpdates(): Promise<void>;
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
  setSpeechQwen3(input: {
    stubEnabled: boolean;
    contextEnabled: boolean;
    pinnedTerms: string[];
    languageHints: string[];
    collectCorrections: boolean;
    workspaceId?: string;
  }): Promise<void>;
  probeSpeechRuntime(): Promise<SpeechRuntimeStatus | null>;
  /** Removes a provider the user added. */
  forgetProvider(providerId: string): Promise<void>;
  /**
   * Opens an empty conversation. Writes nothing until the first message.
   *
   * Both arguments default to what is already on screen, so the "+" in the
   * header needs to know nothing about projects or agents.
   */
  newSession(
    workspaceId?: string | null,
    agentId?: string | null,
    options?: { addressScope?: AddressScope },
  ): void;
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
  /** Adds URL strip tokens without changing which tab is focused. */
  restoreStrip(tokens: string[]): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  setTabLimit(limit: number): void;
  setRightPanel(panel: RightPanel): void;
  openPreviewFloat(target: PreviewFloatRequest): void;
  closePreviewFloat(): void;
  send(text: string, attachments?: Attachment[]): Promise<void>;
  /** Sends a failed message again, unchanged. */
  retryPending(): Promise<void>;
  /** Takes a failed message back into the composer instead of resending it. */
  editPending(): void;
  /** Acknowledges that the composer has taken `restoreDraft` back. */
  restoredDraft(): void;
  /**
   * Adds one intact line to a session's current composer draft.
   *
   * `null` addresses the composer of a conversation that has not been created
   * yet, which is the one a suggested prompt is written into.
   */
  appendComposerDraftLine(sessionId: string | null, text: string): void;
  /** Acknowledges that one queued composer insertion has been applied. */
  consumedComposerDraftInsert(id: string): void;
  /** Parks (or clears, with `null`) the forward capsule on a composer. */
  setForwardDraft(draft: ForwardDraft | null): void;
  /** Shows (or clears, with `null`) the completed-work banner. */
  setCompletionNotice(notice: CompletionNotice | null): void;
  /**
   * Batch fetches for the forward dialog's detail fill (proposal §7.0).
   * Results are also cached into the session's timeline, which the round
   * layer's own expansion then reuses.
   */
  fetchTrunkDetails(sessionId: string, refs: TrunkLocator[]): Promise<RoundTrunk[] | null>;
  fetchBlobPayloads(sessionId: string, refs: BlobRef[]): Promise<BlobPayload[] | null>;
  /** Creates an independent Agent context through one completed turn. */
  forkSession(turnId: string, target?: ForkTarget): Promise<boolean>;
  /** Lightweight provider discovery; full history is read only after selection. */
  listImportableSessions(workspaceId: string): Promise<SessionImportListing | null>;
  /** Imports one expiring candidate and opens the resulting GeneHub session. */
  importSessionCandidate(workspaceId: string, candidateId: string): Promise<boolean>;
  interrupt(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setEffort(effortId: string): Promise<void>;
  setRuntimeAxis(axisId: string, valueId: string): Promise<void>;
  answerPermission(outcome: PermissionOutcome): Promise<void>;
  /**
   * Re-probes every Agent. Opening the picker after an install, or finishing a
   * turn that may have installed one, must not keep showing the first answer
   * the daemon cached for its lifetime.
   */
  refreshAgents(): Promise<void>;
  refreshHub(): Promise<void>;
  pair(hubUrl: string): Promise<void>;
  /** Pairs with an identity the Hub makes up on the spot, nobody to approve it. */
  trial(hubUrl: string): Promise<HubClaim | null>;
  /** A fresh link into this machine's identity, to open on another device. */
  claimLink(): Promise<HubClaim | null>;
  unpair(): Promise<void>;
  refreshDevices(): Promise<void>;
  refreshBackgroundProcesses(): Promise<void>;
  killBackgroundProcess(sessionId: string, pid: number): Promise<void>;
  killBackgroundProcesses(sessionId: string): Promise<void>;
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
function endsATurn(type: SequencedEvent["event"]["type"]): boolean {
  return type === "turnCompleted" || type === "turnFailed" || type === "turnCanceled";
}

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

/** The reconnect sentence this store put on screen, while it is still true. */
let reconnectNotice: string | null = null;

/**
 * The connection-loss sentence put on screen by a request that died with the
 * socket. It reports a condition, not an event: once the connection is back
 * and the timeline has resynchronised, the loss it describes no longer
 * exists, and leaving the banner up only teaches people to ignore banners.
 */
let connectionLossNotice: string | null = null;

/**
 * The message of an error that is a dropped connection speaking, or null for
 * anything else. `ConnectionOutcomeUnknownError` covers requests in flight;
 * the Hello path rejects with a plain Error carrying the same prefix.
 */
function connectionLossMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof ConnectionOutcomeUnknownError ||
    message.startsWith("the connection was lost")
    ? message
    : null;
}

/**
 * Surfaces a failure and remembers it when it is a dropped connection
 * speaking, so the banner can be withdrawn when the connection returns.
 */
function reportError(set: Setter, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (connectionLossMessage(error)) connectionLossNotice = message;
  set({ notice: message });
}

let roundReads: Promise<unknown> = Promise.resolve();

/**
 * Runs round-layer reads one after another.
 *
 * Opening a session mounts one progress panel per round, and each asks for the
 * layer it does not have — so a long conversation fired a request per round in
 * a single tick. That buys nothing: a daemon answers one request per connection
 * at a time, so the replies arrive in the same order either way. What it costs
 * is the inbound queue on the far side, which is short by design and takes the
 * whole connection down with it when it fills.
 */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = roundReads.then(work, work);
  roundReads = next.catch(() => undefined);
  return next;
}

let roundRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let roundRefreshInFlight: Promise<void> | null = null;
let roundRefreshAgain = false;

async function refreshRound(get: () => WorkbenchState): Promise<void> {
  const sessionId = get().activeSessionId;
  if (!sessionId) return;
  await get().loadRound("latest");
  if (get().activeSessionId !== sessionId) return;
  const round = Object.values(get().timeline.roundLayers)
    .reverse()
    .find((layer) => layer.round.outcome === "running")?.round;
  if (!round) return;
  const last = get().timeline.roundLayers[round.roundId]?.trunks.at(-1);
  if (!last) return;
  const loaded = get().timeline.roundTrunks[`${round.roundId}:${last.index}`];
  // A layer refresh often reports the exact same live tail. Keep the detail
  // object already on screen in that case, so an expanded card neither flashes
  // through loading nor churns its measured height on every stream event.
  if (!loaded || JSON.stringify(loaded.summary) !== JSON.stringify(last)) {
    await get().loadTrunk(round.roundId, last.index);
  }
}

/**
 * Asks the daemon for the round layer again, at most one round trip at a time.
 *
 * The timer alone was not enough. A daemon serves one request per connection at
 * a time, so under a fast agent each 250ms window started another two requests
 * on top of ones still unanswered, and the queue on the far side reached the
 * depth at which it drops the connection — the very moment the person most
 * wants to be watching. Only the fact that another refresh is owed is kept, not
 * how many: the layer is a current value, and one later read tells us all that
 * any number of skipped reads would have.
 */
function scheduleRoundRefresh(get: () => WorkbenchState): void {
  if (roundRefreshInFlight) {
    roundRefreshAgain = true;
    return;
  }
  if (roundRefreshTimer) clearTimeout(roundRefreshTimer);
  roundRefreshTimer = setTimeout(() => {
    roundRefreshTimer = null;
    const refresh = refreshRound(get)
      .catch(() => undefined)
      .finally(() => {
        roundRefreshInFlight = null;
        if (!roundRefreshAgain) return;
        roundRefreshAgain = false;
        scheduleRoundRefresh(get);
      });
    roundRefreshInFlight = refresh;
  }, 250);
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  client: null,
  connection: "connecting",
  agents: [],
  backgroundProcesses: [],
  workspaces: [],
  activeWorkspaceId: null,
  sessions: [],
  activeSessionId: null,
  draft: null,
  addressScope: "machine",
  tabs: [],
  activeTabId: null,
  rightPanel: null,
  previewFloat: null,
  timeline: emptyTimeline(),
  sessionTimelines: {},
  subscribedSessionIds: [],
  tabLimit: 16,
  notice: null,
  restoreDraft: null,
  composerDraftInserts: [],
  forwardDraft: null,
  completionNotice: null,
  hub: null,
  claim: null,
  devices: [],
  remote: null,
  tree: null,
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
    reconnectNotice = null;
    connectionLossNotice = null;
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
          reconnectNotice = `连接被断开（${closed.code ?? "?"} ${closed.reason}），正在重连`;
          set({ notice: reconnectNotice });
        }
      }
      // Once the socket is back, a banner still saying "正在重连" is no longer
      // a report of anything — it is the reason someone writes in to say the
      // app is stuck reconnecting when it reconnected a minute ago. The same
      // goes for a request the drop took down: the timeline has since said
      // what became of it. Only these lines' own sentences are withdrawn;
      // anything said since stands.
      if (connection === "ready") {
        if (reconnectNotice) {
          const stale = reconnectNotice;
          reconnectNotice = null;
          set((state) => (state.notice === stale ? { notice: null } : {}));
        }
        if (connectionLossNotice) {
          const stale = connectionLossNotice;
          connectionLossNotice = null;
          set((state) => (state.notice === stale ? { notice: null } : {}));
        }
      }
    });
    client.onNotice((_level, message) => set({ notice: message }));
    client.onUpdateDownload((download) => set({ download }));
    client.onBackgroundProcesses((backgroundProcesses) => set({ backgroundProcesses }));
    try {
      // Hub status and the download prompt do not read anything the catalog
      // loads, so they fly alongside it instead of queueing behind two relay
      // round trips — on a slow link that queueing is most of what switching
      // to a machine used to cost.
      const ancillary = (async () => {
        await get().refreshHub();
        // Asked on connect, unlike the update check itself. A download that was
        // running when the window closed is still running, and the prompt to
        // install it has to come back with the window rather than wait for
        // someone to go looking in settings for a file they already have.
        const download = await client.call({ type: "update.downloadState" });
        if (download?.type === "updateDownload") set({ download: download.data });
      })().catch((error: unknown) => unattended(client, get, set)(error));
      await refreshCatalog(client, set);
      if (get().client === client) await land(get);
      await ancillary;
    } catch (error) {
      // A connection can disappear halfway through being asked things: the tab
      // is closing, or the daemon restarted and the shell has already pointed
      // us at its replacement. Neither is worth reporting — but an error on the
      // connection we are still using is, and it used to go nowhere at all.
      if (get().client !== client) return;
      reportError(set, error);
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
    get().newSession(reply.data.id, null, { addressScope: "workspace" });
  },

  async selectWorkspace(workspaceId) {
    // The workspace address is its homepage: a new conversation, not the last
    // one that happened to run here. That last one stays in the list.
    require_(get().client);
    get().newSession(workspaceId, null, { addressScope: "workspace" });
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

  async removeWorkspace(workspaceId) {
    const client = require_(get().client);
    const before = get();
    const removedSessionIds = new Set(
      before.sessions
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.id),
    );
    const removedTabs = before.tabs.filter(
      (tab) =>
        (tab.sessionId && removedSessionIds.has(tab.sessionId)) ||
        (tab.id === DRAFT_TAB && before.draft?.workspaceId === workspaceId),
    );
    const reply = await asked(set, () =>
      client.call({ type: "workspace.remove", payload: { workspaceId } }),
    );
    if (reply?.type !== "workspaces") return;

    discardSubscriptions(client, removedTabs);
    const removedWasActive =
      before.activeWorkspaceId === workspaceId ||
      (before.activeSessionId ? removedSessionIds.has(before.activeSessionId) : false) ||
      before.draft?.workspaceId === workspaceId;
    const nextWorkspaceId = removedWasActive
      ? (reply.data[0]?.id ?? null)
      : before.activeWorkspaceId;
    set((state) => {
      const tabs = state.tabs.filter((tab) => !removedTabs.some((removed) => removed.id === tab.id));
      const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : (tabs.at(-1)?.id ?? null);
      return {
        workspaces: reply.data,
        activeWorkspaceId: nextWorkspaceId,
        activeSessionId: removedWasActive ? null : state.activeSessionId,
        draft: state.draft?.workspaceId === workspaceId ? null : state.draft,
        tabs,
        activeTabId,
        timeline: removedWasActive ? emptyTimeline() : state.timeline,
        sessionTimelines: omitMany(state.sessionTimelines, [...removedSessionIds]),
        subscribedSessionIds: state.subscribedSessionIds.filter(
          (id) => !removedSessionIds.has(id),
        ),
        tree: removedWasActive ? null : state.tree,
        git: removedWasActive ? null : state.git,
        diff: removedWasActive ? null : state.diff,
      };
    });
    await loadSessions(client, set);
    if (removedWasActive && nextWorkspaceId) {
      get().newSession(nextWorkspaceId, null, { addressScope: "workspace" });
    }
  },

  newSession(workspaceId, agentId, options) {
    const state = get();
    const target = workspaceId ?? currentWorkspace(state);
    if (!target) return;
    // What this project was last worked on with, before what is on screen: a
    // conversation open in another project is not evidence about this one, and
    // switching projects is exactly when the Agent usually changes too. Only a
    // project's own history outranks the conversation in front of the user;
    // an inherited last-used choice does not.
    const own = recallRuntimeChoice(target, state.agents);
    const chosenAgentId =
      agentId ??
      (own.scoped ? own.agentId : null) ??
      state.draft?.agentId ??
      state.sessions.find((entry) => entry.id === state.activeSessionId)?.agentId ??
      own.agentId ??
      null;
    // Scoped to the Agent actually being opened: Claude's `sonnet` would be an
    // id Codex has never heard of, and `session.create` would refuse it.
    const remembered =
      chosenAgentId === own.agentId
        ? own
        : recallRuntimeChoice(target, state.agents, chosenAgentId);
    if (agentId) rememberRuntimeChoice(target, agentId);
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
        agentId: chosenAgentId,
        modelId: remembered.modelId,
        modeId: remembered.modeId,
        effortId: remembered.effortId,
        runtimeValues: remembered.runtimeValues,
      },
      activeWorkspaceId: target,
      activeSessionId: null,
      addressScope:
        options?.addressScope ?? (state.addressScope === "machine" ? "machine" : "workspace"),
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
        addressScope: "session",
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
        if (endsATurn(event.event.type) && get().agents.some((agent) => !canStartAgent(agent))) {
          void get().refreshAgents();
        }
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
        const previous = timelineOf(get(), sessionId);
        const base = reset
          ? fromSnapshot(resnapshot as SessionSnapshot, previous.pending, previous)
          : previous;
        // The snapshot is the daemon's own answer, and it arrives precisely
        // when the events that would have carried the status were the ones
        // dropped. Replaying only what survived leaves a finished turn showing
        // as still running, with a composer that will not take the next
        // message — the shape of every freeze report we have.
        adoptSnapshotStatus(sessionId, resnapshot as SessionSnapshot, set);
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
    const previous = timelineOf(get(), sessionId);
    const base = fromSnapshot(typedSnapshot, previous.pending, previous);
    // A slower subscription must not repaint whichever session the user opened
    // next. This is easy to hit when switching pages over a relay: both replies
    // are valid, but only the currently selected session owns the timeline.
    markSessionRead(typedSnapshot.summary);
    adoptSnapshotStatus(sessionId, typedSnapshot, set);
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
    return oneAtATime(async () => {
      const reply = await require_(get().client).call({
        type: "round.trunk.list",
        payload: { sessionId, roundId, cursor: null, limit: 20 },
      });
      if (reply?.type !== "roundLayer") return;
      const layer = reply.data;
      patchTimeline(sessionId, set, (timeline) => {
        const existing = timeline.roundLayers[layer.round.roundId];
        const trunks = existing
          ? [
              ...new Map(
                [...existing.trunks, ...layer.trunks].map((trunk) => [trunk.index, trunk]),
              ).values(),
            ].sort((left, right) => left.index - right.index)
          : layer.trunks;
        const existingFirst = existing?.trunks[0]?.index;
        const keptOlder =
          existingFirst !== undefined && existingFirst < (layer.trunks[0]?.index ?? 0);
        const expanded = layer.expandedTrunk;
        const nextRoundTrunks = expanded
          ? {
              ...timeline.roundTrunks,
              [`${layer.round.roundId}:${expanded.summary.index}`]: expanded,
            }
          : timeline.roundTrunks;
        return {
          rounds: [
            ...timeline.rounds.filter((round) => round.roundId !== layer.round.roundId),
            layer.round,
          ],
          roundLayers: {
            ...timeline.roundLayers,
            [layer.round.roundId]: {
              ...layer,
              trunks,
              nextCursor: keptOlder ? existing?.nextCursor : layer.nextCursor,
            },
          },
          roundTrunks: nextRoundTrunks,
        };
      });
    });
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

  restoreStrip(tokens) {
    if (tokens.length === 0) return;
    set((state) => {
      const existing = new Map(state.tabs.map((tab) => [tab.id, tab]));
      const next: WorkbenchTab[] = [];
      for (const raw of tokens) {
        const decoded = decodeTabToken(raw);
        if (!decoded) continue;
        if (decoded.kind === "chat") {
          if (decoded.sessionToken === NEW_SESSION_ID) {
            const draft =
              existing.get(DRAFT_TAB) ??
              (state.draft
                ? { id: DRAFT_TAB, kind: "chat" as const, title: "新会话" }
                : null);
            if (draft && !next.some((tab) => tab.id === draft.id)) next.push(draft);
            continue;
          }
          const sessionId = expandLocator(
            decoded.sessionToken ?? "",
            state.sessions.map((session) => session.id),
          );
          if (!sessionId) continue;
          const id = `chat:${sessionId}`;
          if (next.some((tab) => tab.id === id)) continue;
          const prior = existing.get(id);
          const session = state.sessions.find((entry) => entry.id === sessionId);
          next.push(
            prior ?? {
              id,
              kind: "chat",
              title: session?.title || "会话",
              sessionId,
            },
          );
          continue;
        }
        const id = decoded.kind;
        if (next.some((tab) => tab.id === id)) continue;
        next.push(
          existing.get(id) ?? {
            id,
            kind: decoded.kind,
            title: TAB_TITLES[decoded.kind] ?? decoded.kind,
          },
        );
      }
      for (const tab of state.tabs) {
        if (!next.some((entry) => entry.id === tab.id)) next.push(tab);
      }
      const limited = limitTabs(next, state.activeTabId, state.tabLimit, state.sessions);
      discardSubscriptions(state.client, limited.evicted);
      return {
        tabs: limited.tabs,
        sessionTimelines: omitMany(state.sessionTimelines, tabSessionIds(limited.evicted)),
        subscribedSessionIds: state.subscribedSessionIds.filter(
          (sessionId) => !tabSessionIds(limited.evicted).includes(sessionId),
        ),
      };
    });
  },

  openTab(kind, title) {
    const id = kind === "chat" ? `chat:${get().activeSessionId ?? "draft"}` : kind;
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
          { id, kind, title: title ?? TAB_TITLES[kind] ?? kind, lastActivatedAt: Date.now() },
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

  openPreviewFloat(target) {
    set({
      previewFloat: {
        deviceHandle: target.deviceHandle,
        workspaceHandle: target.workspaceHandle,
        path: target.path,
        sessionId:
          target.sessionId === undefined ? get().activeSessionId : target.sessionId,
      },
    });
  },

  closePreviewFloat() {
    set({ previewFloat: null });
  },

  async send(text, attachments = []) {
    // The previous complaint goes away as the next attempt starts, so a stale
    // line does not get read as a description of what just happened.
    set({ notice: null });
    const active = get().activeSessionId;
    // Only one message may be in flight. The daemon enforces this too, but its
    // refusal arrives as a red line about a turn already running — which is a
    // report of our own double send, not news the reader can act on.
    //
    // A failed message is not in flight: it is waiting for a decision, and
    // typing a new one is a decision. It gives up its place here rather than
    // silently swallowing the next thing the user says.
    const inFlight = active ? timelineOf(get(), active).pending : get().timeline.pending;
    if (inFlight && !inFlight.error) return;

    // On screen before anything leaves this machine, and before the round trips
    // in `start`. Everything below can take seconds.
    const pending: PendingMessage = {
      text,
      attachments,
      sentAtMs: Date.now(),
      error: null,
    };
    // Park it on whatever timeline is on screen, including a draft that has
    // no session id yet. Otherwise the send control stays Send for the whole
    // of `session.create`.
    set((state) => {
      const sessionId = state.activeSessionId;
      const current = sessionId ? timelineOf(state, sessionId) : state.timeline;
      const timeline = { ...current, pending };
      return {
        timeline,
        ...(sessionId
          ? { sessionTimelines: { ...state.sessionTimelines, [sessionId]: timeline } }
          : {}),
      };
    });

    // This is where a draft becomes a conversation: the machine hears about it
    // at the first message, not when the button was pressed.
    const sessionId = await start(get, set, pending);
    if (!sessionId) {
      // `asked` has already said why, if anything was asked at all. With a
      // session there is a bubble to mark; a conversation that could not even be
      // created has nowhere to put one, so the text goes back to the composer
      // rather than nowhere — it only exists here.
      if (active) failPending(active, set, get().notice ?? "无法开始会话");
      else
        set((state) => ({
          restoreDraft: { text, attachments },
          timeline: { ...state.timeline, pending: null },
        }));
      return;
    }

    try {
      // Artifact Preview URLs are bound at chat/document render time from the
      // current workspace roots. Agents emit relative/absolute file paths; the
      // daemon teaches path-linking rules (not a deployment-specific prefix).
      await require_(get().client).call({
        type: "session.send",
        // Continuing a round after an interrupt is not wired into the UI
        // yet — every message from here is a fresh round until it is
        // (docs/agent-analysis-substrate-proposal.md §3.2).
        payload: {
          sessionId,
          text,
          attachments,
          artifactPreviewBaseUrl: null,
          continuesRound: null,
        },
      });
      // The daemon publishes the user message before it answers this call, and
      // replies and events share one socket in arrival order, so the real item
      // is already here. This is the second of the two ways the placeholder
      // goes away, and it costs nothing to keep both (`timeline.apply` has the
      // other): a reply that never comes must not leave a bubble behind.
      patchTimeline(sessionId, set, (timeline) => ({
        pending: null,
        status: timeline.status === "idle" ? "running" : timeline.status,
      }));
    } catch (error) {
      // A lost connection is not a failed send. The prompt may well have been
      // taken — `ConnectionOutcomeUnknownError` exists to say exactly that —
      // and calling it a failure would put a second bubble next to the real one
      // as soon as the replay lands. Leave it pending; the resync decides.
      if (error instanceof ConnectionOutcomeUnknownError) return;
      const message = error instanceof Error ? error.message : String(error);
      failPending(sessionId, set, message);
      set({ notice: message });
    }
  },

  async retryPending() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = timelineOf(get(), sessionId).pending;
    if (!pending?.error) return;
    // Cleared first, or `send` would take this for a message already in flight.
    patchTimeline(sessionId, set, () => ({ pending: null }));
    await get().send(pending.text, pending.attachments);
  },

  editPending() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = timelineOf(get(), sessionId).pending;
    if (!pending?.error) return;
    patchTimeline(sessionId, set, () => ({ pending: null }));
    set({
      notice: null,
      restoreDraft: { text: pending.text, attachments: pending.attachments },
    });
  },

  restoredDraft() {
    set({ restoreDraft: null });
  },

  appendComposerDraftLine(sessionId, text) {
    if (!text || text.includes("\n")) return;
    const insert = {
      id: `composer-insert-${Date.now().toString(36)}-${++composerDraftInsertSequence}`,
      sessionId: sessionId || null,
      text,
    } satisfies ComposerDraftInsert;
    set((state) => ({ composerDraftInserts: [...state.composerDraftInserts, insert] }));
  },

  consumedComposerDraftInsert(id) {
    set((state) => ({
      composerDraftInserts: state.composerDraftInserts.filter((insert) => insert.id !== id),
    }));
  },

  setForwardDraft(draft) {
    set({ forwardDraft: draft });
  },

  setCompletionNotice(notice) {
    set({ completionNotice: notice });
  },

  async fetchTrunkDetails(sessionId, refs) {
    if (refs.length === 0) return [];
    const client = require_(get().client);
    const trunks = await batchOrSequentially(
      client,
      "roundTrunks",
      () => client.call({ type: "round.trunk.batchGet", payload: { sessionId, refs } }),
      async () => {
        const oneByOne: RoundTrunk[] = [];
        for (const ref of refs) {
          const reply = await client.call({
            type: "round.trunk.get",
            payload: { sessionId, roundId: ref.roundId, trunkIndex: ref.trunkIndex },
          });
          if (reply?.type !== "roundTrunk") return null;
          oneByOne.push(reply.data);
        }
        return oneByOne;
      },
      set,
    );
    if (!trunks) return null;
    patchTimeline(sessionId, set, (timeline) => {
      const roundTrunks = { ...timeline.roundTrunks };
      // Responses align with request order; the locator's round id is what
      // the timeline cache key needs, and the payload does not repeat it.
      for (const [index, trunk] of trunks.entries()) {
        const roundId = refs[index]?.roundId;
        if (roundId) roundTrunks[`${roundId}:${trunk.summary.index}`] = trunk;
      }
      return { roundTrunks };
    });
    return trunks;
  },

  async fetchBlobPayloads(sessionId, refs) {
    if (refs.length === 0) return [];
    const client = require_(get().client);
    const payloads = await batchOrSequentially(
      client,
      "blobs",
      () => client.call({ type: "blob.batchGet", payload: { sessionId, blobs: refs } }),
      async () => {
        const oneByOne: BlobPayload[] = [];
        for (const ref of refs) {
          const reply = await client.call({
            type: "blob.get",
            payload: { sessionId, blob: ref },
          });
          if (reply?.type !== "blob") return null;
          oneByOne.push(reply.data);
        }
        return oneByOne;
      },
      set,
    );
    if (!payloads) return null;
    patchTimeline(sessionId, set, (timeline) => ({
      blobs: {
        ...timeline.blobs,
        ...Object.fromEntries(payloads.map((payload) => [payload.id, payload])),
      },
    }));
    return payloads;
  },

  async forkSession(turnId, target) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return false;
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "session.fork",
        payload: { sessionId, turnId, ...(target ? { target } : {}) },
      }),
    );
    if (reply?.type !== "session") return false;
    set((state) => ({ sessions: [reply.data, ...state.sessions] }));
    await get().selectSession(reply.data.id);
    return true;
  },

  async listImportableSessions(workspaceId) {
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "session.importList",
        payload: { workspaceId, limit: 30 },
      }),
    );
    return reply?.type === "sessionImports" ? reply.data : null;
  },

  async importSessionCandidate(workspaceId, candidateId) {
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "session.import",
        payload: { workspaceId, candidateId },
      }),
    );
    if (reply?.type !== "session") return false;
    set((state) => ({ sessions: [reply.data, ...state.sessions] }));
    await get().selectSession(reply.data.id);
    return true;
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
    remember(get(), { modelId });
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { modelId });
    await switched(get, set, sessionId, "modelId", modelId, () =>
      require_(get().client).call({ type: "session.setModel", payload: { sessionId, modelId } }),
    );
  },

  async setMode(modeId) {
    remember(get(), { modeId });
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { modeId });
    await switched(get, set, sessionId, "modeId", modeId, () =>
      require_(get().client).call({ type: "session.setMode", payload: { sessionId, modeId } }),
    );
  },

  async setEffort(effortId) {
    remember(get(), { effortId });
    const sessionId = get().activeSessionId;
    if (!sessionId) return void onDraft(get, set, { effortId });
    await switched(get, set, sessionId, "effortId", effortId, () =>
      require_(get().client).call({ type: "session.setEffort", payload: { sessionId, effortId } }),
    );
  },

  async setRuntimeAxis(axisId, valueId) {
    remember(get(), { runtimeValues: { [axisId]: valueId } });
    const sessionId = get().activeSessionId;
    if (!sessionId) {
      const draft = get().draft;
      if (!draft) return;
      return void onDraft(get, set, {
        runtimeValues: { ...draft.runtimeValues, [axisId]: valueId },
      });
    }
    const before = get().timeline.runtimeValues[axisId];
    set((state) => ({
      timeline: {
        ...state.timeline,
        runtimeValues: { ...state.timeline.runtimeValues, [axisId]: valueId },
      },
    }));
    try {
      await require_(get().client).call({
        type: "session.setRuntimeAxis",
        payload: { sessionId, axisId, valueId },
      });
    } catch (error) {
      const state = get();
      if (
        state.activeSessionId === sessionId &&
        state.timeline.runtimeValues[axisId] === valueId
      ) {
        const runtimeValues = { ...state.timeline.runtimeValues };
        if (before === undefined) delete runtimeValues[axisId];
        else runtimeValues[axisId] = before;
        set({ timeline: { ...state.timeline, runtimeValues } });
      }
      reportError(set, error);
    }
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

  async checkUpdates() {
    set({ appUpdate: null, appUpdating: true });
    await Promise.all([
      get().checkUpdate(),
      (async () => {
        try {
          const reply = await asked(set, () =>
            require_(get().client).call({ type: "update.appCheck" }),
          );
          if (reply?.type === "update") set({ appUpdate: reply.data });
        } finally {
          set({ appUpdating: false });
        }
      })(),
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

  async setSpeechQwen3({
    stubEnabled,
    contextEnabled,
    pinnedTerms,
    languageHints,
    collectCorrections,
    workspaceId,
  }) {
    set({ notice: null });
    const reply = await asked(set, () =>
      require_(get().client).call({
        type: "speech.settings.setQwen3",
        payload: {
          stubEnabled,
          contextEnabled,
          pinnedTerms,
          languageHints,
          collectCorrections,
          ...(workspaceId ? { workspaceId } : {}),
        },
      }),
    );
    if (reply?.type === "settings") set({ settings: reply.data });
  },

  async probeSpeechRuntime() {
    set({ notice: null });
    const reply = await asked(set, () =>
      require_(get().client).call({ type: "speech.runtime.probe" }),
    );
    return reply?.type === "speechRuntimeStatus" ? reply.data : null;
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

  async refreshAgents() {
    const client = get().client;
    if (!client) return;
    const agents = await client.call({ type: "agent.refresh" }).catch(unattended(client, get, set));
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
    // Null, not a grant list: the workbench pairs a device the owner will use
    // as themselves. Narrowing belongs to whoever is deliberately handing out
    // less, and inventing a default here would decide that for them.
    const reply = await require_(get().client).call({
      type: "device.invite",
      payload: null,
    });
    return reply?.type === "invite" ? reply.data : null;
  },

  async refreshBackgroundProcesses() {
    const client = require_(get().client);
    const reply = await client
      .call({ type: "process.list" })
      .catch(unattended(client, get, set));
    if (reply?.type === "processes") set({ backgroundProcesses: reply.data });
  },

  async killBackgroundProcess(sessionId, pid) {
    await require_(get().client).call({ type: "process.kill", payload: { sessionId, pid } });
    await get().refreshBackgroundProcesses();
  },

  async killBackgroundProcesses(sessionId) {
    await require_(get().client).call({ type: "process.killAll", payload: { sessionId } });
    await get().refreshBackgroundProcesses();
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
 * Puts the user on the page the address named, or continues the last thing
 * when there is no address (desktop, or a bare `/`).
 *
 * `/m-…` and `/m-…/w-…` are homes: a new conversation, with the most recent
 * workspace as the default on a machine home. A stored session is only opened
 * when the address names one. The splash screen remains the one case nothing
 * here can act on: no model to run the turn with.
 */
async function land(get: () => WorkbenchState): Promise<void> {
  const intent = takeLandingIntent();
  if (intent && (await applyLanding(get, intent))) {
    finishLanding(get, intent);
    return;
  }
  if (intent?.workspaceId) {
    const workspaceId = expandLocator(
      intent.workspaceId,
      get().workspaces.map((entry) => entry.id),
    );
    if (!workspaceId) {
      useWorkbench.setState({ notice: "这个地址对不上。" });
    } else if (get().activeWorkspaceId !== workspaceId) {
      await get().selectWorkspace(workspaceId);
      finishLanding(get, intent);
      return;
    }
  }

  const state = get();
  if (state.activeSessionId) {
    finishLanding(get, intent);
    return;
  }
  const workspaceId = state.activeWorkspaceId;
  if (!workspaceId) return;

  const latest = newest(
    state.sessions.filter((session) => session.workspaceId === workspaceId),
  );
  if (latest) {
    await get().selectSession(latest.id);
    finishLanding(get, intent);
    return;
  }

  const agent = defaultAgent(state.agents);
  if (!agent) return;
  // An empty conversation, not a stored one. Landing somewhere used to write a
  // session on every first visit to a project, whether or not anything was ever
  // said in it.
  get().newSession(workspaceId, agent.id, { addressScope: "machine" });
  finishLanding(get, intent);
}

async function applyLanding(
  get: () => WorkbenchState,
  intent: LandingIntent,
): Promise<boolean> {
  if (intent.sessionId && intent.sessionId !== NEW_SESSION_ID) {
    const sessionId = expandLocator(
      intent.sessionId,
      get().sessions.map((session) => session.id),
    );
    if (sessionId) {
      await get().selectSession(sessionId);
      return true;
    }
    useWorkbench.setState({ notice: "这个会话已经不在了。" });
    return false;
  }
  const workspaceId = intent.workspaceId
    ? expandLocator(
        intent.workspaceId,
        get().workspaces.map((entry) => entry.id),
      )
    : currentWorkspace(get()) ?? get().activeWorkspaceId;
  if (intent.workspaceId && !workspaceId) {
    useWorkbench.setState({ notice: "这个地址对不上。" });
    return false;
  }
  if (!workspaceId) return false;
  get().newSession(workspaceId, null, {
    addressScope: intent.workspaceId ? "workspace" : "machine",
  });
  return true;
}

function finishLanding(get: () => WorkbenchState, intent: LandingIntent | null): void {
  if (intent?.tabs?.length) get().restoreStrip(intent.tabs);
  openLandingPreview(get, intent);
}

function openLandingPreview(get: () => WorkbenchState, intent: LandingIntent | null): void {
  if (!intent?.previewPath) return;
  const device = get().client?.identity?.machineId;
  const workspace = get().activeWorkspaceId ?? get().draft?.workspaceId;
  if (!device || !workspace) return;
  const roots =
    get()
      .workspaces.find((entry) => entry.id === workspace)
      ?.folders.map((folder) => folder.rootHandle) ?? [];
  const path = expandPreviewPath(intent.previewPath, roots);
  if (!path) {
    useWorkbench.setState({ notice: "这个地址对不上。" });
    return;
  }
  get().openPreviewFloat({
    deviceHandle: device,
    workspaceHandle: workspace,
    path,
  });
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
  /** Carried into the new session's timeline, which does not exist until here. */
  pending: PendingMessage | null = null,
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
        runtimeValues: draft.runtimeValues,
        title: null,
        cwd: null,
      },
    }),
  );
  if (reply?.type !== "session") return null;

  // The choice that actually started a conversation, not merely one that was
  // looked at: this is what the next new chat in this project opens with.
  rememberRuntimeChoice(draft.workspaceId, agentId, {
    ...(draft.modelId ? { modelId: draft.modelId } : {}),
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.effortId ? { effortId: draft.effortId } : {}),
    ...(Object.keys(draft.runtimeValues).length > 0
      ? { runtimeValues: draft.runtimeValues }
      : {}),
  });
  set((current) => ({
    sessions: [reply.data, ...current.sessions],
    // A forward capsule parked on the unstarted conversation belongs to the
    // session that conversation just became; re-key it or the card vanishes.
    ...(current.forwardDraft?.sessionId === null
      ? { forwardDraft: { ...current.forwardDraft, sessionId: reply.data.id } }
      : {}),
    // Seed before `selectSession` so the first paint of the new session still
    // holds the message that is in flight; otherwise subscribe's empty
    // timeline puts Send back until this function patches pending afterwards.
    ...(pending
      ? {
          sessionTimelines: {
            ...current.sessionTimelines,
            [reply.data.id]: { ...(current.sessionTimelines[reply.data.id] ?? emptyTimeline()), pending },
          },
        }
      : {}),
  }));
  // Clears the draft and turns its tab into this session's.
  await get().selectSession(reply.data.id);
  // Before `setEffort`, which is another round trip: the first message of a new
  // conversation should not be the one message that waits longest to appear.
  if (pending) patchTimeline(reply.data.id, set, () => ({ pending }));
  // `session.create` has no field for it, so the one choice that cannot ride
  // along is made immediately afterwards instead of being lost.
  if (draft.effortId) await get().setEffort(draft.effortId);
  return reply.data.id;
}

/** Marks a message as definitely not sent, keeping its text where it can be reused. */
function failPending(sessionId: string, set: Setter, message: string): void {
  patchTimeline(sessionId, set, (timeline) =>
    timeline.pending ? { pending: { ...timeline.pending, error: message } } : {},
  );
}

/** Records a choice made before there was a session to make it on. */
function onDraft(get: () => WorkbenchState, set: Setter, change: Partial<Draft>): void {
  const draft = get().draft;
  if (!draft) return;
  set({ draft: { ...draft, ...change } });
}

/**
 * Moves one runtime axis on screen now, and tells the machine after.
 *
 * These three used to show the new value only once the daemon echoed it back,
 * which is a relay hop, an RPC and — for an ACP agent — a round trip into the
 * CLI's own process. Picking a thinking level felt like it had been sent
 * somewhere, because it had: the radio a finger was already on stayed on the
 * old choice for as long as that took.
 *
 * Nothing is lost by leading: the daemon owns the value, and its
 * `modelChanged` / `modeChanged` / `effortChanged` event overwrites this the
 * moment it lands. Only a refusal has to be undone, and only if this session is
 * still the one on screen and still showing the value we put there — a later
 * pick, or an event, has already answered the question this one asked.
 */
async function switched(
  get: () => WorkbenchState,
  set: Setter,
  sessionId: string,
  axis: "modelId" | "modeId" | "effortId",
  value: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const before = get().timeline[axis];
  set((state) => ({ timeline: { ...state.timeline, [axis]: value } }));
  try {
    await run();
  } catch (error) {
    const state = get();
    if (state.activeSessionId === sessionId && state.timeline[axis] === value) {
      set({ timeline: { ...state.timeline, [axis]: before } });
    }
    reportError(set, error);
  }
}

/**
 * Carries a runtime choice into the next conversation in this project.
 *
 * Written on the way out rather than read back here: the daemon owns what the
 * live session is doing, and this only answers "what should the next new chat
 * in this project start as".
 */
function remember(state: WorkbenchState, axes: AgentRuntimeMemory): void {
  const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
  const workspaceId = session?.workspaceId ?? state.draft?.workspaceId ?? state.activeWorkspaceId;
  const agentId = session?.agentId ?? state.draft?.agentId ?? null;
  rememberRuntimeChoice(workspaceId ?? null, agentId, axes);
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
 * The daemon pushes `titleChanged` when a session gets a name: first from
 * the user's first message, then again if an Agent extracts a better one.
 * Without this the sidebar and the tab both keep showing the "新会话"
 * placeholder they were created with until something unrelated (switching
 * workspaces, reconnecting) happens to refetch `session.list`.
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
/** Takes the status straight from a snapshot the daemon just answered with.
 *
 * Events are how the status normally moves, and they are enough right up to
 * the moment some of them do not arrive. A snapshot has no such gap in it, so
 * whenever one is in hand it wins over whatever the event stream left behind.
 */
function adoptSnapshotStatus(sessionId: string, snapshot: SessionSnapshot, set: Setter): void {
  const status = snapshot?.summary?.status;
  if (!status) return;
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && session.status !== status ? { ...session, status } : session,
    ),
  }));
}

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
    reportError(set, error);
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
    reportError(set, error);
    return undefined;
  }
}

function require_(client: Client | null): Client {
  if (!client) throw new Error("the workbench is not connected yet");
  return client;
}

/**
 * `*.batchGet` is younger than some daemons this build can be pointed at —
 * browsing an older machine through a newer web is a normal thing to do. One
 * "unknown variant" refusal tells us the daemon predates batch fetches; the
 * flag makes that client go one-by-one from then on instead of paying for a
 * refused round trip on every fill iteration.
 */
const batchGetSupport = new WeakMap<Client, boolean>();

function isUnknownVariant(error: unknown): boolean {
  return error instanceof Error && error.message.includes("unknown variant");
}

async function batchOrSequentially<T>(
  client: Client,
  batchType: "roundTrunks" | "blobs",
  batch: () => Promise<Reply | undefined>,
  sequentially: () => Promise<T[] | null>,
  set: Setter,
): Promise<T[] | null> {
  if (batchGetSupport.get(client) !== false) {
    try {
      const reply = await batch();
      if (reply?.type !== batchType) return null;
      return reply.data as T[];
    } catch (error) {
      if (!isUnknownVariant(error)) {
        reportError(set, error);
        return null;
      }
      batchGetSupport.set(client, false);
    }
  }
  try {
    return await sequentially();
  } catch (error) {
    reportError(set, error);
    return null;
  }
}
