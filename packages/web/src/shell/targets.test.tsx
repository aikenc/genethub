import type { Reply } from "@genehub/proto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { rememberMachine } from "../devices/machines";
import { browserHost, desktopHost, type Endpoint, type Host } from "../host";
import { socketQueue } from "../protocol/fake-socket";
import { useWorkbench } from "../session/store";

/**
 * The target switcher: which machine the workbench is pointed at.
 *
 * The behaviour worth pinning is not the dropdown. It is that "local" and
 * "remote" are the same kind of thing here — a desktop app can drive a machine
 * across the room, and a machine that is not this one does not stop being
 * driveable because the daemon on this one restarted.
 */

const REMOTE = "wss://relay.example.com/forward/client?rendezvous=abc";

const paired = (machineId: string, name: string, endpoint = REMOTE) =>
  rememberMachine({
    machineId,
    name,
    fingerprint: "AAAA-BBBB",
    endpoint,
    deviceId: "d_1",
    secret: "s_1",
    pairedAt: new Date().toISOString(),
  });

/**
 * A stand-in for `App`'s `connect`, typed so that what it was called with —
 * the endpoint, and the redial that asks for a fresh ticket — is inspectable.
 */
const connectSpy = () =>
  vi.fn((_endpoint: Endpoint, _redial: () => Promise<string>) => stubClient());

/** Enough of a client for the store to attach to without throwing in an effect. */
function stubClient() {
  return {
    connect() {},
    close() {},
    onStateChange: () => () => {},
    onNotice: () => () => {},
    onUpdateDownload: () => () => {},
    onEvent: () => () => {},
    onPty: () => () => {},
    call: async () => null,
    subscribe: async () => ({ replayed: [], reset: false }),
    unsubscribe: async () => {},
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
  useWorkbench.setState({ connection: "ready", tabs: [], activeTabId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("what a shell says it can drive", () => {
  it("puts this computer in the desktop's list alongside the machines it paired with", async () => {
    vi.stubGlobal("window", {
      __TAURI__: {
        core: {
          invoke: vi.fn(async () => ({
            port: 42123,
            token: "tok",
            machineId: "m_here",
            fingerprint: "AB-CD",
          })),
        },
      },
      localStorage,
    });
    paired("m_far", "工作机");

    expect(await desktopHost().targets!()).toEqual([
      { id: "local", label: "这台电脑", kind: "local", online: true },
      { id: "m_far", label: "工作机", kind: "remote", fingerprint: "AAAA-BBBB" },
    ]);
  });

  it("keeps this computer on the list when its daemon is down, marked offline", async () => {
    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke: vi.fn(async () => null) } },
      localStorage,
    });

    // Dropping the row would read as "this machine no longer exists", when what
    // happened is that a process failed to start.
    expect(await desktopHost().targets!()).toEqual([
      { id: "local", label: "这台电脑", kind: "local", online: false },
    ]);
  });

  it("carries the pairing credential when switching, or a relayed machine will not answer", async () => {
    paired("m_far", "工作机");
    const host = browserHost({ hash: "" });

    expect(await host.openTarget!("m_far")).toMatchObject({
      url: REMOTE,
      via: "relay",
      label: "工作机",
      credential: { deviceId: "d_1", secret: "s_1" },
    });
    // The address bar follows, so a reload stays where the user is looking.
    expect(decodeURIComponent(window.location.hash)).toContain(REMOTE);
  });

  it("says so rather than connecting nowhere when the machine was forgotten", async () => {
    await expect(browserHost({ hash: "" }).openTarget!("m_gone")).rejects.toThrow(/名册/);
  });
});

/**
 * Where the account's machines come from on the desktop.
 *
 * Through this machine's own daemon, on a connection of its own — not from
 * anything compiled into the app. The app is the open-source workbench and
 * holds no account credential; the daemon holds the uplink one. That is the
 * boundary the packaging depends on (`genethub-cloud/desktop/README.md`), so it
 * is worth a test that fails if someone routes it any other way.
 */
