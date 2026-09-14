import type {
  Attachment,
  BlobPayload,
  PermissionRequest,
  RoundLayer,
  RoundSummary,
  RoundTrunk,
  SequencedEvent,
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  TimelineItem,
  TurnError,
  Usage,
} from "@genehub/proto";

/**
 * A message that has left the composer but that the daemon has not echoed yet.
 *
 * The daemon does not publish the user's own message until the agent process is
 * up and the prompt has been handed over (`SessionManager::start_turn`), which
 * for a cold third-party CLI is seconds — tens of them for a Cursor that has to
 * spawn, handshake and open a session. Waiting for that echo to draw the bubble
 * meant the text left the composer and nothing took its place.
 */
export interface PendingMessage {
  messageId?: string;
  taskRunId?: string;
  missingAttachments?: number;
  text: string;
  attachments: Attachment[];
  /** When it left the composer, so a slow agent start can be named. */
  sentAtMs: number;
  /** Set only when the send definitely failed, so the text stays recoverable. */
  error: string | null;
}

export interface PermissionProgress {
  requestId: string;
  stage: "submitting" | "continuing";
  message: string;
}

export interface TimelineState {
  items: TimelineItem[];
  status: SessionStatus;
  /** The turn currently in flight, if any. */
  activeTurn: string | null;
  activeTurnStartedAtMs?: number | null;
  pendingPermission: PermissionRequest | null;
  /** Human-visible acknowledgement between answering a card and turn end. */
  permissionProgress: PermissionProgress | null;
  /** The message this client has sent and not seen come back, if any. */
  pending: PendingMessage | null;
  inputOutbox?: PendingMessage[];
  lastError: TurnError | null;
  usage: Usage | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  runtimeValues: Record<string, string>;
  seq: number;
  /** Every round of this session, in order, unexpanded. */
  rounds: RoundSummary[];
  historyBefore?: string | null;
  historyWindowed?: boolean;
  historyExcerptIds?: string[];
  /** The trunk index of each round opened so far, by round id. */
  roundLayers: Record<string, RoundLayer>;
  /** Trunks pulled in full, by `roundId:trunkIndex`. */
  roundTrunks: Record<string, RoundTrunk>;
  /** Tool call and reasoning payloads pulled in full, by blob id. */
  blobs: Record<string, BlobPayload>;
}

export function emptyTimeline(): TimelineState {
  return {
    items: [],
    status: "idle",
    activeTurn: null,
    activeTurnStartedAtMs: null,
    pendingPermission: null,
    permissionProgress: null,
    pending: null,
    lastError: null,
    usage: null,
    modelId: null,
    modeId: null,
    effortId: null,
    runtimeValues: {},
    seq: 0,
    rounds: [],
    roundLayers: {},
    roundTrunks: {},
    blobs: {},
  };
}

/**
 * A snapshot replaces the timeline, but it cannot speak for a message this
 * client is still holding: `pending` is ours, the daemon has never heard of it,
 * and dropping it on a resync would take the bubble away again mid-wait.
 *
 * Process cards already on screen are kept unless the snapshot itself expands
 * the same round or trunk. A reset that starts from `emptyTimeline()` would
 * otherwise blank the only view a running turn has.
 */
