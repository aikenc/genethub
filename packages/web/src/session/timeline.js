export function emptyTimeline() {
    return {
        items: [],
        status: "idle",
        activeTurn: null,
        pendingPermission: null,
        lastError: null,
        usage: null,
        modelId: null,
        modeId: null,
        seq: 0,
    };
}
export function fromSnapshot(snapshot) {
    return {
        ...emptyTimeline(),
        items: snapshot.items,
        status: snapshot.summary.status,
        modelId: snapshot.summary.modelId ?? null,
        modeId: snapshot.summary.modeId ?? null,
        seq: snapshot.seq,
    };
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
export function apply(state, event) {
    switch (event.type) {
        case "turnStarted":
            return { ...state, activeTurn: event.turnId, status: "running", lastError: null };
        case "item":
            return { ...state, items: upsert(state.items, event.item) };
        case "itemDelta":
            return { ...state, items: applyDelta(state.items, event) };
        case "turnCompleted":
            return { ...state, activeTurn: null, status: "idle", usage: event.usage };
        case "turnFailed":
            return { ...state, activeTurn: null, status: "idle", lastError: event.error };
        case "turnCanceled":
            return { ...state, activeTurn: null, status: "idle" };
        case "permissionRequested":
            return { ...state, pendingPermission: event.request };
        case "permissionResolved":
            return state.pendingPermission?.id === event.requestId
                ? { ...state, pendingPermission: null }
                : state;
        case "modelChanged":
            return { ...state, modelId: event.modelId };
        case "modeChanged":
            return { ...state, modeId: event.modeId };
        case "sessionStatusChanged":
            return { ...state, status: event.status };
    }
}
export function applySequenced(state, event) {
    if (event.seq <= state.seq)
        return state;
    return { ...apply(state, event.event), seq: event.seq };
}
function upsert(items, item) {
    const index = items.findIndex((existing) => existing.id === item.id);
    if (index === -1)
        return [...items, item];
    const next = items.slice();
    next[index] = item;
    return next;
}
function applyDelta(items, event) {
    const index = items.findIndex((item) => item.id === event.itemId);
    if (index === -1)
        return items;
    const target = items[index];
    const updated = withDelta(target, event.delta);
    if (updated === target)
        return items;
    const next = items.slice();
    next[index] = updated;
    return next;
}
function withDelta(item, delta) {
    if (delta.kind === "text") {
        if (item.type === "assistantMessage" || item.type === "reasoning") {
            return { ...item, text: item.text + delta.delta };
        }
        return item;
    }
    if (item.type !== "toolCall")
        return item;
    return {
        ...item,
        status: delta.status,
        // A status delta may carry a fuller detail (output so far, an exit code).
        // When it does not, the detail we already have is still the best we know.
        detail: delta.detail ?? item.detail,
    };
}
/** The text of every assistant bubble, in order. Used by tests and search. */
export function assistantText(state) {
    return state.items
        .filter((item) => item.type === "assistantMessage")
        .map((item) => item.text)
        .join("");
}
