import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Endpoint, Host, WindowControls } from "../host";
import { useWorkbench } from "../session/store";
import { useTheme } from "../theme/store";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

/**
 * The two pieces of chrome around the workbench.
 *
 * Both exist because of the same complaint: the window did not look or read
 * like one application. The left edge hid every workspace but one behind a
 * dropdown, and the strip along the top was drawn by the OS in the OS's own
 * colours.
 */

const workspace = (id: string, name: string): WorkspaceInfo => ({
  id,
  name,
  root: `/home/me/${name}`,
  isGitRepo: true,
  folders: [{ name, root: "/home/me/" + name, rootHandle: `r_${id}` }],
});

const session = (id: string, workspaceId: string, title: string, running = false): SessionSummary => ({
  id,
  workspaceId,
  agentId: "genet",
  title,
  createdAtMs: 0,
  updatedAtMs: 0,
  archived: false,
  status: running ? "running" : "idle",
});

const host = (overrides: Partial<Host> = {}): Host => ({
  kind: "browser",
  endpoint: async () => ({ url: "ws://127.0.0.1:1/ws", via: "loopback", label: "本机" }),
  notify: () => {},
  openExternal: () => {},
  ...overrides,
});

const localEndpoint: Endpoint = {
  url: "ws://127.0.0.1:1/ws",
  via: "loopback",
  label: "本机",
};

const controls = (): WindowControls => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(async () => true),
  isMaximized: vi.fn(async () => false),
  close: vi.fn(),
  setBackground: vi.fn(),
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "dark";
  useTheme.setState({ preference: "system", resolved: "dark" });
  useWorkbench.setState({
    connection: "ready",
    workspaces: [workspace("w1", "genethub"), workspace("w2", "paseo"), workspace("w3", "demo")],
    activeWorkspaceId: "w1",
    sessions: [
      session("s1", "w1", "修复移动端横向拖动", true),
      session("s2", "w1", "更新流程"),
      session("s3", "w2", "relay 重连"),
    ],
    activeSessionId: "s1",
    agents: [],
    tabs: [],
    activeTabId: null,
    draft: null,
    selectSession: vi.fn(async () => {}),
    selectWorkspace: vi.fn(async () => {}),
    newSession: vi.fn(),
    openTab: vi.fn(),
    renameSession: vi.fn(async () => true),
    renameWorkspace: vi.fn(async () => {}),
    removeWorkspace: vi.fn(async () => {}),
    configureAgentSpace: vi.fn(async () => {}),
    inspectAgentSpaceBuild: vi.fn(async () => null),
    deleteSession: vi.fn(async () => {}),
  });
});

afterEach(() => {
  cleanup();
});

function sidebar() { render(<Sidebar host={host()} open onNavigate={() => {}} />); }

describe("what can be done to one conversation", () => {
  const openMenu = async (name: string) =>
    userEvent.click(screen.getByRole("button", { name: `${name} 的更多操作` }));

  it("renames it in place, and sends the new name to the machine", async () => {
    sidebar();
    await openMenu("更新流程");
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));

    const field = screen.getByLabelText("会话名称");
    await userEvent.clear(field);
    await userEvent.type(field, "发布收尾{Enter}");

    expect(useWorkbench.getState().renameSession).toHaveBeenCalledWith("s2", "发布收尾");
  });

  it("leaves the name alone when the edit is abandoned", async () => {
    sidebar();
    await openMenu("更新流程");
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    await userEvent.type(screen.getByLabelText("会话名称"), "改一半{Escape}");

    expect(useWorkbench.getState().renameSession).not.toHaveBeenCalled();
    expect(screen.getByText("更新流程")).toBeInTheDocument();
  });

  it("opens one conversation's process dialog from its own menu", async () => {
    sidebar();
    await openMenu("更新流程");
    await userEvent.click(screen.getByRole("menuitem", { name: "后台进程" }));

    expect(screen.getByRole("dialog", { name: "会话的后台进程" })).toBeInTheDocument();
    expect(screen.getByText(/更新流程 · 只显示这个会话/)).toBeInTheDocument();
  });

  it("asks once before deleting, because there is no way back", async () => {
    sidebar();
    await openMenu("更新流程");
    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(useWorkbench.getState().deleteSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: "确认删除" }));
    expect(useWorkbench.getState().deleteSession).toHaveBeenCalledWith("s2");
  });

  it("lets the question be dropped", async () => {
    sidebar();
    await openMenu("更新流程");
    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "取消" }));

    expect(useWorkbench.getState().deleteSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

/**
 * "移动端比例下的 tab 栏体验很差，空间太小了".
 *
 * The phone no longer keeps a strip. The header title is the switcher: one
 * line while closed, a list when opened, and the running/done counts stay
 * visible so the open set is still readable without the strip.
 */
describe("the strip along the top", () => {
  it("is not drawn where the window belongs to a browser", () => {
    render(
      <TitleBar
        host={host()}
        endpoint={localEndpoint}
        sidebarHidden={false}
        onToggleSidebar={() => {}}
      />,
    );

    expect(screen.queryByRole("menubar")).not.toBeInTheDocument();
  });

  it("minimises, maximises and closes through the shell", async () => {
    const window = controls();
    render(
      <TitleBar
        host={host({ window })}
        endpoint={localEndpoint}
        sidebarHidden={false}
        onToggleSidebar={() => {}}
      />,
    );

    await userEvent.click(screen.getByLabelText("最小化"));
    await userEvent.click(screen.getByLabelText("最大化"));
    await userEvent.click(screen.getByLabelText("关闭"));

    expect(window.minimize).toHaveBeenCalled();
    expect(window.toggleMaximize).toHaveBeenCalled();
    // Closing is the shell's decision, not ours: on the desktop it hides the
    // window and leaves the daemon running, which is what the tray is for.
    expect(window.close).toHaveBeenCalled();
  });

  it("switches the palette from the 视图 menu", async () => {
    render(
      <TitleBar
        host={host({ window: controls() })}
        endpoint={localEndpoint}
        sidebarHidden={false}
        onToggleSidebar={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("menuitem", { name: "视图" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "亮色" }));

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not offer the local folder picker while connected to a remote machine", async () => {
    const pickDirectory = vi.fn(async () => "/local/path");
    render(
      <TitleBar
        host={host({ window: controls(), pickDirectory })}
        endpoint={{ url: "wss://relay.test", via: "relay", label: "工作电脑" }}
        sidebarHidden={false}
        onToggleSidebar={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("menuitem", { name: "文件" }));
    expect(screen.getByRole("menuitem", { name: "打开专家…" })).toBeDisabled();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it("offers to give the left column's room back, and says which way round it is", async () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = render(
      <TitleBar
        host={host({ window: controls() })}
        endpoint={localEndpoint}
        sidebarHidden={false}
        onToggleSidebar={onToggleSidebar}
      />,
    );

    await userEvent.click(screen.getByRole("menuitem", { name: "视图" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "隐藏左栏" }));
    expect(onToggleSidebar).toHaveBeenCalled();

    rerender(
      <TitleBar
        host={host({ window: controls() })}
        endpoint={localEndpoint}
        sidebarHidden
        onToggleSidebar={onToggleSidebar}
      />,
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "视图" }));
    expect(screen.getByRole("menuitem", { name: "显示左栏" })).toBeInTheDocument();
  });
});
