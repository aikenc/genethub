/**
 * How much of the window the on-screen keyboard is covering, as a CSS variable.
 *
 * The fixed shell follows the dynamic viewport. Only the part still obscured
 * by an overlay keyboard becomes composer padding. Resizing keyboards already
 * reduce the shell; pinch zoom is not keyboard coverage. All coordinates are
 * converted to the current UI zoom before entering CSS.
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
    const focused = document.activeElement;
    const editing = focused instanceof HTMLElement &&
      (focused.matches("input, textarea") || focused.isContentEditable);
    const zoom = Number.parseFloat(getComputedStyle(root).zoom) || 1;
    // Body uses the dynamic viewport. Measure its actual lower edge so Chrome
    // resizes-content and Safari overlay keyboards do not compensate twice.
    const bottom = document.body.getBoundingClientRect().bottom;
    root.style.setProperty(
      "--keyboard",
      `${editing && Math.abs(viewport.scale - 1) < 0.01 ? keyboardCoveredPx(bottom, viewport) / zoom : 0}px`,
    );
  };

  apply();
  viewport.addEventListener("resize", apply);
  // The visual viewport also moves without resizing — a pinch, or the moment
  // Safari decides to scroll it anyway — and the keyboard is still there.
  viewport.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("pageshow", apply);
  document.addEventListener("focusin", apply);
  document.addEventListener("focusout", apply);
  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ["data-ui-scale"] });
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    window.removeEventListener("resize", apply);
    window.removeEventListener("pageshow", apply);
    document.removeEventListener("focusin", apply);
    document.removeEventListener("focusout", apply);
    observer.disconnect();
    root.style.removeProperty("--keyboard");
  };
}

/**
 * Gap between the layout viewport's bottom edge and the visual viewport's.
 *
 * Safari's collapsing URL bar shrinks `height` from the top and grows
 * `offsetTop` by the same amount. That is not keyboard coverage; treating it
 * as one lifts the composer off the screen and leaves a strip of transcript
 * showing under the card. Negative values happen mid-animation.
 */
export function keyboardCoveredPx(
  innerHeight: number,
  viewport: Pick<VisualViewport, "height" | "offsetTop">,
): number {
  return Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
}
