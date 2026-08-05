import { describe, expect, it } from "vitest";

import {
  decodeFabricFrame,
  decodeFabricOpenPayload,
  encodeFabricFrame,
  encodeFabricOpenPayload,
  FABRIC_HEADER_BYTES,
  FABRIC_MAX_OPERATION_METADATA_BYTES,
  FABRIC_MAX_ROUTE_TICKET_BYTES,
  FABRIC_ZERO_STREAM_ID,
  FabricKind,
  newFabricStreamId,
} from "./frame";

const id = "000102030405060708090a0b0c0d0e0f";
const bytes = (...values: number[]) => new Uint8Array(values);

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("the browser Fabric v2 frame codec", () => {
  it("matches the relay's fixed-width golden vector without Buffer", () => {
    const encoded = encodeFabricFrame({
      kind: FabricKind.Data,
      streamId: id,
      value: 1n,
      payload: new TextEncoder().encode("hi"),
    });

    expect(hex(encoded)).toBe(
      "02040000000102030405060708090a0b0c0d0e0f00000000000000016869",
    );
    const decoded = decodeFabricFrame(encoded);
    expect(decoded).toMatchObject({
      kind: FabricKind.Data,
      flags: 0,
      streamId: id,
      value: 1n,
    });
    expect([...decoded!.payload]).toEqual([...new TextEncoder().encode("hi")]);
  });

  it("decodes a view at a non-zero offset and gives the caller owned payload bytes", () => {
    const frame = encodeFabricFrame({
      kind: FabricKind.Accept,
      streamId: id,
      value: 0n,
      payload: bytes(7, 8, 9),
    });
    const storage = new Uint8Array(frame.byteLength + 6);
    storage.set(frame, 3);
    const decoded = decodeFabricFrame(storage.subarray(3, 3 + frame.byteLength));
    expect(decoded?.payload).toEqual(bytes(7, 8, 9));

    storage.fill(0);
    expect(decoded?.payload).toEqual(bytes(7, 8, 9));
  });

  it("keeps the route ticket bounded UTF-8 and the hello completely opaque", () => {
    const hello = bytes(0, 255, 4, 0);
    const payload = encodeFabricOpenPayload("路由-ticket", hello);

    const decoded = decodeFabricOpenPayload(payload);
    expect(decoded).toEqual({
      routeTicket: "路由-ticket",
      opaqueHello: hello,
    });
    const decodedHello = decoded?.opaqueHello;
    payload.fill(0);
    // The decoder copied the hello instead of lending out its input storage.
    expect(decodedHello).toEqual(bytes(0, 255, 4, 0));
  });

  it("rejects malformed versions, flags, ids, lengths and UTF-8", () => {
    expect(decodeFabricFrame(new Uint8Array(FABRIC_HEADER_BYTES - 1))).toBeNull();

    const wrongVersion = encodeFabricFrame({
      kind: FabricKind.Data,
      streamId: id,
      value: 1n,
      payload: bytes(),
    });
    wrongVersion[0] = 1;
    expect(decodeFabricFrame(wrongVersion)).toBeNull();

    const flags = encodeFabricFrame({
      kind: FabricKind.Data,
      streamId: id,
      value: 1n,
      payload: bytes(),
    });
    flags[2] = 1;
    expect(decodeFabricFrame(flags)).toBeNull();

    expect(() =>
      encodeFabricFrame({
        kind: FabricKind.Data,
        streamId: FABRIC_ZERO_STREAM_ID,
        value: 1n,
        payload: bytes(),
      }),
    ).toThrow(/control and operation/);
    expect(() =>
      encodeFabricFrame({
        kind: FabricKind.Ping,
        streamId: id,
        value: 1n,
        payload: bytes(),
      }),
    ).toThrow(/control and operation/);

    expect(decodeFabricOpenPayload(bytes(0, 0))).toBeNull();
    expect(decodeFabricOpenPayload(bytes(0, 4, 0x61))).toBeNull();
    expect(decodeFabricOpenPayload(bytes(0, 1, 0xff))).toBeNull();
    expect(() =>
      encodeFabricOpenPayload("x".repeat(FABRIC_MAX_ROUTE_TICKET_BYTES + 1), bytes()),
    ).toThrow(/1\.\.4096/);
  });

  it("never returns zero even when the random source does so once", () => {
    let attempt = 0;
    const streamId = newFabricStreamId((target) => {
      if (attempt > 0) target[target.length - 1] = 9;
      attempt += 1;
    });

    expect(streamId).toBe("00000000000000000000000000000009");
    expect(attempt).toBe(2);
  });

  it("bounds opaque OPEN metadata while accepting the exact boundary", () => {
    const boundary = encodeFabricOpenPayload(
      "ticket",
      new Uint8Array(FABRIC_MAX_OPERATION_METADATA_BYTES),
    );
    expect(decodeFabricOpenPayload(boundary)?.opaqueHello.byteLength).toBe(
      FABRIC_MAX_OPERATION_METADATA_BYTES,
    );
    expect(() =>
      encodeFabricOpenPayload(
        "ticket",
        new Uint8Array(FABRIC_MAX_OPERATION_METADATA_BYTES + 1),
      ),
    ).toThrow(/operation metadata/);
    const oversized = new Uint8Array(boundary.byteLength + 1);
    oversized.set(boundary);
    expect(decodeFabricOpenPayload(oversized)).toBeNull();
  });

  it("refuses a random source that can only produce the reserved zero id", () => {
    expect(() => newFabricStreamId(() => {})).toThrow(/repeatedly produced a zero/);
  });
});
