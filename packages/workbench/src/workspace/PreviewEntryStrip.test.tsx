import type { SessionSummary, WorkspaceInfo } from "@genehub/proto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "../protocol/client";
import { useWorkbench } from "../session/store";
import { PreviewEntryStrip } from "./PreviewEntryStrip";

const workspace = {
  id: "w_one",
  name: "demo",
  root: "/tmp/demo",
  isGitRepo: false,
  folders: [{ name: "demo", root: "/tmp/demo", rootHandle: "r_one" }],
  previewEntries: [
    { id: "main", title: "主项目体验", entry: "preview/index.html", openMode: "fullscreen", kind: "file" },
    { id: "board", title: "过程看板", entry: "preview/board.html", openMode: "float", kind: "file" },
  ],
} as WorkspaceInfo;

const session = {
  id: "s_one",
  title: "把项目固定入口做出来",
  coordination: { active: true, pending: 2, ready: 1, unknown: 0, stale: false, updatedAtMs: 0 },
} as SessionSummary;

const openPreviewFloat = vi.fn();

beforeEach(() => {
  openPreviewFloat.mockReset();
  useWorkbench.setState({
    client: { identity: { machineId: "m_one" } } as unknown as Client,
    openPreviewFloat,
  });
});

describe("the project entry strip", () => {
  it("has no visible title text, only the chips", () => {
    render(<PreviewEntryStrip workspace={workspace} />);
    expect(screen.queryByText("项目入口")).toBeNull();
    expect(screen.getByText("主项目体验")).toBeTruthy();
    expect(screen.getByText("过程看板")).toBeTruthy();
  });

  it("opens an entry with its configured whole-page or float mode", async () => {
    const user = userEvent.setup();
    render(<PreviewEntryStrip workspace={workspace} />);
    await user.click(screen.getByText("主项目体验"));
    expect(openPreviewFloat).toHaveBeenLastCalledWith({
      deviceHandle: "m_one",
      workspaceHandle: "w_one",
      path: "r_one/preview/index.html",
      initialMode: "expanded",
    });
    await user.click(screen.getByText("过程看板"));
    expect(openPreviewFloat).toHaveBeenLastCalledWith({
      deviceHandle: "m_one",
      workspaceHandle: "w_one",
      path: "r_one/preview/board.html",
      initialMode: "float",
    });
  });

  it("carries the session coordination in the same row as the chips", async () => {
    const user = userEvent.setup();
    render(<PreviewEntryStrip workspace={workspace} session={session} />);
    const pill = screen.getByLabelText("会话协作进度");
    expect(pill.textContent).toContain("协作进行中");
    expect(pill.textContent).toContain("2 等待");
    expect(pill.textContent).toContain("1 结果");
    await user.click(pill);
    expect(screen.getByText("协作进度")).toBeTruthy();
    expect(screen.getByText(/等待 2 项，结果就绪 1 项/)).toBeTruthy();
  });

  it("does not add a coordination pill when the session has no coordination facts", () => {
    render(<PreviewEntryStrip workspace={workspace} session={{ ...session, coordination: undefined } as SessionSummary} />);
    expect(screen.queryByLabelText("会话协作进度")).toBeNull();
  });

  it("renders nothing when the project has no entries", () => {
    const { container } = render(
      <PreviewEntryStrip workspace={{ ...workspace, previewEntries: [] } as WorkspaceInfo} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
