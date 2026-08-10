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

  it("opens fullscreen with title chrome and keeps preview mounted across minimize", async () => {
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
    expect(screen.getByText("Cursor Demo Title")).toBeInTheDocument();
    expect(screen.queryByText("r_root/demos/index.html")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看预览信息" }));
    expect(screen.getByRole("dialog", { name: "预览信息" })).toBeInTheDocument();
    expect(screen.getByText("静态多文件（内联）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭信息" }));

    await user.click(screen.getByRole("button", { name: "最小化" }));
    expect(
      await screen.findByRole("button", { name: "预览浮窗 Cursor Demo Title" }),
    ).toBeInTheDocument();
    expect(mountCount.current).toBe(1);

    await user.click(screen.getByRole("button", { name: "最大化预览" }));
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();
    expect(mountCount.current).toBe(1);

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(open).toHaveBeenCalled();
    expect(String(open.mock.calls[0]?.[0])).toContain("/assets/preview/v2/");

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps maximize/close on every float size and only large is content-interactive", async () => {
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
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最小化浮窗" })).not.toBeInTheDocument();

    // small → mid via whole-float click
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(float.style.width).toBe("108px");
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();

    // mid → large
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(float.style.width).toBe("216px");
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最小化浮窗" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    const previewShell = screen.getByTestId("preview-body").parentElement;
    expect(previewShell?.style.transform).toContain("scale(0.14)");
    expect(previewShell?.className).not.toContain("pointer-events-none");

    await user.click(screen.getByRole("button", { name: "最小化浮窗" }));
    expect(float.style.width).toBe("54px");
    expect(screen.queryByRole("button", { name: "最小化浮窗" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });
});
