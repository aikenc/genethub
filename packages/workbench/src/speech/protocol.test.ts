import { describe, expect, it } from "vitest";

import {
  MAX_SPEECH_FRAME_PAYLOAD_BYTES,
  SpeechFrameDecoder,
  SpeechFrameKind,
  encodeSpeechAudio,
  encodeSpeechFrame,
  encodeSpeechJson,
} from "./protocol";

describe("speech protocol framing", () => {
  it("matches the Rust cross-language golden vector", () => {
    expect(Array.from(encodeSpeechAudio(7, 100, 20, new Uint8Array([1, 2])))).toEqual([
      0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c,
      0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x64,
      0x00, 0x14, 0x01, 0x02,
    ]);
  });

  it("decodes split and coalesced frames", () => {
    const finish = encodeSpeechFrame(SpeechFrameKind.Finish);
    const cancel = encodeSpeechJson(SpeechFrameKind.Cancel, { reason: "user" });
    const joined = new Uint8Array(finish.byteLength + cancel.byteLength);
    joined.set(finish);
    joined.set(cancel, finish.byteLength);

    const decoder = new SpeechFrameDecoder();
    expect(decoder.push(joined.slice(0, 5))).toEqual([]);
    expect(decoder.push(joined.slice(5)).map((frame) => frame.kind)).toEqual([
      SpeechFrameKind.Finish,
      SpeechFrameKind.Cancel,
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects unknown and unbounded frames from their header", () => {
    const unknown = new Uint8Array([2, 0x7f, 0, 0, 0, 0, 0, 0]);
    expect(() => new SpeechFrameDecoder().push(unknown)).toThrow(/unknown speech frame kind/);

    const oversized = new Uint8Array([2, SpeechFrameKind.Start, 0, 0, 0, 4, 0, 1]);
    expect(MAX_SPEECH_FRAME_PAYLOAD_BYTES).toBe(0x4_0000);
    expect(() => new SpeechFrameDecoder().push(oversized)).toThrow(/too large/);
  });
});
