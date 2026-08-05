import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Endpoint, Host, WindowControls } from "../host";
import { useWorkbench } from "../session/store";
import { useTheme } from "../theme/store";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TitleBar } from "./TitleBar";

/**
 * The two pieces of chrome around the workbench.
 *
 * Both exist because of the same complaint: the window did not look or read
 * like one application. The left edge hid every project but one behind a
 * dropdown, and the strip along the top was drawn by the OS in the OS's own
 * colours.
 */

const workspace = (id: string, name: string): WorkspaceInfo => ({
  id,
  name,
  root: `/home/me/${name}`,
  isGitRepo: true,
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
    renameSession: vi.fn(async () => {}),
    renameWorkspace: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  });
});

function sidebar() {
  render(<Sidebar host={host()} open onNavigate={() => {}} />);
  return screen.getByRole("list", { name: "工作区" });
}

/** The project rows, which are the tree's own children — sessions nest inside. */
const projectRows = (tree: HTMLElement) => Array.from(tree.children) as HTMLElement[];

describe("the left edge", () => {
  it("puts each session under the project it belongs to", () => {
    const projects = projectRows(sidebar());

    expect(within(projects[0]!).getByText("genethub")).toBeInTheDocument();
    expect(within(projects[0]!).getByText("修复移动端横向拖动")).toBeInTheDocument();
    // The other project's session is on screen too — which is the point — but
    // under its own heading, not mixed into this one.
    expect(within(projects[0]!).queryByText("relay 重连")).not.toBeInTheDocument();
    expect(within(projects[1]!).getByText("relay 重连")).toBeInTheDocument();
  });

  it("says so rather than showing an empty gap for a project with nothing in it", () => {
    const empty = projectRows(sidebar())[2]!;

    expect(within(empty).getByText("demo")).toBeInTheDocument();
    expect(within(empty).getByText("还没有会话")).toBeInTheDocument();
  });

  it("opens a roomy recent-session list with each conversation's workspace", async () => {
    sidebar();

    await userEvent.click(screen.getByRole("button", { name: /最近会话/ }));

    const dialog = screen.getByRole("dialog", { name: "最近会话" });
    expect(within(dialog).getByText("修复移动端横向拖动")).toBeInTheDocument();
    expect(within(dialog).getByText(/paseo ·/)).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: "运行中" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /relay 重连/ }));
    expect(useWorkbench.getState().selectSession).toHaveBeenCalledWith("s3");
  });

  it("counts what is running, and only where something is", () => {
    const projects = projectRows(sidebar());

    expect(within(projects[0]!).getByText("1")).toBeInTheDocument();
    expect(within(projects[1]!).queryByText("1")).not.toBeInTheDocument();
  });

  it("folds a project away and remembers it", async () => {
    sidebar();
    await userEvent.click(screen.getByLabelText("折叠 genethub"));

    expect(screen.queryByText("修复移动端横向拖动")).not.toBeInTheDocument();
    expect(localStorage.getItem("genehub.sidebar.collapsed")).toBe('["w1"]');
  });

  it("renames a workspace in place", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "genethub 的目录操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const field = screen.getByLabelText("工作区名称");
    await userEvent.clear(field);
    await userEvent.type(field, "核心项目{Enter}");

    expect(useWorkbench.getState().renameWorkspace).toHaveBeenCalledWith("w1", "核心项目");
  });

  it("shows a workspace's name, full path and owning device", async () => {
    render(
      <Sidebar
        host={host()}
        endpoint={{ url: "ws://127.0.0.1/ws", via: "loopback", label: "开发工作站" }}
        open
        onNavigate={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "genethub 的目录操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "详情" }));

    const details = screen.getByText("目录详情").parentElement?.parentElement;
    expect(details).toHaveTextContent("名称genethub");
    expect(details).toHaveTextContent("完整路径/home/me/genethub");
    expect(details).toHaveTextContent("所属设备开发工作站");
  });

  it("reaches into folded projects when searching, or the search finds nothing", async () => {
    sidebar();
    await userEvent.click(screen.getByLabelText("折叠 genethub"));
    await userEvent.type(screen.getByLabelText("搜索会话"), "更新");

    expect(screen.getByText("更新流程")).toBeInTheDocument();
    expect(screen.queryByText("relay 重连")).not.toBeInTheDocument();
  });

  it("still answers the other question: what is running, across every project", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "按状态" }));

    expect(screen.getByText("运行中")).toBeInTheDocument();
    // A title on its own does not say where the work is happening, so the
    // project comes with it once the tree is not there to say.
    expect(screen.getAllByText("paseo").length).toBeGreaterThan(0);
  });

  it("shows five named session states instead of ambiguous coloured dots", () => {
    localStorage.setItem("genehub.sidebar.read-at.initialized", "true");
    localStorage.setItem("genehub.sidebar.read-at", JSON.stringify({ read: 20, unread: 5 }));
    useWorkbench.setState({
      activeSessionId: null,
      sessions: [
        { ...session("unread", "w1", "未读"), updatedAtMs: 10 },
        { ...session("read", "w1", "已读"), updatedAtMs: 10 },
        { ...session("running", "w1", "执行"), status: "running" },
        { ...session("waiting", "w1", "审批"), status: "waiting" },
        { ...session("failed", "w1", "故障"), status: "failed" },
      ],
    });

    sidebar();

    for (const label of ["已完成未阅读", "已完成已阅读", "运行中", "等待交互", "运行异常"]) {
      expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    }
  });

  it("writes nothing to the machine when a new conversation is opened", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));

    expect(useWorkbench.getState().newSession).toHaveBeenCalledWith("w1", null);
  });
});

describe("chat tab state", () => {
  it("shows the same status marker that is used by the session lists", () => {
    useWorkbench.setState({
      tabs: [
        { id: "chat:s1", kind: "chat", title: "执行中的会话", sessionId: "s1" },
        { id: "chat:s2", kind: "chat", title: "失败的会话", sessionId: "s2" },
      ],
      activeTabId: "chat:s1",
      sessions: [
        { ...session("s1", "w1", "执行中的会话"), status: "running" },
        { ...session("s2", "w1", "失败的会话"), status: "failed" },
      ],
    });

    render(<TabBar />);

    expect(screen.getByRole("img", { name: "运行中" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "运行异常" })).toBeInTheDocument();
  });
});

/**
 * "会话没有删除和重命名功能".
 *
 * Both live on the row itself and both are reachable by touch: a phone cannot
 * hover, and hiding the only way to get rid of a conversation behind hover is
 * how this ended up unreachable rather than merely missing.
 */
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
    expect(screen.getByRole("menuitem", { name: "打开项目…" })).toBeDisabled();
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
