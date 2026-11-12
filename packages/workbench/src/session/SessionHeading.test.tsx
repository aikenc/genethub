import type { SessionSummary } from "@genehub/proto";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SessionHeading } from "./SessionHeading";
import { sessionPinned } from "./session-preferences";
import { useWorkbench } from "./store";

const session = {
  id: "s1", workspaceId: "w1", title: "地图试玩", agentId: "genet", status: "idle",
  createdAtMs: 0, updatedAtMs: 0, archived: false,
} as unknown as SessionSummary;

beforeEach(() => {
  localStorage.clear();
  useWorkbench.setState({ client: {identity: {machineId: "m1"}} as never, workspaces: [], sessions: [], agents: [], tabs: [], activeTabId: null });
});

afterEach(() => cleanup());

it("puts the session pin action in the session page menu, not on the row", async () => {
  const onOpenExpert = vi.fn();
  render(<SessionHeading session={session} onOpenExpert={onOpenExpert} machineName="本机" />);
  expect(screen.getByRole("button", {name: "会话菜单"})).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", {name: "会话菜单"}));
  await userEvent.click(screen.getByRole("menuitem", {name: "置顶会话"}));
  expect(sessionPinned("m1", "s1")).toBe(true);
  await userEvent.click(screen.getByRole("button", {name: "会话菜单"}));
  expect(screen.getByRole("menuitem", {name: "取消置顶"})).toBeInTheDocument();
});

it("keeps rename and archive in the session page menu", async () => {
  render(<SessionHeading session={session} onOpenExpert={vi.fn()} machineName="本机" />);
  await userEvent.click(screen.getByRole("button", {name: "会话菜单"}));
  expect(screen.getByRole("menuitem", {name: "重命名"})).toBeInTheDocument();
  expect(screen.getByRole("menuitem", {name: "归档会话"})).toBeInTheDocument();
});
