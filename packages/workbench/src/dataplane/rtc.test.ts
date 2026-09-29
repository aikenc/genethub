import { describe, expect, it, vi } from "vitest";

import { GATHER_WAIT_MS, iceGathered, RtcUpgradeError, watchPeer, type RtcDiagnostic } from "./rtc";

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
    removeEventListener(type: string, listener: (event?: unknown) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
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

  it("reports the selected ICE path and failed checks without leaking candidate addresses", async () => {
    const peer = fakePeer();
    const raw = new Map<string, Record<string, unknown>>([
      ["transport-secret", { type: "transport", selectedCandidatePairId: "pair-secret" }],
      ["pair-secret", { type: "candidate-pair", id: "pair-secret", state: "succeeded",
        nominated: true, localCandidateId: "local-secret", remoteCandidateId: "remote-secret",
        currentRoundTripTime: 0.012, requestsSent: 4, responsesReceived: 3,
        consentRequestsSent: 1 }],
      ["failed-secret", { type: "candidate-pair", id: "failed-secret", state: "failed" }],
      ["local-secret", { type: "local-candidate", candidateType: "host", protocol: "udp",
        address: "192.0.2.11", port: 54321 }],
      ["remote-secret", { type: "remote-candidate", candidateType: "srflx", protocol: "udp",
        address: "203.0.113.21", port: 3478 }],
    ]);
    const observed = peer as unknown as RTCPeerConnection & { getStats: () => Promise<RTCStatsReport> };
    observed.getStats = async () => raw as unknown as RTCStatsReport;
    const seen: RtcDiagnostic[] = [];
    watchPeer(observed, "rtc_2", (detail) => seen.push(detail));
    peer.connectionState = "failed";
    peer.fire("connectionstatechange");
    await vi.waitFor(() => expect(seen.some((detail) => detail.milestone === "candidatePair")).toBe(true));

    const summary = seen.find((detail) => detail.milestone === "candidatePair");
    expect(summary).toMatchObject({ diagnosticId: "rtc_2", connectionState: "failed",
      pairSucceeded: 1, pairFailed: 1, selectedPair: true,
      selectedLocalType: "host", selectedRemoteType: "srflx", selectedProtocol: "udp",
      pairRttMs: 12, pairRequestsSent: 4, pairResponsesReceived: 3 });
    expect(JSON.stringify(seen)).not.toMatch(/192\.0\.2|203\.0\.113|54321|3478|secret/);
  });
});

describe("iceGathered", () => {
  it("resolves as soon as gathering completes", async () => {
    const peer = fakePeer();
    const waited = iceGathered(peer as unknown as RTCPeerConnection, 5_000);
    peer.iceGatheringState = "complete";
    peer.fire("icegatheringstatechange");
    await expect(waited).resolves.toBeUndefined();
  });

  it("keeps gathering after an early srflx and beyond the old two-second cutoff", async () => {
    vi.useFakeTimers();
    try {
      const peer = fakePeer();
      let settled = false;
      const waited = iceGathered(peer as unknown as RTCPeerConnection, GATHER_WAIT_MS)
        .then(() => { settled = true; });
      peer.fire("icecandidate", {
        candidate: { candidate: "candidate:2 1 udp 1 203.0.113.7 9 typ srflx" },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(false);
      peer.fire("icecandidate", {
        candidate: { candidate: "candidate:3 1 udp 1 203.0.113.8 9 typ srflx" },
      });
      peer.iceGatheringState = "complete";
      peer.fire("icegatheringstatechange");
      await waited;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("waits out a hung STUN gather instead of sending a host-only offer", async () => {
    vi.useFakeTimers();
    const peer = fakePeer();
    const waited = iceGathered(peer as unknown as RTCPeerConnection, 2_000);
    peer.fire("icecandidate", {
      candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    void waited.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waited).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("RtcUpgradeError", () => {
  it("keeps the failing phase on the error the UI can show", () => {
    const error = new RtcUpgradeError("channel", new Error("RTC DataChannel did not open"), {
      connectionState: "connecting",
    });
    expect(error.phase).toBe("channel");
    expect(error.message).toBe("RTC DataChannel did not open");
    expect(error.detail.connectionState).toBe("connecting");
  });
});
