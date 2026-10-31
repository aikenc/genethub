import { describe, expect, it } from "vitest";
import { MAX_DATA_FRAME_BYTES, MAX_DATA_PAYLOAD_BYTES, MAX_FINITE_EXCHANGE_BODY_BYTES } from "./frame";
import { RecordInbox } from "./record-inbox";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

describe("raw carrier custody while asynchronous decryption is busy", () => {
  it("accepts one complete legal finite body burst and delivers owned records in order", async () => {
    const paused = gate();
    const count = Math.ceil(MAX_FINITE_EXCHANGE_BODY_BYTES / MAX_DATA_PAYLOAD_BYTES) + 1;
    let received = 0, ordered = true;
    const errors: unknown[] = [];
    const inbox = new RecordInbox(async record => {
      await paused.ready;
      ordered &&= new DataView(record.buffer, record.byteOffset).getUint32(0) === received;
      received++;
    }, error => errors.push(error));
    const input = new Uint8Array(MAX_DATA_FRAME_BYTES);
    for (let n = 0; n < count; n++) {
      new DataView(input.buffer).setUint32(0, n);
      inbox.push(input);
    }
    input.fill(255); // The caller cannot mutate queued record custody.
    expect(errors).toHaveLength(0);
    paused.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).toBe(count);
    expect(ordered).toBe(true);
    inbox.close();
  });

  it("still terminates an overflowing carrier instead of retaining unbounded records", async () => {
    const paused = gate();
    const errors: unknown[] = [];
    const inbox = new RecordInbox(() => paused.ready, error => errors.push(error));
    const record = new Uint8Array(MAX_DATA_FRAME_BYTES);
    const upper = Math.ceil(2 * MAX_FINITE_EXCHANGE_BODY_BYTES / record.length);
    for (let n = 0; n < upper && !errors.length; n++) inbox.push(record);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("inbox is full");
    inbox.push(record);
    expect(errors).toHaveLength(1);
    paused.release();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
