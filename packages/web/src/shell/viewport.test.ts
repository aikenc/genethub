import { describe, expect, it } from "vitest";

import { keyboardCoveredPx } from "./viewport";

describe("keyboard coverage from the visual viewport", () => {
  it("is zero when the visual viewport fills the layout viewport", () => {
    expect(keyboardCoveredPx(800, { height: 800, offsetTop: 0 })).toBe(0);
  });

  it("is the keyboard height when the visual viewport shrinks from the bottom", () => {
    expect(keyboardCoveredPx(800, { height: 460, offsetTop: 0 })).toBe(340);
  });

  it("does not treat Safari's collapsing URL bar as a keyboard", () => {
    // Height falls from the top; offsetTop grows by the same amount.
    expect(keyboardCoveredPx(800, { height: 750, offsetTop: 50 })).toBe(0);
  });

  it("still reports the keyboard when the URL bar and keyboard are both up", () => {
    expect(keyboardCoveredPx(800, { height: 410, offsetTop: 50 })).toBe(340);
  });

  it("does not go negative mid-animation", () => {
    expect(keyboardCoveredPx(800, { height: 820, offsetTop: 0 })).toBe(0);
  });
});
