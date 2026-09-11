import { describe, expect, it } from "vitest";

import {
  WebSocketRecordCarrier,
  type BinaryWebSocketLike,
} from "./websocket";

class SocketStub implements BinaryWebSocketLike {
  binaryType = "blob";
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (!ArrayBuffer.isView(data)) throw new Error("expected a typed record");
    this.sent.push(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
    );
  }

  close(): void {}
}

describe("the data-plane WebSocket carrier", () => {
  it("waits for local socket drain without adding a network acknowledgement", async () => {
    const socket = new SocketStub();
    const carrier = new WebSocketRecordCarrier(socket);
    socket.bufferedAmount = 256 * 1024;
    const sending = carrier.send(new Uint8Array([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    await sending;
    expect(socket.sent).toEqual([new Uint8Array([1, 2, 3])]);
  });
});
