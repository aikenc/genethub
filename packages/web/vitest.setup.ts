import "@testing-library/jest-dom/vitest";

// jsdom implements layout as a set of zeroes and does not pretend to scroll.
// Components that keep a view pinned to the bottom call this on every update.
Element.prototype.scrollIntoView = function scrollIntoView() {};
