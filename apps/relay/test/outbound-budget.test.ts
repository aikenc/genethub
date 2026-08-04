import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { WebSocket } from "ws";

import { OutboundByteBudget } from "../src/shared/outbound-budget.js";

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
}

const socket = (value: FakeSocket) => value as unknown as WebSocket;

describe("process-wide outbound byte budget", () => {
  it("bounds several sockets even when every socket remains under its own limit", () => {
    const budget = new OutboundByteBudget(10, 8, 1);
    const first = new FakeSocket();
    const second = new FakeSocket();

    const releaseFirst = budget.reserve(socket(first), 6);
    const releaseSecond = budget.reserve(socket(second), 4);
    assert.ok(releaseFirst);
    assert.ok(releaseSecond);
    assert.equal(budget.bytes, 10);
    // second would be only 5/8, but the process is already at 10/10.
    assert.equal(budget.reserve(socket(second), 1), null);
    assert.equal(budget.bytes, 10);

    releaseFirst();
    assert.equal(budget.bytes, 4);
    assert.ok(budget.reserve(socket(second), 4));
    assert.equal(budget.bytes, 8);
  });

  it("releases callback reservations exactly once", () => {
    const budget = new OutboundByteBudget(16, 8, 1);
    const peer = new FakeSocket();
    const release = budget.reserve(socket(peer), 7)!;
    assert.equal(budget.bytes, 7);
    // `ws` implementations may report a send failure and then close/error.
    release();
    release();
    peer.emit("error", new Error("send failed"));
    peer.emit("close");
    assert.equal(budget.bytes, 0);
  });

  it("releases every outstanding send when the socket errors or closes", () => {
    const budget = new OutboundByteBudget(32, 16, 1);
    const errored = new FakeSocket();
    const closed = new FakeSocket();
    assert.ok(budget.reserve(socket(errored), 5));
    assert.ok(budget.reserve(socket(errored), 6));
    assert.ok(budget.reserve(socket(closed), 7));
    assert.equal(budget.bytes, 18);

    errored.emit("error", new Error("write failed"));
    assert.equal(budget.bytes, 7);
    closed.emit("close");
    assert.equal(budget.bytes, 0);
  });

  it("includes websocket bufferedAmount in the per-socket decision", () => {
    const budget = new OutboundByteBudget(32, 8, 1);
    const peer = new FakeSocket();
    peer.bufferedAmount = 7;
    assert.equal(budget.reserve(socket(peer), 2), null);
    assert.equal(budget.bytes, 0);
  });

  it("charges empty frames for their queue metadata", () => {
    const budget = new OutboundByteBudget(4096, 2048);
    const peer = new FakeSocket();
    assert.ok(budget.reserve(socket(peer), 0));
    assert.ok(budget.reserve(socket(peer), 0));
    assert.equal(budget.reserve(socket(peer), 0), null);
    assert.equal(budget.bytes, 2048);
  });
});
