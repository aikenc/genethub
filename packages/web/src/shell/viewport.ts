/**
 * How much of the window the on-screen keyboard is covering, as a CSS variable.
 *
 * The shell is a fixed box the size of the layout viewport (`theme.css`), which
 * is what stops iOS scrolling the whole page to reveal a focused field. The
 * cost of that is that the keyboard then covers the bottom of the box instead
 * of pushing it up, so the composer would be typed into from behind the
 * keyboard. Safari does not honour `interactive-widget=resizes-content`, and
 * the visual viewport is the only thing that knows the keyboard is there at
 * all.
 *
 * Published as `--keyboard` rather than through React state on purpose: this
 * changes on every frame of the keyboard's animation, and a re-render of the
 * timeline at that rate is visible.
 */
export function watchViewport(): () => void {
  const viewport = globalThis.visualViewport;
  const root = globalThis.document?.documentElement;
  if (!viewport || !root) return () => {};

  const apply = () => {
    // Negative on the frames where the two disagree mid-animation, and a
    // negative inset would lift the composer off the bottom of the screen.
    const covered = Math.max(0, globalThis.innerHeight - viewport.height);
    root.style.setProperty("--keyboard", `${Math.round(covered)}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  // The visual viewport also moves without resizing — a pinch, or the moment
  // Safari decides to scroll it anyway — and the keyboard is still there.
  viewport.addEventListener("scroll", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    root.style.removeProperty("--keyboard");
  };
}
