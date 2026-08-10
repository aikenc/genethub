import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";

import type { Host } from "../host";
import { PreviewFloat } from "./PreviewFloat";

const mountCount = { current: 0 };

vi.mock("./AssetPreviewPage", () => ({
  AssetPreviewPage: (props: {
    client?: unknown;
    onMetaChange?: (meta: { documentTitle: string | null; infoLines: string[] }) => void;
  }) => {
    const counted = useRef(false);
    if (!counted.current) {
      counted.current = true;
      mountCount.current += 1;
    }
    useLayoutEffect(() => {
      props.onMetaChange?.({
        documentTitle: "Cursor Demo Title",
        infoLines: ["静态多文件（内联）", "网络已开启"],
      });
    }, [props.onMetaChange]);
    return <div data-testid="preview-body">preview body{props.client ? " shared" : ""}</div>;
  },
}));

vi.mock("../session/store", () => ({
  useWorkbench: (select: (state: { client: { identity: { machineId: string } } }) => unknown) =>
    select({ client: { identity: { machineId: "m_demo" } } }),
}));

describe("PreviewFloat", () => {
  beforeEach(() => {
    mountCount.current = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens fullscreen, shows info dialog, and keeps preview mounted across minimize", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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
    expect(mountCount.current).toBe(1);
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看预览信息" }));
    expect(screen.getByRole("dialog", { name: "预览信息" })).toBeInTheDocument();
    expect(screen.getByText("静态多文件（内联）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭信息" }));

    await user.click(screen.getByRole("button", { name: "最小化" }));
    expect(
      await screen.findByRole("button", { name: "预览浮窗 Cursor Demo Title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cursor Demo Title")).toBeInTheDocument();
    expect(mountCount.current).toBe(1);

    await user.dblClick(screen.getByRole("button", { name: "预览浮窗 Cursor Demo Title" }));
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();
    expect(mountCount.current).toBe(1);

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(open).toHaveBeenCalled();
    expect(String(open.mock.calls[0]?.[0])).toContain("/assets/preview/v2/");

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("cycles float size on single click and shows close on mid/large", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
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

    await user.click(screen.getByRole("button", { name: "最小化" }));
    const float = await screen.findByRole("button", { name: "预览浮窗 Cursor Demo Title" });
    expect(screen.queryByRole("button", { name: "关闭预览" })).not.toBeInTheDocument();

    // small → mid
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(float.style.width).toBe("108px");

    // mid → large: window grows, content keeps the same thumb scale
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(float.style.width).toBe("216px");
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    const previewShell = screen.getByTestId("preview-body").parentElement;
    expect(previewShell?.style.transform).toContain("scale(0.14)");

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });
});
