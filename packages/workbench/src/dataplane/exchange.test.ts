import { afterEach, describe, expect, it, vi } from "vitest";

import { DataPlaneError } from "./endpoint";
import { collectBodyExact } from "./exchange";

const chunk = (...bytes: number[]) => new Uint8Array(bytes);

afterEach(() => vi.useRealTimers());

describe("exact finite exchange bodies", () => {
  it("writes chunks directly into the declared final allocation", async () => {
    async function* body() {
      yield chunk(1, 2);
      yield chunk(3);
      yield chunk(4, 5);
    }

    expect(await collectBodyExact(body(), 5, 8)).toEqual(chunk(1, 2, 3, 4, 5));
  });

  it("rejects both truncated and overlong bodies", async () => {
    async function* shortBody() {
      yield chunk(1);
    }
    async function* longBody() {
      yield chunk(1, 2, 3);
    }

    await expect(collectBodyExact(shortBody(), 2, 8)).rejects.toThrow(
      "ended before its exact length",
    );
    await expect(collectBodyExact(longBody(), 2, 8)).rejects.toThrow(
      "exceeds its exact length",
    );
  });

  it("renews the stall deadline on progress instead of imposing a total deadline", async () => {
    vi.useFakeTimers();
    async function* body() {
      await new Promise((resolve) => setTimeout(resolve, 600));
      yield chunk(1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      yield chunk(2);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    const collecting = collectBodyExact(body(), 2, 2, { stallTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_800);
    await expect(collecting).resolves.toEqual(chunk(1, 2));
  });

  it("cancels a body that makes no progress", async () => {
    vi.useFakeTimers();
    let stalled = 0;
    const never = new Promise<void>(() => {});
    async function* body() {
      await never;
      yield chunk(1);
    }

    const collecting = collectBodyExact(body(), 1, 1, {
      stallTimeoutMs: 1_000,
      onStall: () => {
        stalled += 1;
      },
    });
    const rejected = expect(collecting).rejects.toBeInstanceOf(DataPlaneError);
    await vi.advanceTimersByTimeAsync(1_001);
    await rejected;
    expect(stalled).toBe(1);
  });
});
