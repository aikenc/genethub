import { describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { loadSessionImage } from "./imagePreviewRequests";

describe("session image requests", () => {
  it("shares a simultaneous thumbnail read without cancelling the remaining viewer", async () => {
    let complete: ((value: { metadata: { kind: "image"; mediaType: string }; bytes: Uint8Array }) => void) | undefined;
    const preview = vi.fn((_workspace: string, _path: string, _tier: string, signal: AbortSignal) =>
      new Promise<{ metadata: { kind: "image"; mediaType: string }; bytes: Uint8Array }>((resolve) => {
        complete = resolve;
        expect(signal.aborted).toBe(false);
      }),
    );
    const client = { preview } as unknown as Client;
    const firstAbort = new AbortController();
    const first = loadSessionImage(client, "workspace", "r_root/picture.png", firstAbort.signal);
    const second = loadSessionImage(client, "workspace", "r_root/picture.png");
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith("workspace", "r_root/picture.png", "image-128", expect.any(AbortSignal));
    firstAbort.abort();
    expect(await first).toBeNull();
    const sharedSignal = preview.mock.calls[0]![3];
    expect(sharedSignal.aborted).toBe(false);
    complete?.({ metadata: { kind: "image", mediaType: "image/png" }, bytes: new Uint8Array([1, 2, 3]) });
    expect(await second).toEqual({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
  });
});
