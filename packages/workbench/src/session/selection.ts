import type { TimelineItem } from "@genehub/proto";

/** Hard cap on one forwarded/copied selection (user + assistant messages). */
export const MAX_FORWARD_SELECTION = 30;

/** One selectable narrative bubble, in timeline render order. */
export interface SelectableMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Attachments are listed by name/mime only; payloads never travel. */
  attachments: { name: string; mime: string }[];
}

export function toSelectable(
  item: Extract<TimelineItem, { type: "userMessage" | "assistantMessage" }>,
): SelectableMessage {
  return {
    id: item.id,
    role: item.type === "userMessage" ? "user" : "assistant",
    text: item.text,
    attachments:
      item.type === "userMessage"
        ? item.attachments.map((attachment) => ({
            name: attachment.name,
            mime: attachment.mime,
          }))
        : [],
  };
}

export function isSelectableItem(
  item: TimelineItem,
): item is Extract<TimelineItem, { type: "userMessage" | "assistantMessage" }> {
  return item.type === "userMessage" || item.type === "assistantMessage";
}

/**
 * Selection-mode state: the checked set plus at most one anchor.
 *
 * The anchor is what makes "pick a start and an end" the default gesture
 * without a modifier key: the first click checks one message and anchors it,
 * the second click on another message checks the whole range between them.
 * Clicking a checked message always unchecks it (反选) and never moves the
 * anchor, so ranges and single toggles alternate naturally.
 */
export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const emptySelection = (): SelectionState => ({ selected: new Set(), anchor: null });

export interface SelectionStep {
  next: SelectionState;
  /** User-facing hint, e.g. when the cap truncated a range. */
  notice: string | null;
}

export function applySelectionClick(
  state: SelectionState,
  clickedId: string,
  order: readonly string[],
  limit: number = MAX_FORWARD_SELECTION,
): SelectionStep {
  if (state.selected.has(clickedId)) {
    const selected = new Set(state.selected);
    selected.delete(clickedId);
    return { next: { selected, anchor: state.anchor }, notice: null };
  }

  const anchor = state.anchor;
  const anchorIndex = anchor ? order.indexOf(anchor) : -1;
  const clickedIndex = order.indexOf(clickedId);
  if (anchor !== null && anchorIndex !== -1 && clickedIndex !== -1 && anchor !== clickedId) {
    const [from, to] =
      anchorIndex < clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
    const selected = new Set(state.selected);
    let truncated = false;
    for (let index = from; index <= to; index += 1) {
      const id = order[index]!;
      if (selected.has(id)) continue;
      if (selected.size >= limit) {
        truncated = true;
        break;
      }
      selected.add(id);
    }
    return {
      next: { selected, anchor: null },
      notice: truncated ? `已达上限 ${limit} 条，超出部分未选中` : null,
    };
  }

  if (state.selected.size >= limit) {
    return { next: state, notice: `已达上限 ${limit} 条` };
  }
  const selected = new Set(state.selected);
  selected.add(clickedId);
  return { next: { selected, anchor: clickedId }, notice: null };
}

/** Checks every id in one turn, bounded by the same cap as range selection. */
export function applySelectionAddMany(
  state: SelectionState,
  ids: readonly string[],
  limit: number = MAX_FORWARD_SELECTION,
): SelectionStep {
  const selected = new Set(state.selected);
  let truncated = false;
  for (const id of ids) {
    if (selected.has(id)) continue;
    if (selected.size >= limit) {
      truncated = true;
      break;
    }
    selected.add(id);
  }
  return {
    next: { selected, anchor: state.anchor },
    notice: truncated ? `已达上限 ${limit} 条，超出部分未选中` : null,
  };
}

/**
 * The action bar's running estimate, in the same unit the daemon uses
 * (`chars / 4`, `context_seed.rs`). It deliberately counts only the selected
 * bodies plus per-message structure, so it is a lower bound: round/trunk
 * summary layers are pulled in later, inside the forward dialog.
 */
export const SELECTION_STRUCTURE_CHARS = 40;

export function estimateSelectionTokens(messages: readonly SelectableMessage[]): number {
  const chars = messages.reduce(
    (total, message) => total + message.text.length + SELECTION_STRUCTURE_CHARS,
    0,
  );
  return Math.ceil(chars / 4);
}
