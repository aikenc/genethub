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

  it("reports an E2EE identity failure rather than blaming network reachability", async () => {
    const queue = socketQueue({ secret: "wrong-secret" });
    const host = {
      kind: "browser" as const,
      endpoint: async () => ({
        url: ENDPOINT,
        via: "relay" as const,
        label: "测试机",
        credential: { deviceId: "d_1", secret: "expected-secret" },
      }),
      notify: () => {},
      openExternal: () => {},
    };
    render(
      <App
        host={host}
        connect={(endpoint) => new Client({
          url: endpoint.url,
          credential: endpoint.credential,
          socketFactory: queue.factory,
          rtcEnabled: false,
        })}
      />,
    );

    await waitFor(() => expect(queue.sockets.length).toBe(1));
    const socket = queue.latest();
    socket.open();
    await waitFor(() => socket.lastOf("hello"));
    socket.acceptHandshake("wrong-secret");

    expect(
      await screen.findByText(/端到端身份验证/),
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
