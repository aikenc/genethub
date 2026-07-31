/**
 * Everything the workbench needs done to the window before it renders.
 *
 * This runs as a side effect of importing the package, and that is the whole
 * point. It used to live in this package's own `main.tsx`, which is one of two
 * entry points — the other is the cloud console in a different repository,
 * which imports `App` and mounts it itself. That copy therefore ran none of it:
 * no theme (the page was whatever class `index.html` happened to carry, and the
 * appearance control in settings did nothing), and no keyboard inset, so on a
 * phone the composer sat behind the keyboard. Neither is visible to anyone
 * working in this repository, because the entry point here does call it.
 *
 * So it is not something a host is asked to remember. Importing `@genehub/web`
 * is what a host does by definition, and this comes with it.
 *
 * Before the first paint, not in an effect: the stylesheet is render-blocking
 * and module side effects run after it and before React puts anything on
 * screen, so the very first frame already has the right palette. An effect
 * would paint one frame of the other one on every launch.
 */

import { watchViewport } from "./shell/viewport";
import { applyTheme, useTheme, watchSystemTheme } from "./theme/store";

let booted = false;

/**
 * Idempotent, because a bundler can evaluate a module twice — two copies of the
 * package in one graph, or a dev server hot-replacing this file — and a second
 * viewport listener would be a leak nobody would ever look for.
 */
export function boot(): void {
  if (booted || !globalThis.document) return;
  booted = true;

  applyTheme(useTheme.getState().resolved);
  watchSystemTheme((theme) => useTheme.getState().systemChanged(theme));
  // Belongs to the window, not to any component: the keyboard can arrive while
  // any pane is open, and every one of them is inside the same fixed box.
  watchViewport();
}

boot();
