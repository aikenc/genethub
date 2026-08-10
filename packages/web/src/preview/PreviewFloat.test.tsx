import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "../host";
import { PreviewFloat } from "./PreviewFloat";

vi.mock("./AssetPreviewPage", () => ({
  AssetPreviewPage: () => <div data-testid="preview-body">preview body</div>,
}));

describe("PreviewFloat", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows open-in-new-window and close controls without leaving the workbench", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const host = { kind: "browser" } as Host;

    render(
      <PreviewFloat
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/demos/index.html",
        }}
        host={host}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId("preview-body")).toBeInTheDocument();
    expect(screen.getByText("r_root/demos/index.html")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(open).toHaveBeenCalled();
    expect(String(open.mock.calls[0]?.[0])).toContain("/assets/preview/v2/");

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });
});
