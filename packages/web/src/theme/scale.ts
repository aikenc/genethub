/**
 * How large this client draws itself.
 *
 * Five steps rather than a slider, because "a bit bigger" is a decision
 * people make once and then live with. Kept next to the palette on purpose:
 * both are this browser's, not the machine's. A phone that wants large type
 * should not enlarge the laptop looking at the same daemon.
 *
 * Medium is the size the workbench already was. The others are 15% `zoom`
 * steps plus 2px of type (`--gh-font-nudge` on body and the common text
 * utilities). Zoom still moves rem, px and chrome together; the nudge is
 * extra readable size without changing rem spacing. Shrinking `font-size`
 * on `<html>` itself would also move padding and drop focused fields under
 * 16px, which lets iOS zoom the page on its own.
 */

import { create } from "zustand";

export type UiScale = "xsmall" | "small" | "medium" | "large" | "xlarge";

/** Also the storage key a later boot reads before React paints. */
export const UI_SCALE_KEY = "genehub.ui-scale";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const SCALES: readonly UiScale[] = ["xsmall", "small", "medium", "large", "xlarge"];

export function readUiScale(storage: Storage | null = store()): UiScale {
  const raw = storage?.getItem(UI_SCALE_KEY);
  return raw && SCALES.includes(raw as UiScale) ? (raw as UiScale) : "medium";
}

export function applyUiScale(scale: UiScale, root?: Element | null): void {
  const element = root ?? globalThis.document?.documentElement;
  if (!element) return;
  if (scale === "medium") delete (element as HTMLElement).dataset.uiScale;
  else (element as HTMLElement).dataset.uiScale = scale;
}

interface UiScaleState {
  scale: UiScale;
  setScale(scale: UiScale): void;
}

export const useUiScale = create<UiScaleState>((set) => {
  const scale = readUiScale();
  applyUiScale(scale);
  return {
    scale,
    setScale(next) {
      store()?.setItem(UI_SCALE_KEY, next);
      applyUiScale(next);
      set({ scale: next });
    },
  };
});

/** What the appearance control shows, in the order it shows them. */
export const UI_SCALE_OPTIONS: Array<{ value: UiScale; label: string }> = [
  { value: "xsmall", label: "特小" },
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
  { value: "xlarge", label: "特大" },
];
