import { describe, expect, it } from "vitest";

import { watchPeer, type RtcDiagnostic } from "./rtc";

/** Minimal RTCPeerConnection stand-in: addEventListener plus settable state. */
function fakePeer() {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const peer = {
    iceConnectionState: "new",
    iceGatheringState: "new",
    connectionState: "new",
    signalingState: "stable",
    addEventListener(type: string, listener: (event?: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire(type: string, event?: unknown) {
      for (const listener of listeners.get(type) ?? []) listener.call(peer, event);
    },
  };
  return peer;
}

describe("watchPeer", () => {
  it("reports state machine transitions with the diagnostic id", () => {
    const peer = fakePeer();
    const seen: RtcDiagnostic[] = [];
    watchPeer(peer as unknown as RTCPeerConnection, "rtc_1", (d) => seen.push(d));

    peer.iceConnectionState = "checking";
    peer.fire("iceconnectionstatechange");
    peer.connectionState = "connected";
    peer.fire("connectionstatechange");
    peer.signalingState = "have-remote-offer";
    peer.fire("signalingstatechange");

    expect(seen).toEqual([
      { diagnosticId: "rtc_1", iceConnectionState: "checking" },
      { diagnosticId: "rtc_1", connectionState: "connected" },
      { diagnosticId: "rtc_1", signalingState: "have-remote-offer" },
    ]);
  });

  it("counts candidate types without ever recording the candidate string", () => {
    const peer = fakePeer();
    const seen: RtcDiagnostic[] = [];
    watchPeer(peer as unknown as RTCPeerConnection, null, (d) => seen.push(d));

    const fire = (candidate: string | null) =>
      peer.fire("icecandidate", {
        candidate: candidate === null ? null : { candidate },
      });
    fire("candidate:1 1 udp 2130706431 192.0.2.1 54321 typ host generation 0");
    fire("candidate:2 1 udp 1694498815 203.0.113.7 12345 typ srflx raddr 192.0.2.1 rport 54321 generation 0");
    fire("candidate:3 1 udp 16777215 198.51.100.3 443 typ relay generation 0");
    fire(null);
    peer.iceGatheringState = "complete";
    peer.fire("icegatheringstatechange");

    const tally = seen.find((d) => "candidateHost" in d);
    expect(tally).toEqual({
      diagnosticId: null,
      candidateHost: 1,
      candidateSrflx: 1,
      candidatePrflx: 0,
      candidateRelay: 1,
    });
    // No event may contain an address-bearing candidate string.
    for (const detail of seen) {
      for (const value of Object.values(detail)) {
        expect(String(value)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      }
    }
  });
});
