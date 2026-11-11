import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MachineDirectoryLists } from "./MachineDirectoryLists";
import type { MachineSummaryDirectory } from "../protocol/summary-directory";
import { useWorkbench } from "../session/store";

/**
 * A cross-machine directory is a navigation surface. Row actions live in the
 * session and project pages, not on every row; expanding a team shows its
 * members only.
 */

const session = (id: string, workspaceId: string, title: string): SessionSummary => ({
  id, workspaceId, title, agentId: "genet", status: "idle", archived: false,
  createdAtMs: 0, updatedAtMs: 2_000, messagePreview: {itemId: `i-${id}`, text: id, atMs: 2_000},
} as unknown as SessionSummary);

const workspace = (id: string, name: string, parent?: string): WorkspaceInfo => ({
  id, name, root: `/data/${name}`, isGitRepo: true, folders: [{name, root: `/data/${name}`}],
  ...(parent ? {agentSpace: {parentWorkspaceId: parent, revision: 1, members: [], skills: [], guidance: []}} : {}),
} as unknown as WorkspaceInfo);

const root = workspace("root", "XWorld-hy");
const plain = workspace("plain", "dev-ui");
const child = workspace("actor", "actor", "root");
const teamSession = session("front", "root", "地图试玩第一轮");
const memberSession = session("inner", "actor", "第三人称玩家控制器模块");

const row = {
  target: {id: "m1", deviceHandle: "m1", label: "本机", online: true},
  state: "ready", stateSource: "directory" as const,
  observedAt: new Date(3_000).toISOString(), updatedAt: new Date(3_000).toISOString(),
  sessionTotal: 2, workspaceTotal: 2, activityComplete: true,
  sessions: [teamSession, memberSession], activeSessions: [],
  workspaces: [root, child, plain],
} as unknown as import("../protocol/summary-directory").MachineSummary;

const prefer = vi.fn();
const directory = {
  setIncludeArchived: vi.fn(), subscribe: (listener: (value: unknown) => void) => {
    listener({sources: [row], checked: 1, complete: true});
    return () => {};
  }, refresh: vi.fn(async () => {}),
  // Main's directory keeps preferred sources' live subscriptions first.
  prefer,
} as unknown as MachineSummaryDirectory;

const connections = {
  use: vi.fn(async () => {}), acquire: vi.fn(), targets: vi.fn(async () => []),
} as unknown as import("../protocol/machine-connections").MachineConnections;

const host = {label: "本机"} as unknown as import("../host").Endpoint;
const onOpen = vi.fn(async () => {});
const onNewSession = vi.fn();
const onAddProject = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useWorkbench.setState({
    client: null, connection: "ready", sessions: [], workspaces: [], agents: [],
    activeSessionId: null, sessionsCheckedAtMs: 0, sessionObservations: {},
  });
  vi.useFakeTimers({shouldAdvanceTime: true});
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderList(section: "sessions" | "projects") {
  return render(<MachineDirectoryLists connections={connections} directory={directory}
    endpoint={host} section={section} open hidden={false}
    onOpen={onOpen} onNewSession={onNewSession} onAddProject={onAddProject} />);
}

describe("project rows", () => {
  it("has no per-row overflow menu or separate right-side arrow; the row itself opens the project", async () => {
    renderList("projects");
    const project = screen.getByRole("region", {name: "项目 XWorld-hy"});
    expect(within(project).queryByRole("button", {name: "项目操作"})).not.toBeInTheDocument();
    expect(project.querySelector("div")?.querySelectorAll("button").length).toBe(2); // chevron + row button only
    expect(within(project).getByRole("button", {name: "打开项目 XWorld-hy"})).toBeTruthy();
    await userEvent.click(within(project).getByRole("button", {name: "打开项目 XWorld-hy"}));
    expect(onOpen).toHaveBeenCalledWith(row.target, undefined, "root", expect.anything());
  });

  it("expands to members only and clicking a member opens its Space page", async () => {
    renderList("projects");
    const project = screen.getByRole("region", {name: "项目 XWorld-hy"});
    expect(within(project).queryByText("地图试玩第一轮")).not.toBeInTheDocument();
    expect(within(project).queryByText("第三人称玩家控制器模块")).not.toBeInTheDocument();
    await userEvent.click(within(project).getByRole("button", {name: "展开成员 XWorld-hy"}));
    expect(within(project).queryByText("地图试玩第一轮")).not.toBeInTheDocument();
    const member = within(project).getByRole("button", {name: "打开成员 actor"});
    await userEvent.click(member);
    expect(onOpen).toHaveBeenCalledWith(row.target, undefined, "actor", expect.anything());
  });

  it("keeps main's preferred-source wiring when a team is expanded", async () => {
    renderList("projects");
    expect(prefer).toHaveBeenCalled();
    const before = prefer.mock.calls.length;
    await userEvent.click(screen.getByRole("button", {name: "展开成员 XWorld-hy"}));
    expect(prefer.mock.calls.length).toBeGreaterThan(before);
    // The local machine and the visible member sources stay preferred.
    expect(prefer.mock.lastCall?.[0]).toContain("m1");
  });

  it("needs no expansion control on a project without members", () => {
    renderList("projects");
    expect(screen.getByRole("region", {name: "项目 dev-ui"})).toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "展开成员 dev-ui"})).not.toBeInTheDocument();
  });
});

describe("session rows", () => {
  it("has no per-row overflow menu and opens the session directly", async () => {
    renderList("sessions");
    expect(screen.queryByRole("button", {name: "会话操作"})).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", {name: "打开会话 地图试玩第一轮"}));
    expect(onOpen).toHaveBeenCalledWith(row.target, "front", undefined, expect.anything());
  });
});
