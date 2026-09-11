import { describe, expect, it } from "vitest";

import { channelServerProof } from "../devices/proof";
import {
  INITIAL_STREAM_WINDOW_BYTES,
  LEGACY_BULK_STREAM_WINDOW_BYTES,
  MAX_BULK_STREAM_WINDOW_BYTES,
} from "./frame";
import { preparePeerHandshake } from "./handshake";

const SECRET = "finite-bulk-handshake-secret";
const SERVER_NONCE = "ffeeddccbbaa99887766554433221100";

async function welcome(window?: number) {
  const prepared = await preparePeerHandshake({ kind: "loopback", secret: SECRET });
  const auth = prepared.hello.auth;
  if (auth.type !== "loopback") throw new Error("unexpected auth kind");
  const proof = await channelServerProof(
    SECRET,
    "loopback",
    auth.nonce,
    SERVER_NONCE,
  );
  return {
    prepared,
    value: {
      version: 3,
      serverNonce: SERVER_NONCE,
      proof,
      ...(window === undefined ? {} : { maxBulkStreamWindowBytes: window }),
    },
  };
}

describe("the peer handshake finite-bulk capability", () => {
  it("advertises that a new client can receive one complete legal Preview", async () => {
    const fixture = await welcome();
    expect(fixture.prepared.hello.maxBulkStreamWindowBytes).toBe(
      MAX_BULK_STREAM_WINDOW_BYTES,
    );
  });

  it("falls back to the legacy 256 KiB lease when the daemon omits it", async () => {
    const fixture = await welcome();
    const result = await fixture.prepared.complete(fixture.value);
    expect(result.maxBulkStreamWindowBytes).toBe(INITIAL_STREAM_WINDOW_BYTES);
  });

  it("accepts the first-rollout 8 MiB lease from an old daemon", async () => {
    const fixture = await welcome(LEGACY_BULK_STREAM_WINDOW_BYTES);
    const result = await fixture.prepared.complete(fixture.value);
    expect(result.maxBulkStreamWindowBytes).toBe(LEGACY_BULK_STREAM_WINDOW_BYTES);
  });

  it("accepts the bounded lease advertised by a new daemon", async () => {
    const fixture = await welcome(MAX_BULK_STREAM_WINDOW_BYTES);
    const result = await fixture.prepared.complete(fixture.value);
    expect(result.maxBulkStreamWindowBytes).toBe(MAX_BULK_STREAM_WINDOW_BYTES);
  });

  it("rejects an advertised lease beyond the protocol hard cap", async () => {
    const fixture = await welcome(MAX_BULK_STREAM_WINDOW_BYTES + 1);
    await expect(fixture.prepared.complete(fixture.value)).rejects.toThrow(
      "invalid finite-bulk receive lease",
    );
  });
});
