import type {
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

export interface TimelineState {
  items: TimelineItem[];
  status: SessionStatus;
  /** The turn currently in flight, if any. */
  activeTurn: string | null;
  activeTurnStartedAtMs?: number | null;
  pendingPermission: PermissionRequest | null;
  lastError: TurnError | null;
  usage: Usage | null;
  modelId: string | null;
  modeId: string | null;
  effortId: string | null;
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
    lastError: null,
    usage: null,
    modelId: null,
    modeId: null,
    effortId: null,
    seq: 0,
    rounds: [],
    roundLayers: {},
    roundTrunks: {},
    blobs: {},
  };
}

export function fromSnapshot(snapshot: SessionSnapshot): TimelineState {
  const pendingPermission = snapshot.pendingPermissions?.[0] ?? null;
  return {
    ...emptyTimeline(),
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
    seq: snapshot.seq,
    ...roundsFromSnapshot(snapshot),
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
      };

    case "item":
      return { ...state, items: upsert(state.items, event.item) };

    case "itemDelta":
      return { ...state, items: applyDelta(state.items, event) };

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
