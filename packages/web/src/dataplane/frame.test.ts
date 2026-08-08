import { describe, expect, it } from "vitest";

import {
  DATA_FRAME_HEADER_BYTES,
  DataKind,
  decodeDataFrame,
  encodeDataFrame,
  MAX_DATA_PAYLOAD_BYTES,
} from "./frame";

describe("data-plane frames", () => {
  it("round-trips the cross-language binary shape", () => {
    const wire = encodeDataFrame({
      kind: DataKind.Data,
      streamId: 0x0102_0304,
      value: 0x0506_0708,
      payload: new Uint8Array([0x61, 0x62, 0x63]),
    });
    expect([...wire]).toEqual([
      3, 3, 0, 0,
      1, 2, 3, 4,
      5, 6, 7, 8,
      0, 0, 0, 3,
      0x61, 0x62, 0x63,
    ]);
    expect(decodeDataFrame(wire)).toEqual({
      kind: DataKind.Data,
      streamId: 0x0102_0304,
      value: 0x0506_0708,
      payload: new Uint8Array([0x61, 0x62, 0x63]),
    });
  });

  it("pins the complete secure record below 16 KiB", () => {
    const wire = encodeDataFrame({
      kind: DataKind.Data,
      streamId: 1,
      value: 1,
      payload: new Uint8Array(MAX_DATA_PAYLOAD_BYTES),
    });
    expect(wire.byteLength).toBe(DATA_FRAME_HEADER_BYTES + MAX_DATA_PAYLOAD_BYTES);
    expect(() =>
      encodeDataFrame({
        kind: DataKind.Data,
        streamId: 1,
        value: 1,
        payload: new Uint8Array(MAX_DATA_PAYLOAD_BYTES + 1),
      }),
    ).toThrow(/16 KiB/);
  });

  it("rejects noncanonical and control-stream frames", () => {
    const wire = encodeDataFrame({
      kind: DataKind.Fin,
      streamId: 1,
      value: 0,
      payload: new Uint8Array(),
    });
    wire[2] = 1;
    expect(decodeDataFrame(wire)).toBeNull();
    expect(() =>
      encodeDataFrame({
        kind: DataKind.Ping,
        streamId: 1,
        value: 1,
        payload: new Uint8Array(),
      }),
    ).toThrow(/stream zero/);
  });
});
