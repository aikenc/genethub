import type { SessionSummary } from "@genehub/proto";
import { describe, expect, it } from "vitest";

import { orderSessions, splitPinnedSessions } from "./session-order";

const session = (id: string, at: number) => ({
  id,
  workspaceId: "team",
  agentId: "genet",
  status: "idle",
  updatedAtMs: at,
  messagePreview: { itemId: `i-${id}`, text: id, atMs: at },
}) as unknown as SessionSummary;

describe("session view ordering", () => {
  it("interleaves sessions of one project by their own time", () => {
    const rows = orderSessions([session("x2", 9_580_000), session("a1", 9_590_000), session("x1", 10_000_000)]);
    expect(rows.map(s => s.id)).toEqual(["x1", "a1", "x2"]);
  });

  it("puts two new sessions of one project in front, in their own order", () => {
    const rows = orderSessions([session("a1", 8_000_000), session("x2", 9_590_000), session("x1", 10_000_000)]);
    expect(rows.map(s => s.id)).toEqual(["x1", "x2", "a1"]);
  });

  it("uses the id as a stable tie-break", () => {
    const rows = orderSessions([session("b", 9_000_000), session("a", 9_000_000)]);
    expect(rows.map(s => s.id)).toEqual(["a", "b"]);
  });

  it("falls back to the update time when there is no message preview", () => {
    const updatedOnly = { ...session("u", 0), updatedAtMs: 9_500_000, messagePreview: undefined } as unknown as SessionSummary;
    const rows = orderSessions([session("m", 9_400_000), updatedOnly]);
    expect(rows.map(s => s.id)).toEqual(["u", "m"]);
  });
});

describe("pinned session block", () => {
  it("keeps pinning out of the relative order of both blocks", () => {
    const rows = orderSessions([session("x1", 10_000_000), session("a1", 9_590_000), session("x2", 9_580_000)]);
    const { pinned, normal } = splitPinnedSessions(rows, s => s.id === "x2" || s.id === "x1");
    expect(pinned.map(s => s.id)).toEqual(["x1", "x2"]);
    expect(normal.map(s => s.id)).toEqual(["a1"]);
  });
});
