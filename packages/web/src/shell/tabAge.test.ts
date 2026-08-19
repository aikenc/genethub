import { describe, expect, it } from "vitest";

import { compactAge } from "./tabAge";

const NOW = Date.parse("2026-08-18T12:00:00Z");

describe("compactAge", () => {
  it("stays off until a minute has passed, then uses m/h/d", () => {
    expect(compactAge(undefined, NOW)).toBeNull();
    expect(compactAge(0, NOW)).toBeNull();
    expect(compactAge(NOW - 59_000, NOW)).toBeNull();
    expect(compactAge(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(compactAge(NOW - 2 * 60 * 60_000, NOW)).toBe("2h");
    expect(compactAge(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3d");
  });
});
