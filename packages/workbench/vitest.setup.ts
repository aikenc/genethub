import "@testing-library/jest-dom/vitest";

// The end-to-end file runs in node rather than jsdom, and there is no DOM to
// patch there.
if (typeof Element !== "undefined") {
  // jsdom implements layout as a set of zeroes and does not pretend to scroll.
  // Components that keep a view pinned to the bottom call this on every update.
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
