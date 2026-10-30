import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteDesktopInput } from "@genehub/proto/remote-desktop";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";

// The shipped editable JS has no npm type facade. Load that actual asset;
// a recording transport tests DOM semantics, without claiming native OS input.
const asset = new FileURL("../../../../apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/input.js", import.meta.url);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(readFileSync(asset)).toString("base64")}`;
const { attachInput } = await import(/* @vite-ignore */ moduleUrl);
function setup() {
  const video = document.createElement("video"); video.tabIndex = 0;
  document.body.append(video);
  Object.defineProperties(video, {videoWidth: {value: 200}, videoHeight: {value: 100}});
  video.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
  const packets: RemoteDesktopInput[] = [];
  const client = Object.assign(new EventTarget(), {
    session: {sessionId: "view"},
    lease: {epoch: 1, targetGeneration: 1} as {epoch: number; targetGeneration: number} | null,
    controlChannel: {readyState: "open", bufferedAmount: 0, send: (value: string) => packets.push(JSON.parse(value))},
    releaseControl: () => {}, status: () => {},
  });
  client.releaseControl = () => {client.lease = null; client.dispatchEvent(new Event("released"));};
  const input = attachInput(client, video) as {dispose(): void};
  return {video, client, input, packets};
}
describe("editable remote desktop input", () => {
  let current: ReturnType<typeof setup>;
  beforeEach(() => {vi.useFakeTimers(); current = setup();});
  afterEach(() => {current.input.dispose(); current.video.remove(); vi.useRealTimers();});
  it("releases a held mouse button after a drag ends outside the picture", () => {
    const {video, packets} = current;
    video.dispatchEvent(new MouseEvent("pointerdown", {button: 0, clientX: 100, clientY: 50}));
    video.dispatchEvent(new MouseEvent("pointerup", {button: 0, clientX: 300, clientY: 150}));
    expect(packets.map(packet => packet.event)).toEqual([
      {type: "button", button: 0, down: true, x: 0.5, y: 0.5},
      {type: "button", button: 0, down: false},
    ]);
    vi.advanceTimersByTime(250);
    expect(packets.at(-1)?.event).toEqual({type: "state", keys: [], buttons: []});
  });
  it("resets held state and gives up control when the browser cancels a pointer", () => {
    const {video, client, packets} = current;
    video.dispatchEvent(new MouseEvent("pointerdown", {button: 1, clientX: 100, clientY: 50}));
    video.dispatchEvent(new Event("pointercancel"));
    expect(packets.at(-1)?.event).toEqual({type: "reset"});
    expect(client.lease).toBeNull();
    const count = packets.length; vi.advanceTimersByTime(1000);
    expect(packets).toHaveLength(count);
  });
});

it("text entry cannot reassert old held keys on the next state heartbeat", () => {
  vi.useFakeTimers();
  const {video, input, packets} = setup();
  try {
    video.dispatchEvent(new KeyboardEvent("keydown", {code: "ShiftLeft"}));
    (input as unknown as {text(value: string): void}).text("视图");
    vi.advanceTimersByTime(250);
    expect(packets.at(-1)?.event).toEqual({type: "state", keys: [], buttons: []});
  } finally { input.dispose(); video.remove(); vi.useRealTimers(); }
});

it("gives up control when a channel closes between its ready check and send", () => {
  const {video, client, input} = setup();
  try {
    client.controlChannel.send = () => {throw new DOMException("closed", "InvalidStateError");};
    expect(() => (input as unknown as {text(value: string): void}).text("a")).not.toThrow();
    expect(client.lease).toBeNull();
  } finally { input.dispose(); video.remove(); }
});
