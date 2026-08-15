import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import type { Endpoint } from "../host";
import type { WebSocketLike } from "../protocol/client";
import { FakeSocket } from "../protocol/fake-socket";
import { useWorkbench } from "../session/store";
import { claimMachine } from "./claim";
import { forgetMachine, listMachines, pairingLink, readPairingLink } from "./machines";

const INVITE_ID = `inv_${"1".repeat(32)}`;
const INVITE_SECRET = "2".repeat(64);
const CODE = `${INVITE_ID}.${INVITE_SECRET}`;
const ENDPOINT = "wss://machine.example.com/peer";

/**
 * A machine on the other end of a pairing link, with a switch for the case
 * that matters most: something else sitting in the rendezvous slot, saying
 * yes to everything, without the invite.
 */
function machineSocket({ knowsCode = true }: { knowsCode?: boolean } = {}) {
  return (_url: string) => {
    const secret = knowsCode ? INVITE_SECRET : "3".repeat(64);
    const socket = new FakeSocket({ secret, autoIdentity: false });
    queueMicrotask(() => {
      socket.open();
      void (async () => {
        await sent(socket, "hello");
        socket.acceptHandshake(secret);
        if (!knowsCode) return;
        const claim = await sent(socket, "device.claim");
        socket.reply(claim.id, {
          type: "claimed",
          data: {
            machineId: "m_1",
            deviceId: "d_1",
            secret: "s_1",
            machineName: "工作机",
            fingerprint: "AAAA-BBBB",
          },
        });
      })();
    });
    return socket;
  };
}