describe("the machines the account knows about", () => {
  const daemonUp = () =>
    vi.stubGlobal("window", {
      __TAURI__: {
        core: {
          invoke: vi.fn(async () => ({
            port: 42123,
            token: "tok",
            machineId: "m_here",
            fingerprint: "AB-CD",
          })),
        },
      },
      localStorage,
    });

  /**
   * Answers one request on the nth side connection the host opens.
   *
   * By index rather than "the latest", because each exchange gets a socket of
   * its own and a helper that grabbed whichever existed would answer the
   * previous, already hung-up one.
   */
  const answer = async (
    queue: ReturnType<typeof socketQueue>,
    nth: number,
    type: string,
    reply: Reply,
  ) => {
    await vi.waitFor(() => expect(queue.sockets.length).toBeGreaterThan(nth));
    const socket = queue.sockets[nth]!;
    socket.open();
    await vi.waitFor(() => socket.lastOf("hello"));
    socket.acceptHandshake();
    await vi.waitFor(() => socket.lastOf(type));
    socket.reply(socket.lastOf(type).id, reply);
  };

  it("lists them under this computer, without listing this computer twice", async () => {
    daemonUp();
    const queue = socketQueue();
    const listed = desktopHost(queue.factory).targets!();

    await answer(queue, 0, "hub.machines", {
      type: "hubMachines",
      data: [
        // The Hub knows about this machine too. It is already the first row,
        // and a second one would reach the daemon underfoot through a relay.
        { id: "mch_here", name: "这台电脑", online: true, fingerprint: "AB-CD" },
        { id: "mch_far", name: "公司台式机", online: false, fingerprint: "EF-GH" },
      ],
    });

    expect(await listed).toEqual([
      { id: "local", label: "这台电脑", kind: "local", online: true },
      {
        id: "mch_far",
        label: "公司台式机",
        kind: "remote",
        online: false,
        fingerprint: "EF-GH",
      },
    ]);
  });

  it("does not repeat a machine this browser also paired with by hand", async () => {
    daemonUp();
    paired("m_far", "工作机");
    const queue = socketQueue();
    const listed = desktopHost(queue.factory).targets!();

    await answer(queue, 0, "hub.machines", {
      type: "hubMachines",
      // Same computer, different id space: the Hub's ids and the ones a local
      // pairing recorded have nothing to do with each other, so the key that
      // works is the machine's own key.
      data: [{ id: "mch_far", name: "工作机（账号）", online: true, fingerprint: "AAAA-BBBB" }],
    });

    expect((await listed).map((target) => target.label)).toEqual(["这台电脑", "工作机"]);
  });

  it("still shows this computer when the Hub cannot be reached", async () => {
    daemonUp();
    const queue = socketQueue();
    const listed = desktopHost(queue.factory).targets!();

    await vi.waitFor(() => expect(queue.sockets.length).toBeGreaterThan(0));
    queue.latest().close();

    // The local row is the one that still works with the network down. Burying
    // it under an error about an account server would be the wrong trade.
    expect(await listed).toEqual([
      { id: "local", label: "这台电脑", kind: "local", online: true },
    ]);
  });

  it("mints the ticket through the local daemon, so switching survives the far end dropping", async () => {
    daemonUp();
    const queue = socketQueue();
    const opening = desktopHost(queue.factory).openTarget!("mch_far");

    // One short-lived connection carries both asks (ticket + label). A second
    // socket used to be a second handshake that could fail the whole switch.
    await vi.waitFor(() => expect(queue.sockets.length).toBe(1));
    const socket = queue.sockets[0]!;
    socket.open();
    await vi.waitFor(() => socket.lastOf("hello"));
    socket.acceptHandshake();
    await vi.waitFor(() => socket.lastOf("hub.connect"));
    socket.reply(socket.lastOf("hub.connect").id, {
      type: "hubTicket",
      data: { url: REMOTE, expiresAt: "2099-01-01T00:00:00Z", fingerprint: "EF-GH" },
    });
    await vi.waitFor(() => socket.lastOf("hub.machines"));
    socket.reply(socket.lastOf("hub.machines").id, {
      type: "hubMachines",
      data: [{ id: "mch_far", name: "公司台式机", online: true, fingerprint: "EF-GH" }],
    });

    expect(await opening).toEqual({
      url: REMOTE,
      via: "relay",
      label: "公司台式机",
      fingerprint: "EF-GH",
    });
    // Dialled the machine underfoot, not the one being switched to: the far end
    // is exactly what may be unreachable when a reconnect needs a fresh ticket.
    expect(queue.urls.every((url) => url.includes("127.0.0.1:42123"))).toBe(true);
  });
});

describe("switching from the sidebar", () => {
  const localEndpoint: Endpoint = {
    url: "ws://127.0.0.1:1/ws",
    via: "loopback",
    label: "这台电脑",
  };
  const remoteEndpoint: Endpoint = { url: REMOTE, via: "relay", label: "工作机" };

  const host = (overrides: Partial<Host> = {}): Host => ({
    kind: "desktop",
    endpoint: async () => localEndpoint,
    notify: () => {},
    openExternal: () => {},
    targets: async () => [
      { id: "local", label: "这台电脑", kind: "local", online: true },
      { id: "m_far", label: "工作机", kind: "remote" },
    ],
    openTarget: async (id) => (id === "local" ? localEndpoint : remoteEndpoint),
    ...overrides,
  });

  it("names the machine everything below it belongs to", async () => {
    render(<App host={host()} connect={() => stubClient()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /这台电脑/ })).toBeInTheDocument(),
    );
  });

  it("points the workbench at another machine, credential and all", async () => {
    const connect = connectSpy();
    render(<App host={host()} connect={connect} />);

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(await screen.findByRole("option", { name: /工作机/ }));

    await waitFor(() =>
      expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE }),
    );
  });

  it("does not drag someone home because the local daemon restarted", async () => {
    let announce = () => {};
    const connect = connectSpy();
    render(
      <App
        host={host({
          onEndpointChange: (listener) => {
            announce = listener;
            return () => {};
          },
        })}
        connect={connect}
      />,
    );

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(await screen.findByRole("option", { name: /工作机/ }));
    await waitFor(() =>
      expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE }),
    );

    announce();

    // A sidecar coming back on a new port is news about one machine, not an
    // instruction to leave the one being worked on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect.mock.calls.at(-1)?.[0]).toMatchObject({ url: REMOTE });
  });

  it("asks the target again on every redial, because a ticket is spent once", async () => {
    const openTarget = vi.fn(async () => remoteEndpoint);
    const connect = connectSpy();
    render(<App host={host({ openTarget })} connect={connect} />);

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /这台电脑/ }));
    await userEvent.click(await screen.findByRole("option", { name: /工作机/ }));
    await waitFor(() => expect(openTarget).toHaveBeenCalledTimes(1));

    const redial = connect.mock.calls.at(-1)![1];
    expect(await redial()).toBe(REMOTE);
    expect(openTarget).toHaveBeenCalledTimes(2);
  });

  it("stays out of the way where the shell has only one machine to offer", async () => {
    render(
      <App
        host={{
          kind: "browser",
          endpoint: async () => localEndpoint,
          notify: () => {},
          openExternal: () => {},
        }}
        connect={() => stubClient()}
      />,
    );

    await waitFor(() => expect(screen.getByText("新建会话")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /这台电脑/ })).not.toBeInTheDocument();
  });
});
