import { describe, expect, it } from "vitest";

import { channelServerProof } from "../devices/proof";
import {
  DATA_PLANE_VERSION,
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
      version: DATA_PLANE_VERSION,
      serverNonce: SERVER_NONCE,
      proof,
      ...(window === undefined ? {} : { maxBulkStreamWindowBytes: window }),
    },
  };
}

describe("the peer handshake finite-bulk capability", () => {
  it("rejects v3 before admitting a v4 stream", async () => {
    const fixture = await welcome();
    await expect(fixture.prepared.complete({ ...fixture.value, version: 3 })).rejects.toThrow("invalid data-plane welcome");
  });
  it("advertises the bounded v4 stream window", async () => {
    const fixture = await welcome();
    expect(fixture.prepared.hello.maxBulkStreamWindowBytes).toBe(
      INITIAL_STREAM_WINDOW_BYTES,
    );
  });

  it("uses the v4 default window when the field is omitted", async () => {
    const fixture = await welcome();
    const result = await fixture.prepared.complete(fixture.value);
    expect(result.maxBulkStreamWindowBytes).toBe(INITIAL_STREAM_WINDOW_BYTES);
  });

  it("rejects the old 8 MiB bulk exception", async () => {
    const fixture = await welcome(LEGACY_BULK_STREAM_WINDOW_BYTES);
    await expect(fixture.prepared.complete(fixture.value)).rejects.toThrow("invalid finite-bulk receive lease");
  });

  it("rejects the old 64 MiB bulk exception", async () => {
    const fixture = await welcome(MAX_BULK_STREAM_WINDOW_BYTES);
    await expect(fixture.prepared.complete(fixture.value)).rejects.toThrow("invalid finite-bulk receive lease");
  });

  it("rejects an advertised lease beyond the protocol hard cap", async () => {
    const fixture = await welcome(MAX_BULK_STREAM_WINDOW_BYTES + 1);
    await expect(fixture.prepared.complete(fixture.value)).rejects.toThrow(
      "invalid finite-bulk receive lease",
    );
  });
});
