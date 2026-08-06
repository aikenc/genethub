import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { Client } from "./protocol/client";
import { socketQueue } from "./protocol/fake-socket";
import { useWorkbench } from "./session/store";

/**
 * The app with nothing injected, which is the only configuration a user ever
 * runs.
 *
 * Every other case here hands `App` a host and a connect function, and those
 * props hid a whole class of failure: the defaults were built inline, so they
 * were new values on every render, and the effects that depend on them ran
 * again each time. The result was a blank page — React gives up and unmounts
 * the tree rather than looping forever — and the entire suite stayed green,
 * because no test ever used the defaults.
 */

const ENDPOINT =
  "ws://127.0.0.1:59999/ws?challenge=fresh&pid=42&expiresAt=1&proof=proof";

let sockets = 0;

class CountingSocket {
  static readonly OPEN = 1;
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    sockets += 1;
  }
  send() {}
  close() {}
}

beforeEach(() => {
  sockets = 0;
  window.location.hash = `#endpoint=${ENDPOINT}`;
  vi.stubGlobal("WebSocket", CountingSocket);
  useWorkbench.setState({
    client: null,
    agents: [],
    workspaces: [],
    sessions: [],
    tabs: [],
    activeTabId: null,
    rightPanel: null,
    notice: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the app as the browser loads it", () => {
  it("renders, instead of looping until React gives up", async () => {
    render(<App mobileTools={<button type="button">反馈问题</button>} />);

    // Anything at all from the workbench shell proves the tree survived; the
    // failure mode is an empty root, not a wrong pixel.
    expect(await screen.findByRole("status")).toBeInTheDocument();
    // Two of them, and only ever one on screen: the phone's header carries its
    // own, because the sidebar it would otherwise live in is a drawer.
    expect(
      screen.getAllByRole("button", { name: "新建会话" }),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "打开右侧工作区工具" })).toBeInTheDocument();

    screen.getByRole("button", { name: "工作区工具" }).click();
    const tools = screen.getByRole("complementary", { name: "工作区工具" });
    expect(
      within(tools).getByRole("button", { name: "文件" }),
    ).toBeInTheDocument();
    expect(
      within(tools).getByRole("button", { name: "反馈问题" }),
    ).toBeInTheDocument();

    screen.getByRole("button", { name: "打开右侧工作区工具" }).click();
    const desktopTools = screen.getByRole("complementary", { name: "右侧工作区工具" });
    expect(within(desktopTools).getByRole("button", { name: "Changes" })).toBeInTheDocument();
    expect(within(desktopTools).getByRole("button", { name: "文件" })).toBeInTheDocument();
    expect(within(desktopTools).getByRole("button", { name: "设置" })).toBeInTheDocument();
    within(desktopTools).getByRole("button", { name: "Changes" }).click();
    expect(useWorkbench.getState().rightPanel).toBe("changes");
  });

  it("hands the empty case to whoever embedded it, when they have something to offer", async () => {
    window.location.hash = "";
    render(<App welcome={() => <p>先体验或登录</p>} />);

    // The workbench itself cannot get anyone out of "no machine yet" — only a
    // deployment that has accounts can. So it renders theirs, not its own
    // dead end.
    expect(await screen.findByText("先体验或登录")).toBeInTheDocument();
    expect(screen.queryByText(/没有可连接的机器/)).not.toBeInTheDocument();
  });

  it("says so plainly when nothing was injected", async () => {
    window.location.hash = "";
    render(<App />);

    expect(await screen.findByText(/没有可连接的机器/)).toBeInTheDocument();
  });

  it("blames the daemon, not the user, when the desktop app has no machine", async () => {
    // In the desktop app there is nothing to choose: this machine is the
    // machine. Telling someone to go and press 「连接」 while they are looking at
    // the thing that has that button is how a failed start reads as a step they
    // forgot — which is exactly what a packaged build did.
    const retry = vi.fn(async () => {});
    const openLogs = vi.fn();
    const problem = vi.fn(
      async () =>
        "daemon 启动超时（C:\\Program Files\\GeneHub\\bin\\genet-daemon.exe）",
    );
    render(
      <App
        host={{
          kind: "desktop",
          endpoint: async () => null,
          notify: () => {},
          openExternal: () => {},
          openLogs,
          problem,
          retry,
        }}
      />,
    );

    expect(await screen.findByText(/daemon 没有起来/)).toBeInTheDocument();
    // Awaited, not read straight away: the heading is on screen as soon as there
    // is no endpoint, while the reason has to come back from `problem()` — and
    // asserting it synchronously passed or failed depending on how loaded the
    // machine was.
    expect(await screen.findByText(/genet-daemon\.exe/)).toBeInTheDocument();
    expect(screen.queryByText(/没有可连接的机器/)).not.toBeInTheDocument();

    screen.getByRole("button", { name: "重试" }).click();
    await waitFor(() => expect(retry).toHaveBeenCalled());
    // Asked again afterwards: a retry that leaves a stale reason on screen is
    // indistinguishable from one that did nothing.
    await waitFor(() => expect(problem).toHaveBeenCalledTimes(2));

    // The one screen with no daemon to fetch a log from, which is why the
    // directory has to be openable from here.
    screen.getByRole("button", { name: "打开日志目录" }).click();
    expect(openLogs).toHaveBeenCalled();
  });

  it("mints the link before showing the page the tray sent it to", async () => {
    const claimLink = vi.fn(async () => null);
    useWorkbench.setState({ claimLink });
    let ask = () => {};
    const host = {
      kind: "browser" as const,
      endpoint: async () => ({
        url: ENDPOINT,
        via: "lan" as const,
        label: "测试机",
      }),
      notify: () => {},
      openExternal: () => {},
      onClaimRequested: (listener: () => void) => {
        ask = listener;
        return () => {};
      },
    };

    render(<App host={host} />);
    await screen.findByRole("status");
    ask();

    // Landing on settings with nothing new on it would look like the menu item
    // did nothing at all.
    expect(claimLink).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        useWorkbench.getState().tabs.some((tab) => tab.kind === "settings"),
      ).toBe(true),
    );
  });

  it("says why the tray's link could not be minted", async () => {
    // The common case for this: a machine that was never connected to a Hub, so
    // there is no identity to share. Swallowing that leaves a menu item that
    // looks broken rather than one that explained itself.
    useWorkbench.setState({
      claimLink: async () => {
        throw new Error("这台机器还没有连到 Hub");
      },
    });
    let ask = () => {};
    const host = {
      kind: "browser" as const,
      endpoint: async () => ({
        url: ENDPOINT,
        via: "lan" as const,
        label: "测试机",
      }),
      notify: () => {},
      openExternal: () => {},
      onClaimRequested: (listener: () => void) => {
        ask = listener;
        return () => {};
      },
    };

    render(<App host={host} />);
    await screen.findByRole("status");
    ask();

    expect(
      await screen.findByText("这台机器还没有连到 Hub"),
    ).toBeInTheDocument();
  });

  it("says the device was revoked rather than sending someone to check ports", async () => {
    // Driven through the real client: the socket connects, the machine refuses
    // the handshake, and the reason has to survive all the way to the screen.
    // The generic advice — "make sure the port is reachable" — is actively
    // misleading here, because the port is plainly fine.
    const queue = socketQueue();
    render(
      <App
        connect={(endpoint) =>
          new Client({ url: endpoint.url, socketFactory: queue.factory })
        }
      />,
    );

    await waitFor(() => expect(queue.sockets.length).toBe(1));
    const socket = queue.latest();
    socket.open();
    await waitFor(() => socket.lastOf("hello"));
    socket.fail(
      socket.lastOf("hello").id,
      "unauthorized",
      "这个设备已经不在这台机器的授权列表里",
    );

    expect(
      await screen.findByText("这个设备已经不在这台机器的授权列表里"),
    ).toBeInTheDocument();
    expect(screen.getByText(/重新配对/)).toBeInTheDocument();
    expect(screen.queryByText(/确认地址里的端口/)).not.toBeInTheDocument();
  });

  it("opens one connection and keeps it across re-renders", async () => {
    render(<App />);
    await screen.findByRole("status");

    // Something unrelated changes, the way an incoming event would change it.
    useWorkbench.setState({ notice: "anything" });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());

    expect(sockets).toBe(1);
  });
});
