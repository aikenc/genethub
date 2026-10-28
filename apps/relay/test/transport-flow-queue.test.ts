import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import type { WebSocket } from "ws";
import { OutboundByteBudget } from "../src/shared/outbound-budget.js";
import { TransportFlowQueue } from "../src/forward/transport-flow-queue.js";
import { FabricKind, type FabricFrame } from "../src/forward/fabric-frame.js";

const a = "a".repeat(32), b = "b".repeat(32);
const frame = (streamId: string, seq: number, fin = false): FabricFrame => ({
  kind: fin ? FabricKind.Fin : FabricKind.Data, streamId,
  value: BigInt(fin ? 0 : seq), payload: fin ? Buffer.alloc(0) : Buffer.from([seq]),
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};

it("a blocked stream preserves its DATA/FIN order while a sibling progresses", async () => {
  const gate = deferred(), budget = new OutboundByteBudget(8192, 4096);
  const seen: string[] = [];
  const queue = new TransportFlowQueue(budget, async f => {
    seen.push(`${f.streamId[0]}:${f.kind}:${f.value}`);
    if (f.streamId === a && f.value === 1n) await gate.promise;
  }, () => assert.fail("unexpected overflow"), () => assert.fail("unexpected forward failure"));
  queue.push(frame(a, 1), 29); queue.push(frame(a, 2), 29); queue.push(frame(a, 0, true), 28);
  queue.push(frame(b, 1), 29); queue.push(frame(b, 2), 29);
  await setImmediate();
  assert.deepEqual(seen, ["a:4:1", "b:4:1", "b:4:2"]);
  assert.equal(budget.bytes, 2048);
  gate.resolve(); await setImmediate();
  assert.deepEqual(seen, ["a:4:1", "b:4:1", "b:4:2", "a:4:2", "a:6:0"]);
  assert.equal(budget.bytes, 0); queue.close();
});

it("cancel and source close free queued custody even before an in-flight send completes", async () => {
  const gate = deferred(), budget = new OutboundByteBudget(8192, 4096);
  const seen: FabricFrame[] = [];
  const queue = new TransportFlowQueue(budget, async f => { seen.push(f); await gate.promise; },
    () => assert.fail("unexpected overflow"), () => assert.fail("unexpected forward failure"));
  queue.push(frame(a, 1), 29); queue.push(frame(a, 2), 29); queue.push(frame(a, 0, true), 28);
  assert.equal(budget.bytes, 2048);
  queue.cancel(a); assert.equal(budget.bytes, 0);
  queue.close(); queue.push(frame(b, 1), 29);
  gate.resolve(); await setImmediate();
  assert.equal(seen.length, 1); assert.equal(budget.bytes, 0);
});

it("waiting frames and socket writes share one bound; overflow cancels only its stream", async () => {
  const budget = new OutboundByteBudget(4096, 4096), gate = deferred();
  const socket = Object.assign(new EventEmitter(), { bufferedAmount: 0 }) as unknown as WebSocket;
  const releaseSocket = budget.reserve(socket, 2048)!;
  const seen: string[] = [], overflow: string[] = [];
  const queue = new TransportFlowQueue(budget, async f => {
    seen.push(f.streamId); if (f.streamId === a) await gate.promise;
  }, id => overflow.push(id), () => assert.fail("unexpected forward failure"));
  queue.push(frame(a, 1), 29); queue.push(frame(a, 2), 29); queue.push(frame(a, 3), 29);
  assert.equal(budget.bytes, 4096);
  queue.push(frame(a, 4), 29);
  assert.deepEqual(overflow, [a]); assert.equal(budget.bytes, 2048);
  queue.push(frame(b, 1), 29); await setImmediate();
  assert.deepEqual(seen, [a, b]);
  gate.resolve(); queue.close(); releaseSocket(); await setImmediate();
  assert.deepEqual(seen, [a, b]); assert.equal(budget.bytes, 0);
});
