import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Endpoint, Host, WindowControls } from "../host";
import { useWorkbench } from "../session/store";
import { useTheme } from "../theme/store";
import { countTabSet, MobileTitleSwitcher } from "./MobileTitleSwitcher";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
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
    renameSession: vi.fn(async () => {}),
    renameWorkspace: vi.fn(async () => {}),
    removeWorkspace: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
  });
});

afterEach(() => {
  cleanup();
});

function sidebar() {
  render(<Sidebar host={host()} open onNavigate={() => {}} />);
  return screen.getByRole("list", { name: "工作区" });
}

/** The workspace rows, which are the tree's own children — sessions nest inside. */
const projectRows = (tree: HTMLElement) => Array.from(tree.children) as HTMLElement[];

describe("the left edge", () => {
  it("puts each session under the workspace it belongs to", () => {
    const projects = projectRows(sidebar());

    expect(within(projects[0]!).getByText("genethub")).toBeInTheDocument();
    expect(within(projects[0]!).getByText("修复移动端横向拖动")).toBeInTheDocument();
    // The other project's session is on screen too — which is the point — but
    // under its own heading, not mixed into this one.
    expect(within(projects[0]!).queryByText("relay 重连")).not.toBeInTheDocument();
    expect(within(projects[1]!).getByText("relay 重连")).toBeInTheDocument();
  });

  it("says so rather than showing an empty gap for a workspace with nothing in it", () => {
    const empty = projectRows(sidebar())[2]!;

    expect(within(empty).getByText("demo")).toBeInTheDocument();
    expect(within(empty).getByText("还没有会话")).toBeInTheDocument();
  });

  it("shows every recent session in the shared grouping control", async () => {
    sidebar();

    await userEvent.click(screen.getByRole("button", { name: "会话分组" }));
    await userEvent.click(screen.getByRole("option", { name: "最近" }));

    const recent = screen.getByRole("list", { name: "最近会话" });
    expect(within(recent).getByText("修复移动端横向拖动")).toBeInTheDocument();
    expect(within(recent).getAllByText("paseo").length).toBeGreaterThan(0);
    expect(within(recent).getByRole("img", { name: "运行中" })).toBeInTheDocument();
    await userEvent.click(within(recent).getByText("relay 重连").closest("button")!);
    expect(useWorkbench.getState().selectSession).toHaveBeenCalledWith("s3");
  });

  it("shows five recent sessions per project and remembers expansion", async () => {
    useWorkbench.setState({
      sessions: Array.from({ length: 7 }, (_, index) => ({
        ...session(`s${index}`, "w1", `会话 ${index}`),
        updatedAtMs: index,
      })),
    });
    const projects = projectRows(sidebar());

    expect(within(projects[0]!).queryByText("会话 0")).not.toBeInTheDocument();
    expect(within(projects[0]!).getByText("会话 6")).toBeInTheDocument();
    await userEvent.click(within(projects[0]!).getByRole("button", { name: "展开其余 2 个" }));

    expect(within(projects[0]!).getByText("会话 0")).toBeInTheDocument();
    expect(localStorage.getItem("genehub.sidebar.expanded-projects")).toBe('["w1"]');
  });

  it("shows a session a newer build wrote, and refuses to pretend it can open it", async () => {
    // Sessions live in the workspace, so a beta and a release share them.
    // A conversation the release cannot read must not simply disappear from
    // the list — the user would have nowhere to ask where it went.
    useWorkbench.setState({
      sessions: [
        { ...session("s9", "w1", "在 beta 里聊的"), unsupported: { written: 5, supported: 4 } },
      ],
    });
    const projects = projectRows(sidebar());

    const row = within(projects[0]!).getByRole("button", { name: /在 beta 里聊的 需升级/ });
    expect(row).toBeDisabled();
    expect(row).toHaveAccessibleDescription(/数据格式 5/);
    await userEvent.click(row);
    expect(useWorkbench.getState().selectSession).not.toHaveBeenCalled();
  });

  it("counts what is running, and only where something is", () => {
    const projects = projectRows(sidebar());

    expect(within(projects[0]!).getByText("1")).toBeInTheDocument();
    expect(within(projects[1]!).queryByText("1")).not.toBeInTheDocument();
  });

  it("folds a workspace away and remembers it", async () => {
    sidebar();
    await userEvent.click(screen.getByLabelText("折叠 genethub"));

    expect(screen.queryByText("修复移动端横向拖动")).not.toBeInTheDocument();
    expect(localStorage.getItem("genehub.sidebar.collapsed")).toBe('["w1"]');
  });

  it("renames a workspace in place", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "genethub 的工作区操作" }));
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
    await userEvent.click(screen.getByRole("button", { name: "genethub 的工作区操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "详情" }));

    const details = screen.getByText("工作区详情").parentElement?.parentElement;
    expect(details).toHaveTextContent("名称genethub");
    expect(details).toHaveTextContent("Agent 工作区路径/home/me/genethub");
    expect(details).toHaveTextContent("所属设备开发工作站");
  });

  it("distinguishes folders from saved workspaces and removes only after confirmation", async () => {
    const saved = {
      ...workspace("w2", "paseo"),
      workspaceFile: "/home/me/paseo.code-workspace",
    };
    useWorkbench.setState((state) => ({
      workspaces: [state.workspaces[0]!, saved, state.workspaces[2]!],
    }));
    const tree = sidebar();
    expect(tree.querySelectorAll('[data-workspace-icon="folder"]')).toHaveLength(2);
    expect(tree.querySelectorAll('[data-workspace-icon="workspace"]')).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "demo 的工作区操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "从列表移除" }));
    expect(screen.getByText(/文件和会话不会删除/)).toBeInTheDocument();
    expect(useWorkbench.getState().removeWorkspace).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(useWorkbench.getState().removeWorkspace).toHaveBeenCalledWith("w3");
  });

  it("reaches into folded projects when searching, or the search finds nothing", async () => {
    sidebar();
    await userEvent.click(screen.getByLabelText("折叠 genethub"));
    await userEvent.click(screen.getByRole("button", { name: "会话与工作区" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "搜索会话" }));
    await userEvent.type(screen.getByLabelText("搜索会话"), "更新");

    expect(screen.getByText("更新流程")).toBeInTheDocument();
    expect(screen.queryByText("relay 重连")).not.toBeInTheDocument();
  });

  it("still answers the other question: what is running, across every workspace", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "会话分组" }));
    await userEvent.click(screen.getByRole("option", { name: "按状态" }));

    expect(screen.getByText("运行中")).toBeInTheDocument();
    // A title on its own does not say where the work is happening, so the
    // workspace comes with it once the tree is not there to say.
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
    expect(screen.getByRole("img", { name: "运行中" }).querySelector(".animate-spin")).not.toBeNull();
  });

  it("writes nothing to the machine when a new conversation is opened", async () => {
    sidebar();
    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));

    expect(useWorkbench.getState().newSession).toHaveBeenCalledWith("w1", null);
  });

  it("opens search and import from the overflow next to 新建会话", async () => {
    sidebar();
    expect(screen.queryByLabelText("搜索会话")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "会话与工作区" }));
    expect(screen.getByRole("menuitem", { name: "打开工作区" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "导入会话" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "设备" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "搜索会话" }));

    expect(screen.getByLabelText("搜索会话")).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "会话与工作区" })).not.toBeInTheDocument();
  });

  it("keeps the list titled 会话 and groups from a dropdown", async () => {
    render(<Sidebar host={host()} open endpoint={localEndpoint} onNavigate={() => {}} />);

    expect(screen.getByText("会话", { selector: "span" })).toHaveClass("text-sm");
    expect(screen.queryByRole("button", { name: "打开工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "会话分组" })).toHaveTextContent("按工作区");

    await userEvent.click(screen.getByRole("button", { name: "会话与工作区" }));
    const menu = screen.getByRole("menu", { name: "会话与工作区" });
    expect(within(menu).getByRole("menuitem", { name: "打开工作区" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "导入会话" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "搜索会话" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "文件" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "设置" })).not.toBeInTheDocument();
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

  it("prefixes built-in surfaces so they do not read as another chat", () => {
    useWorkbench.setState({
      tabs: [
        { id: "chat:s1", kind: "chat", title: "修登录", sessionId: "s1" },
        { id: "files", kind: "files", title: "文件" },
        { id: "settings", kind: "settings", title: "设置" },
      ],
      activeTabId: "files",
      sessions: [{ ...session("s1", "w1", "修登录"), status: "idle" }],
    });

    render(<TabBar />);

    expect(screen.getByTestId("tab-icon-files")).toBeInTheDocument();
    expect(screen.getByTestId("tab-icon-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-icon-chat")).not.toBeInTheDocument();
  });

  it("puts the workspace name and icon on the right of session and surface titles", () => {
    useWorkbench.setState({
      tabs: [
        { id: "chat:s1", kind: "chat", title: "改进UI体验", sessionId: "s1" },
        { id: "files", kind: "files", title: "工作区文件" },
      ],
      activeTabId: "chat:s1",
      sessions: [{ ...session("s1", "w1", "改进UI体验"), status: "idle" }],
    });

    render(<TabBar />);

    expect(screen.getByRole("button", { name: "改进UI体验" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件" })).toBeInTheDocument();
    const marks = screen.getAllByTitle("genethub");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.tagName).toBe("SPAN");
      expect(mark).toHaveClass("pointer-events-none");
      expect(mark.closest("button")).toHaveAccessibleName(/改进UI体验|文件/);
    }
    expect(screen.queryByTitle("paseo")).not.toBeInTheDocument();
  });

  it("activates the tab when the pointer lands on the workspace name", () => {
    const activateTab = vi.fn();
    useWorkbench.setState({
      activateTab,
      tabs: [{ id: "chat:s1", kind: "chat", title: "改进UI体验", sessionId: "s1" }],
      activeTabId: "chat:s1",
      sessions: [{ ...session("s1", "w1", "改进UI体验"), status: "idle" }],
    });

    render(<TabBar />);
    fireEvent.click(screen.getByTitle("genethub"));

    expect(activateTab).toHaveBeenCalledWith("chat:s1");
  });

  it("gives the session title the leftover room and stamps a compact age", () => {
    useWorkbench.setState({
      tabs: [
        { id: "chat:s1", kind: "chat", title: "改进UI体验", sessionId: "s1" },
        { id: "files", kind: "files", title: "文件" },
      ],
      activeTabId: "chat:s1",
      sessions: [
        {
          ...session("s1", "w1", "改进UI体验"),
          updatedAtMs: Date.now() - 3 * 60_000,
        },
      ],
    });

    render(<TabBar />);

    const tab = screen.getByRole("button", { name: "改进UI体验" }).closest("div")!;
    expect(tab).toHaveClass("gap-0.5", "md:max-w-[22rem]", "md:pl-2", "md:pr-0.5");
    expect(screen.getByText("3m")).toHaveClass("hidden", "md:inline");
    expect(screen.getByText("3m").closest("button")).toHaveAccessibleName("改进UI体验");
  });
});

/**
 * "会话的tab栏不能上下滑动", "移动端目前只能显示两个tab".
 *
 * Both are the same strip failing to behave like one: it took its width from
 * the titles, so a phone ran out of room after two, and the only device most
 * people point at it with — a wheel that goes up and down — could not reach
 * whatever that pushed off the right edge.
 */
describe("the tab strip when the tabs outrun the room", () => {
  /** jsdom does no layout, so the strip is told how much of it is off screen. */
  const measure = (
    element: HTMLElement,
    { scrollWidth, clientWidth, scrollLeft = 0 }: Record<string, number>,
  ) => {
    let position = scrollLeft;
    Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
    Object.defineProperty(element, "scrollLeft", {
      configurable: true,
      get: () => position,
      set: (next: number) => {
        position = next;
      },
    });
  };

  const wheel = (element: HTMLElement, delta: Partial<WheelEventInit>) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...delta });
    element.dispatchEvent(event);
    return event;
  };

  const strip = (count = 6) => {
    useWorkbench.setState({
      tabs: Array.from({ length: count }, (_, index) => ({
        id: `chat:s${index}`,
        kind: "chat" as const,
        title: `会话 ${index}`,
        sessionId: `s${index}`,
      })),
      activeTabId: "chat:s0",
    });
    render(<TabBar />);
    return screen.getByRole("button", { name: "会话 0" }).closest("div")!.parentElement!;
  };

  it("gives every tab the same share of a phone, sized so a fourth one peeks in", () => {
    strip();

    const tab = screen.getByRole("button", { name: "会话 0" }).closest("div")!;
    // Three whole tabs and half of the next: enough of the fourth is visible to
    // say the strip continues, which is the part two full-width tabs never did.
    expect(tab).toHaveClass("w-[28.5%]", "shrink-0", "grow");
    // A desktop keeps its title-shaped tabs, with room for the session name.
    expect(tab).toHaveClass("md:w-auto", "md:max-w-[22rem]", "md:shrink", "md:grow-0");
  });

  it("never grows a vertical scrollbar beside the strip", () => {
    const element = strip();

    // overflow-x alone would promote overflow-y to auto and paint a thumb on
    // the right edge of a row that only moves sideways.
    expect(element).toHaveClass("overflow-x-auto", "overflow-y-hidden");
    expect(element.parentElement).toHaveClass("overflow-hidden");
  });

  it("lets the close control out of the 44px square the phone gives every button", () => {
    strip();

    // Three of those squares are the whole strip; the row's own height is what
    // keeps this hittable.
    expect(screen.getByRole("button", { name: "关闭 会话 0" })).toHaveClass(
      "h-11",
      "w-6",
      "!min-h-0",
      "!min-w-0",
    );
  });

  it("reads at 0.75rem on every screen without shortening the strip", () => {
    const bar = strip().parentElement!;

    // Written out, not `text-xs`: the shared phone typography lifts that class
    // to 14px, which is how the strip ended up at body-copy size.
    expect(screen.getByRole("button", { name: "会话 0" }).closest("div")!).toHaveClass(
      "text-[0.75rem]",
    );
    expect(bar).toHaveClass("h-11", "md:h-9");
  });

  it("travels sideways when the wheel has only up and down to offer", () => {
    const element = strip();
    measure(element, { scrollWidth: 900, clientWidth: 400 });

    const event = wheel(element, { deltaY: 120 });

    expect(element.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a sideways gesture to the strip's own scrolling", () => {
    const element = strip();
    measure(element, { scrollWidth: 900, clientWidth: 400 });

    const event = wheel(element, { deltaX: 90, deltaY: 10 });

    expect(element.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("hands the gesture back to the page once the strip has nowhere left to go", () => {
    const element = strip();
    measure(element, { scrollWidth: 900, clientWidth: 400, scrollLeft: 500 });

    const event = wheel(element, { deltaY: 120 });

    expect(element.scrollLeft).toBe(500);
    expect(event.defaultPrevented).toBe(false);
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
describe("switching tabs from the phone title", () => {
  const openTabs = (
    extras: Partial<Parameters<typeof useWorkbench.setState>[0]> = {},
  ) => {
    useWorkbench.setState({
      tabs: [
        { id: "chat:s1", kind: "chat", title: "修复移动端横向拖动", sessionId: "s1" },
        { id: "chat:s2", kind: "chat", title: "更新流程", sessionId: "s2" },
        { id: "files", kind: "files", title: "文件" },
      ],
      activeTabId: "chat:s1",
      sessions: [
        { ...session("s1", "w1", "修复移动端横向拖动"), status: "running" },
        { ...session("s2", "w1", "更新流程"), status: "idle" },
      ],
      ...extras,
    });
  };

  it("stays a single line of text when there is nothing to switch", () => {
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    expect(screen.getByText("工作台")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /切换已打开的标签/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /关闭当前标签/ })).not.toBeInTheDocument();
  });

  it("keeps a built-in prefix on the phone title, including when it is the only tab", () => {
    useWorkbench.setState({
      tabs: [{ id: "settings", kind: "settings", title: "设置" }],
      activeTabId: "settings",
      sessions: [],
    });
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    expect(screen.getByTestId("tab-icon-settings")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();
  });

  it("keeps the current title, a chevron and the open-set counts on one row", () => {
    openTabs();
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    const switcher = screen.getByRole("button", {
      name: "切换已打开的标签，当前 修复移动端横向拖动，1 个进行中，1 个已完成，共 3 个",
    });
    expect(switcher).toHaveClass("h-11", "flex-1");
    expect(switcher.querySelector(".truncate")).toHaveTextContent("修复移动端横向拖动");
    expect(switcher.querySelector("[data-workspace-affordance]")).not.toBeNull();
    expect(switcher).toHaveTextContent("1");
    expect(switcher).toHaveTextContent("✓1");
  });

  it("opens the set from the title and moves to the tab that was tapped", async () => {
    openTabs();
    const activateTab = vi.fn();
    useWorkbench.setState({ activateTab });
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    await userEvent.click(screen.getByRole("button", { name: /切换已打开的标签/ }));

    expect(screen.getByRole("listbox", { name: "已打开的标签" })).toHaveTextContent(
      "点一项打开 · 右侧关闭",
    );
    await userEvent.click(screen.getByRole("option", { name: /更新流程/ }));

    expect(activateTab).toHaveBeenCalledWith("chat:s2");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the current tab from the title row without opening the list", async () => {
    openTabs();
    const closeTab = vi.fn();
    useWorkbench.setState({ closeTab });
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    await userEvent.click(screen.getByRole("button", { name: "关闭当前标签 修复移动端横向拖动" }));

    expect(closeTab).toHaveBeenCalledWith("chat:s1");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes a tab from the list without leaving the phone guessing how", async () => {
    openTabs();
    const closeTab = vi.fn();
    useWorkbench.setState({ closeTab });
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    await userEvent.click(screen.getByRole("button", { name: /切换已打开的标签/ }));
    await userEvent.click(screen.getByRole("button", { name: "关闭 文件" }));

    expect(closeTab).toHaveBeenCalledWith("files");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("hides the compact age until the title list is open", async () => {
    openTabs({
      sessions: [
        {
          ...session("s1", "w1", "修复移动端横向拖动"),
          status: "running",
          updatedAtMs: Date.now() - 3 * 60_000,
        },
        { ...session("s2", "w1", "更新流程"), updatedAtMs: Date.now() - 2 * 60 * 60_000 },
      ],
    });
    render(<MobileTitleSwitcher fallbackTitle="工作台" />);

    expect(screen.queryByText("3m")).not.toBeInTheDocument();
    expect(screen.queryByText("2h")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("genethub"));

    expect(screen.getByRole("listbox", { name: "已打开的标签" })).toBeInTheDocument();
    expect(screen.getByText("3m")).toBeInTheDocument();
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("counts only chat tabs, and treats waiting as still in flight", () => {
    expect(
      countTabSet(
        [
          { id: "chat:s1", kind: "chat", title: "a", sessionId: "s1" },
          { id: "chat:s2", kind: "chat", title: "b", sessionId: "s2" },
          { id: "chat:s3", kind: "chat", title: "c", sessionId: "s3" },
          { id: "files", kind: "files", title: "文件" },
        ],
        [
          { ...session("s1", "w1", "a"), status: "waiting" },
          { ...session("s2", "w1", "b"), status: "failed" },
          { ...session("s3", "w1", "c"), status: "idle" },
        ],
      ),
    ).toEqual({ running: 1, completed: 2 });
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
    expect(screen.getByRole("menuitem", { name: "打开工作区…" })).toBeDisabled();
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
