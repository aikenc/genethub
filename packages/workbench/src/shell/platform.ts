/**
 * iOS "added to Home Screen" runs as a standalone web app where window.open
 * cannot leave the app shell: same-scope pages open without any browser
 * chrome (no close button, only the edge-swipe gesture), and no web API can
 * reach Safari. The Preview float detects this and offers a copyable link
 * instead of a dead-end new window.
 */
export function isIosStandalonePwa(
  nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> & {
    standalone?: boolean;
  } = navigator,
  matchesStandalone: () => boolean = () =>
    window.matchMedia?.("(display-mode: standalone)").matches ?? false,
): boolean {
  const ios =
    /iP(hone|ad|od)/.test(nav.userAgent) ||
    // iPadOS reports as Macintosh; touch points are the give-away.
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  return ios && (nav.standalone === true || matchesStandalone());
}
