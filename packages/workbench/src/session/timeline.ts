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
  text: string;
  attachments: Attachment[];
  /** When it left the composer, so a slow agent start can be named. */
  sentAtMs: number;
  /** Set only when the send definitely failed, so the text stays recoverable. */
  error: string | null;
}

export interface TimelineState {
  items: TimelineItem[];
  status: SessionStatus;
  /** The turn currently in flight, if any. */
  activeTurn: string | null;
  activeTurnStartedAtMs?: number | null;
  pendingPermission: PermissionRequest | null;
  /** The message this client has sent and not seen come back, if any. */
  pending: PendingMessage | null;
  lastError: TurnError | null;
  usage: Usage | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
  runtimeValues: Record<string, string>;
  seq: number;
  /** Every round of this session, in order, unexpanded. */
  rounds: RoundSummary[];
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
  return {
    ...emptyTimeline(),
    pending,
    items: snapshot.items,
    // Old daemon snapshots may still say `running`; the durable interaction is
    // authoritative because there is deliberately no live turn behind it.
    status: pendingPermission ? "waiting" : snapshot.summary.status,
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
    rounds: rounds.rounds,
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
        // The echo of our own message is what the placeholder was standing in
        // for. Keeping both would show the message twice. The daemon runs one
        // turn per session, so a user message arriving while we are waiting on
        // ours is ours; the reply to `session.send` clears it too, and whichever
        // arrives first is enough. Clearing pending used to put Send back on
        // the composer until `turnStarted`; the turn has already left, so the
        // durable status becomes running here.
        pending: event.item.type === "userMessage" ? null : state.pending,
        status:
          event.item.type === "userMessage" && state.status === "idle"
            ? "running"
            : state.status,
      };

    case "itemDelta":
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
      };

    case "turnFailed":
      return {
        ...state,
        activeTurn: null,
        activeTurnStartedAtMs: null,
        status: "failed",
        lastError: event.error,
      };

    case "turnCanceled":
      return { ...state, activeTurn: null, activeTurnStartedAtMs: null, status: "idle" };

    case "permissionRequested":
      return { ...state, status: "waiting", pendingPermission: event.request };

    case "permissionResolved":
      return state.pendingPermission?.id === event.requestId
        ? {
            ...state,
            status: state.activeTurn ? "running" : "idle",
            pendingPermission: null,
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

export function applySequenced(state: TimelineState, event: SequencedEvent): TimelineState {
  if (event.seq <= state.seq) return state;
  return { ...apply(state, event.event), seq: event.seq };
}

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
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
  return {
    ...item,
    status: delta.status,
    // A status delta may carry a fuller detail (output so far, an exit code).
    // When it does not, the detail we already have is still the best we know.
    detail: delta.detail ?? item.detail,
    // Tool-result images arrive with the settling delta; an empty list means
    // "nothing new", never "clear".
    images: delta.images.length > 0 ? delta.images : item.images,
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