export function fromSnapshot(
  snapshot: SessionSnapshot,
  pending: PendingMessage | null = null,
  previous: TimelineState | null = null,
): TimelineState {
  const pendingPermission = snapshot.pendingPermissions?.[0] ?? null;
  const rounds = roundsFromSnapshot(snapshot);
  const previousItems = new Map(previous?.items.map(item => [item.id, item]));
  const excerptIds = new Set(snapshot.historyExcerptIds ?? []);
  const items = snapshot.items.map(item => excerptIds.has(item.id) && previousItems.has(item.id) && !previous?.historyExcerptIds?.includes(item.id) ? previousItems.get(item.id)! : item);
  const retainedExcerpts = [...new Set([...(previous?.historyExcerptIds ?? []).filter(id => !snapshot.items.some(item => item.id === id)), ...(snapshot.historyExcerptIds ?? []).filter(id => !previousItems.has(id) || previous?.historyExcerptIds?.includes(id))])];
  return {
    ...emptyTimeline(),
    pending,
    inputOutbox: previous?.inputOutbox?.filter(input => !snapshot.items.some(item => item.id === input.messageId)),
    items: snapshot.historyWindowed && previous
      ? mergeHistoryItems(previous.items, items)
      : items,
    historyBefore: snapshot.historyWindowed && previous?.historyWindowed && snapshot.items.some(item => previousItems.has(item.id)) ? previous.historyBefore : snapshot.historyBefore,
    historyWindowed: snapshot.historyWindowed,
    historyExcerptIds: retainedExcerpts,
    // Old daemon snapshots may still say `running`; the durable interaction is
    // authoritative because there is deliberately no live turn behind it.
    status: pendingPermission && !snapshot.summary.inputSummary ? "waiting" : snapshot.summary.status,
    // The request the agent is waiting on. Dropping it was a hang the user could
    // not get out of: after a reconnect too old to replay, the snapshot is all
    // there is, so a session paused for approval came back with no card to
    // approve and a turn that would never move again. There is at most one at a
    // time today; the first is taken rather than asserted about, because the
    // wrong one on screen is better than none.
    // Optional access: an older daemon, or a hand-built snapshot, simply has
    // no such array — and losing the whole session view over a missing field
    // is worse than the hang this fixes.
    pendingPermission,
    modelId: snapshot.summary.modelId ?? null,
    modeId: snapshot.summary.modeId ?? null,
    effortId: snapshot.summary.effortId ?? null,
    runtimeValues: Object.fromEntries(
      Object.entries(snapshot.summary.runtimeValues ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    seq: snapshot.seq,
    rounds: snapshot.historyWindowed && previous
      ? [...new Map([...previous.rounds, ...rounds.rounds].map(round => [round.roundId, round])).values()].sort((a,b) => a.startedAtMs - b.startedAtMs)
      : rounds.rounds,
    roundLayers: previous
      ? { ...previous.roundLayers, ...rounds.roundLayers }
      : rounds.roundLayers,
    roundTrunks: previous
      ? { ...previous.roundTrunks, ...rounds.roundTrunks }
      : rounds.roundTrunks,
    blobs: previous ? previous.blobs : {},
  };
}

/**
 * The round layer a snapshot arrives with: every round unexpanded, plus
 * whichever one the daemon was asked to expand.
 */
function roundsFromSnapshot(
  snapshot: SessionSnapshot,
): Pick<TimelineState, "rounds" | "roundLayers" | "roundTrunks"> {
  const roundLayers: Record<string, RoundLayer> = {};
  const roundTrunks: Record<string, RoundTrunk> = {};
  const expanded = snapshot.expandedRound;
  if (expanded) {
    roundLayers[expanded.round.roundId] = expanded;
    if (expanded.expandedTrunk) {
      roundTrunks[`${expanded.round.roundId}:${expanded.expandedTrunk.summary.index}`] =
        expanded.expandedTrunk;
    }
  }
  return { rounds: snapshot.rounds ?? [], roundLayers, roundTrunks };
}

/**
 * Applies one event.
 *
 * Two rules the daemon guarantees and this relies on:
 *
 * `Item` is an upsert, not an append — an assistant message arrives empty when
 * it starts and again complete when it ends, under the same id. Appending both
 * would show the reply twice.
 *
 * `ItemDelta` only ever touches an item that already arrived. A delta for an
 * unknown id means events were lost, and dropping it silently would leave a
 * half-rendered message; it is ignored here and the sequence check in the
 * client is what catches the real problem.
 */
export function apply(state: TimelineState, event: SessionEvent): TimelineState {
  switch (event.type) {
    case "turnStarted":
      return {
        ...state,
        activeTurn: event.turnId,
        activeTurnStartedAtMs: event.startedAtMs || Date.now(),
        status: "running",
        lastError: null,
        usage: null,
      };

    case "item":
      return {
        ...state,
        items: upsert(state.items, event.item),
        pending: event.item.type === "userMessage" && (!state.pending?.messageId || state.pending.messageId === event.item.id) ? null : state.pending,
        inputOutbox: event.item.type === "userMessage" ? state.inputOutbox?.filter(input => input.messageId !== event.item.id) : state.inputOutbox,
        // A durable admission is a session item, with no adapter turn yet.
        status: event.item.type === "userMessage" && event.turnId && state.status === "idle" ? "running" : state.status,
        permissionProgress: state.permissionProgress,
      };

    case "itemDelta":
      if (state.historyExcerptIds?.includes(event.itemId)) return state;
      return { ...state, items: applyDelta(state.items, event) };

    case "turnProgress":
      return { ...state, usage: event.usage };

    case "turnCompleted":
      return {
        ...state,
        activeTurn: null,
        activeTurnStartedAtMs: null,
        status: "idle",
        usage: event.usage,
        permissionProgress: null,
      };

    case "turnFailed":
      return {
        ...state,
        activeTurn: null,
        activeTurnStartedAtMs: null,
        status: "failed",
        lastError: event.error,
        permissionProgress: null,
      };

    case "turnCanceled":
      return {
        ...state,
        activeTurn: null,
        activeTurnStartedAtMs: null,
        status: "idle",
        permissionProgress: null,
      };

    case "permissionRequested":
      return {
        ...state,
        status: "waiting",
        pendingPermission: event.request,
        permissionProgress: null,
      };

    case "permissionResolved":
      return state.pendingPermission?.id === event.requestId
        ? {
            ...state,
            status: state.activeTurn ? "running" : "idle",
            pendingPermission: null,
            permissionProgress: {
              requestId: event.requestId,
              stage: "continuing",
              message: permissionResolutionMessage(state.pendingPermission, event.outcome),
            },
          }
        : state;

    case "modelChanged":
      return { ...state, modelId: event.modelId };

    case "modeChanged":
      return { ...state, modeId: event.modeId };

    case "effortChanged":
      return { ...state, effortId: event.effortId };

    case "runtimeAxisChanged":
      return {
        ...state,
        runtimeValues: { ...state.runtimeValues, [event.axisId]: event.valueId },
      };

    // Not part of the timeline itself; the session list and its tab title
    // are what change, handled by the store where it has access to them.
    case "titleChanged":
      return state;

    case "sessionStatusChanged":
      return { ...state, status: event.status };
  }
}

function permissionResolutionMessage(
  request: PermissionRequest,
  outcome: Extract<SessionEvent, { type: "permissionResolved" }>["outcome"],
): string {
  if (outcome.outcome === "timedOut" && outcome.appliedDefault === "refreshPlan") {
    return "原计划已过期，正在重新核对并生成新的确认。";
  }
  if (outcome.outcome === "timedOut") return "确认已超时；任务不会继续执行。";
  if (outcome.outcome === "canceled") return "已取消；任务不会继续执行。";
  if (outcome.outcome === "answered") return "回答已提交，Agent 正在继续执行。";

  const option = request.options.find((candidate) => candidate.id === outcome.optionId);
  if (option?.kind === "reject") return "已拒绝；Agent 正在安全结束本次任务。";
  if (request.kind === "planApproval") return "计划确认已保存，等待 Agent 恢复执行。";
  return "授权已接受，Agent 正在继续执行。";
}

export function applySequenced(state: TimelineState, event: SequencedEvent): TimelineState {
  if (event.seq <= state.seq) return state;
  return { ...apply(state, event.event), seq: event.seq };
}

function earlierMs(left?: number, right?: number): number | undefined {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const existing = items[index]!;
  const next = items.slice();
  next[index] =
    item.type === "toolCall" && existing.type === "toolCall"
      ? {
          ...item,
          startedAtMs: earlierMs(item.startedAtMs, existing.startedAtMs),
          finishedAtMs: earlierMs(item.finishedAtMs, existing.finishedAtMs),
        }
      : item;
  return next;
}

function applyDelta(
  items: TimelineItem[],
  event: Extract<SessionEvent, { type: "itemDelta" }>,
): TimelineItem[] {
  const index = items.findIndex((item) => item.id === event.itemId);
  if (index === -1) return items;

  const target = items[index]!;
  const updated = withDelta(target, event.delta);
  if (updated === target) return items;

  const next = items.slice();
  next[index] = updated;
  return next;
}

function withDelta(item: TimelineItem, delta: ItemDeltaOf): TimelineItem {
  if (delta.kind === "text") {
    if (item.type === "assistantMessage" || item.type === "reasoning") {
      return { ...item, text: item.text + delta.delta };
    }
    return item;
  }

  if (item.type !== "toolCall") return item;
  const terminal = delta.status === "ok" || delta.status === "error" || delta.status === "canceled";
  return {
    ...item,
    status: delta.status,
    // A status delta may carry a fuller detail (output so far, an exit code).
    // When it does not, the detail we already have is still the best we know.
    detail: delta.detail ?? item.detail,
    // Tool-result images arrive with the settling delta; an empty list means
    // "nothing new", never "clear".
    images: delta.images.length > 0 ? delta.images : item.images,
    finishedAtMs:
      item.finishedAtMs ?? (terminal && item.startedAtMs != null ? Date.now() : item.finishedAtMs),
  };
}

type ItemDeltaOf = Extract<SessionEvent, { type: "itemDelta" }>["delta"];

/** The text of every assistant bubble, in order. Used by tests and search. */
export function assistantText(state: TimelineState): string {
  return state.items
    .filter((item): item is Extract<TimelineItem, { type: "assistantMessage" }> =>
      item.type === "assistantMessage",
    )
    .map((item) => item.text)
    .join("");
}

/** Earlier page first; live/current copies win on overlap. Stable IDs survive reconnects. */
export function mergeHistoryItems(earlier: TimelineItem[], current: TimelineItem[]): TimelineItem[] {
  return [...new Map([...earlier, ...current].map(item => [item.id, item])).values()];
}

/** Insert a previous page at its cursor, including a gap between two retained windows. */
export function insertHistoryPage(current: TimelineItem[], page: TimelineItem[], beforeId: string): TimelineItem[] {
  const result = [...current];
  let anchor = beforeId;
  for (const item of [...page].reverse()) {
    if (!result.some(entry => entry.id === item.id)) {
      const at = result.findIndex(entry => entry.id === anchor);
      result.splice(at < 0 ? 0 : at, 0, item);
    }
    anchor = item.id;
  }
  return result;
}