async function sent(socket: FakeSocket, type: string) {
  for (let turn = 0; turn < 100; turn += 1) {
    try {
      return socket.lastOf(type);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error(`fake peer did not receive ${type}`);
}

/**
 * Enough of a client for the store to attach to. Written out rather than left as
 * a bare object: a stub missing a method the store calls throws inside an effect,
 * which surfaces as an unhandled rejection and a test that passes for the wrong
 * reason.
 */
function stubClient() {
  return {
    connect() {},
    close() {},
    onStateChange: () => () => {},
    onNotice: () => () => {},
    onUpdateDownload: () => () => {},
    onBackgroundProcesses: () => () => {},
    onEvent: () => () => {},
    onPty: () => () => {},
    call: async () => null,
    subscribe: async () => ({ replayed: [], reset: false }),
    unsubscribe: async () => {},
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  // Also clears the tab-only fallback left by a test that deliberately blocks
  // persistent storage.
  forgetMachine("__test_reset__", localStorage);
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("redeeming a pairing invite", () => {
  it("keeps the credential the machine hands back", async () => {
    const machine = await claimMachine(ENDPOINT, CODE, "手机上的 Safari", machineSocket());

    expect(machine).toMatchObject({
      machineId: "m_1",
      deviceId: "d_1",
      secret: "s_1",
      name: "工作机",
      fingerprint: "AAAA-BBBB",
      endpoint: ENDPOINT,
    });
  });

  it("refuses whoever cannot answer for the invite", async () => {
    // Reaching a rendezvous slot is not proof of being the machine behind it.
    await expect(
      claimMachine(ENDPOINT, CODE, "手机上的 Safari", machineSocket({ knowsCode: false })),
    ).rejects.toThrow(/不是这台机器/);
  });

  it("reports a link that no machine is waiting on", async () => {
    const dead = (_url: string) => {
      const socket = {
        onopen: null as (() => void) | null,
        onclose: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onmessage: null,
        send() {},
        close() {},
      };
      queueMicrotask(() => socket.onclose?.());
      return socket as unknown as WebSocketLike;
    };

    await expect(claimMachine(ENDPOINT, CODE, "手机", dead)).rejects.toThrow(/过期/);
  });

  it("times out and closes a WebSocket stranded before open", async () => {
    let closed = false;
    const stranded = () =>
      ({
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send() {},
        close() {
          closed = true;
        },
      }) as WebSocketLike;

    await expect(
      claimMachine(ENDPOINT, CODE, "手机", stranded, { connectTimeoutMs: 5 }),
    ).rejects.toThrow(/连接.*超时/);
    expect(closed).toBe(true);
  });

  it("times out and closes when the Relay opens but never answers Hello", async () => {
    let closed = false;
    const silent = () => {
      const socket = {
        onopen: null as (() => void) | null,
        onclose: null,
        onerror: null,
        onmessage: null,
        send() {},
        close() {
          closed = true;
        },
      };
      queueMicrotask(() => socket.onopen?.());
      return socket as unknown as WebSocketLike;
    };

    await expect(
      claimMachine(ENDPOINT, CODE, "手机", silent, { responseTimeoutMs: 5 }),
    ).rejects.toThrow(/超时|过期/);
    expect(closed).toBe(true);
  });

  it("times out and closes when authenticated Hello succeeds but claim never returns", async () => {
    let closed = false;
    const noClaimReply = (_url: string) => {
      const socket = new FakeSocket({ secret: INVITE_SECRET, autoIdentity: false });
      const close = socket.close.bind(socket);
      socket.close = (...args) => {
        closed = true;
        close(...args);
      };
      queueMicrotask(() => {
        socket.open();
        void sent(socket, "hello").then(() => socket.acceptHandshake());
      });
      return socket;
    };

    await expect(
      // Leave ample time for both sides' WebCrypto work before testing the
      // distinct timeout after the authenticated claim request is sent.
      claimMachine(ENDPOINT, CODE, "手机", noClaimReply, { responseTimeoutMs: 100 }),
    ).rejects.toThrow(/配对结果/);
    expect(closed).toBe(true);
  });
});

describe("a pairing link", () => {
  it("carries the code in the fragment, where servers never see it", () => {
    const link = pairingLink("https://work.example.com", CODE, ENDPOINT);

    expect(new URL(link).search).toBe("");
    expect(readPairingLink(new URL(link).hash)).toEqual({ code: CODE, endpoint: ENDPOINT });
  });
});

describe("the app opened from a pairing link", () => {
  it("pairs first, then connects as the device it just became", async () => {
    window.location.hash = `#claim=${CODE}&endpoint=${encodeURIComponent(ENDPOINT)}`;
    const connect = vi.fn((_endpoint: Endpoint) => stubClient());

    render(
      <App
        connect={connect}
        claim={(url, code, name) => claimMachine(url, code, name, machineSocket())}
      />,
    );

    await waitFor(() => expect(connect).toHaveBeenCalled());
    expect(connect.mock.calls[0]![0]).toMatchObject({
      url: ENDPOINT,
      credential: { deviceId: "d_1", secret: "s_1" },
    });

    // The one-time code is spent, so it must not survive a reload.
    expect(window.location.hash).not.toContain("claim=");
    expect(listMachines()).toHaveLength(1);
  });

  it("says so, and connects to nothing, when the code was already used", async () => {
    window.location.hash = `#claim=${CODE}&endpoint=${encodeURIComponent(ENDPOINT)}`;
    const connect = vi.fn(() => stubClient());

    render(
      <App connect={connect} claim={() => Promise.reject(new Error("邀请码已失效"))} />,
    );

    expect(await screen.findByText("邀请码已失效")).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("the machines this browser remembers", () => {
  it("replaces rather than duplicates when a machine is paired again", async () => {
    const first = await claimMachine(ENDPOINT, CODE, "手机", machineSocket());
    const { rememberMachine } = await import("./machines");

    rememberMachine(first);
    rememberMachine({ ...first, name: "改名了" });

    expect(listMachines()).toHaveLength(1);
    expect(listMachines()[0]!.name).toBe("改名了");
    expect(forgetMachine(first.machineId)).toEqual([]);
  });

  it("keeps a consumed one-shot credential usable when storage rejects writes", async () => {
    const { rememberMachine } = await import("./machines");
    const blocked = {
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("storage blocked");
      },
    };
    const machine = {
      machineId: "m_volatile",
      name: "临时工作机",
      fingerprint: "AAAA-BBBB",
      endpoint: ENDPOINT,
      deviceId: "d_volatile",
      secret: "secret",
      pairedAt: new Date().toISOString(),
    };

    expect(rememberMachine(machine, blocked)).toEqual([machine]);
    expect(listMachines(blocked)).toEqual([machine]);
    expect(forgetMachine(machine.machineId, blocked)).toEqual([]);
    expect(listMachines(blocked)).toEqual([]);
  });
});

describe("the devices panel", () => {
  it("shows the link next to the code, because cameras need HTTPS", async () => {
    useWorkbench.setState({
      client: { call: async () => null } as never,
      devices: [
        {
          id: "d_1",
          name: "手机",
          pairedAt: new Date().toISOString(),
          lastSeenAt: null,
          connected: true,
        },
      ],
      remote: { relayUrl: "https://relay.example.com", rendezvousId: "abc", online: true },
      invite: async () => ({ code: CODE, rendezvousUrl: ENDPOINT, expiresAt: "" }),
    } as never);

    const { DevicesPanel } = await import("./DevicesPanel");
    render(<DevicesPanel origin="https://work.example.com" />);

    screen.getByRole("button", { name: "生成配对链接" }).click();

    await waitFor(() => expect(screen.getByTestId("pairing-link")).toHaveTextContent(CODE));
    expect(screen.getByRole("img", { name: "配对二维码" })).toBeInTheDocument();
    expect(screen.getByText("手机")).toBeInTheDocument();
  });
});

/**
 * "我要有个按钮给我生成一个手机可访问的二维码" — the code and the link both
 * existed, three clicks deep in settings and only after typing a Hub address.
 * This is about the button being where someone looks for it.
 */
describe("opening this machine on a phone", () => {
  it("hands over a link and a code from the devices page", async () => {
    let minted = 0;
    useWorkbench.setState({
      client: { call: async () => null } as never,
      hub: { state: "paired", hubUrl: "https://hub.example.com", machineId: "m_1", online: true },
      claimLink: async () => {
        minted += 1;
        useWorkbench.setState({
          claim: { claimUrl: "https://hub.example.com/claim/xyz", recoveryKey: null },
        } as never);
        return null as never;
      },
    } as never);

    const { DevicesPanel } = await import("./DevicesPanel");
    render(
      <DevicesPanel
        origin="https://work.example.com"
        host={{ kind: "browser", openExternal: () => {}, endpoint: async () => null } as never}
      />,
    );

    screen.getByRole("button", { name: "生成链接和二维码" }).click();

    await waitFor(() =>
      expect(screen.getByText("https://hub.example.com/claim/xyz")).toBeInTheDocument(),
    );
    expect(minted).toBe(1);
    expect(screen.getByRole("img", { name: "配对二维码" })).toBeInTheDocument();
  });

  it("points at the one missing step instead of a dead button", async () => {
    useWorkbench.setState({
      client: { call: async () => null } as never,
      hub: { state: "unpaired" },
      claim: null,
    } as never);

    const { DevicesPanel } = await import("./DevicesPanel");
    render(<DevicesPanel origin="https://work.example.com" />);

    expect(screen.getByRole("button", { name: "去连接 Hub" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成链接和二维码" })).toBeNull();
  });
});
