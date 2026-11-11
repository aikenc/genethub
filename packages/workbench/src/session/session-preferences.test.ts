import { beforeEach, describe, expect, it } from "vitest";

import { sessionPinned, setSessionPinned } from "./session-preferences";

describe("local session pinning", () => {
  beforeEach(() => localStorage.clear());

  it("is off by default", () => {
    expect(sessionPinned("m1", "s1")).toBe(false);
  });

  it("remembers a pin and clears it again", () => {
    setSessionPinned("m1", "s1", true);
    expect(sessionPinned("m1", "s1")).toBe(true);
    setSessionPinned("m1", "s1", false);
    expect(sessionPinned("m1", "s1")).toBe(false);
  });

  it("keeps the same session id independent on another machine", () => {
    setSessionPinned("m1", "s1", true);
    expect(sessionPinned("m2", "s1")).toBe(false);
  });
});
