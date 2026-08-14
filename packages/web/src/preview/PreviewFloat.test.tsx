import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";

import type { Host } from "../host";
import type { RuntimeArtifactSubmit } from "./PreviewRuntimeControls";
import { PreviewFloat } from "./PreviewFloat";

const mountCount = { current: 0 };
const previewMock = vi.hoisted(() => ({
  runtimeSubmit: null as RuntimeArtifactSubmit | null,
}));
const storeMock = vi.hoisted(() => {
  const client = {
    identity: { machineId: "m_demo" },
    call: vi.fn(async (request: { type: string }) => {
      if (request.type === "session.artifact.begin") {
        return {
          type: "sessionArtifactUpload",
          data: {
            uploadId: `u_${"1".repeat(32)}`,
            relativePath: "artifacts/260813-230004-fbe1",
            workspacePath: ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
            maxChunkBytes: 512 * 1024,
          },
        };
      }
      if (request.type === "session.artifact.finish") {
        return {
          type: "sessionArtifact",
          data: {
            relativePath: "artifacts/260813-230004-fbe1",
            workspacePath: ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
            manifestPath:
              ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1/manifest.json",
            createdAtMs: 1,
            totalBytes: 0,
            files: [],
          },
        };
      }
      return { type: "ack" };
    }),
  };
  const state = {
    client,
    activeSessionId: "s_demo",
    appendComposerDraftLine: vi.fn(),
    send: vi.fn(),
  };
  const useWorkbench = Object.assign(
    (select: (value: typeof state) => unknown) => select(state),
    { getState: () => state },
  );
  return { state, useWorkbench };
});

vi.mock("./AssetPreviewPage", () => ({
  AssetPreviewPage: (props: {
    client?: unknown;
    onMetaChange?: (meta: { documentTitle: string | null; infoLines: string[] }) => void;
    onRuntimeArtifact?: RuntimeArtifactSubmit;
  }) => {
    previewMock.runtimeSubmit = props.onRuntimeArtifact ?? null;
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
  useWorkbench: storeMock.useWorkbench,
}));

describe("PreviewFloat", () => {
  beforeEach(() => {
    mountCount.current = 0;
    previewMock.runtimeSubmit = null;
    storeMock.state.appendComposerDraftLine.mockClear();
    storeMock.state.send.mockClear();
    storeMock.state.client.call.mockClear();
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens fullscreen with title chrome and keeps preview mounted across minimize", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      expect(
        screen.getByRole("button", { name: "预览浮窗 Cursor Demo Title" }),
      ).toBeInTheDocument();
      return window;
    });
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
    const opened = new URL(String(open.mock.calls[0]?.[0]));
    expect(opened.pathname).toContain("/assets/preview/v2/");
    expect(opened.searchParams.get("genehubPreviewSession")).toBe("s_demo");
    const popoutId = opened.searchParams.get("genehubPreviewPopout")!;
    expect(open.mock.calls[0]?.[1]).toBe(`genehub-preview-${popoutId}`);
    expect(
      screen.getByRole("button", { name: "预览浮窗 Cursor Demo Title" }),
    ).toBeInTheDocument();

    emitPopoutMessage({
      source: "genehub-preview-popout-v1",
      type: "ready",
      id: popoutId,
      sessionId: "s_demo",
    });
    expect(
      await screen.findByRole("button", { name: "预览浮窗 Cursor Demo Title" }),
    ).toBeInTheDocument();

    emitPopoutMessage({
      source: "genehub-preview-popout-v1",
      type: "artifact",
      id: popoutId,
      sessionId: "s_demo",
      workspacePath: ".genethub/sessions/s_demo/artifacts/from-popout",
    });
    expect(storeMock.state.appendComposerDraftLine).toHaveBeenCalledWith(
      "s_demo",
      "运行产物Bundle：`.genethub/sessions/s_demo/artifacts/from-popout`",
    );
    expect(storeMock.state.send).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("restores the maximized Preview when opening the window throws", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(window, "open").mockImplementation(() => {
      throw new Error("popup blocked");
    });

    render(
      <PreviewFloat
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/demos/index.html",
        }}
        host={{ kind: "browser" } as Host}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();
  });

  it("saves embedded artifacts into the draft without sending Chat", async () => {
    render(
      <PreviewFloat
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/demos/index.html",
        }}
        host={{ kind: "browser" } as Host}
        onClose={() => {}}
      />,
    );

    let result: Awaited<ReturnType<RuntimeArtifactSubmit>> | undefined;
    await act(async () => {
      result = await previewMock.runtimeSubmit?.(
        {
          files: [{ name: "events.jsonl", mime: "application/x-ndjson", blob: new Blob([]) }],
          metadata: { schema: "genehub.preview-runtime.v2" },
          summary: { eventCount: 0, frameCount: 0, recording: null },
        },
        () => {},
      );
    });

    expect(result).toEqual({
      relativePath: "artifacts/260813-230004-fbe1",
      addedToDraft: true,
    });
    expect(storeMock.state.appendComposerDraftLine).toHaveBeenCalledWith(
      "s_demo",
      "运行产物Bundle：`.genethub/sessions/s_demo/artifacts/260813-230004-fbe1`",
    );
    expect(storeMock.state.send).not.toHaveBeenCalled();
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
    expect(float.style.width).toBe("80px");
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "最小化浮窗" })).not.toBeInTheDocument();
    // Small chrome keeps a short title between maximize and close.
    expect(screen.getByText("Cursor Demo Title")).toBeInTheDocument();
    expect(screen.getByTestId("preview-content-shield")).toBeInTheDocument();

    // small → mid via whole-float click
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(float.style.width).toBe("120px");
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(screen.getByText("Cursor Demo Title")).toBeInTheDocument();
    expect(screen.getByTestId("preview-content-shield")).toBeInTheDocument();

    // mid → large
    await user.click(float);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(float.style.width).toBe("240px");
    expect(screen.getByRole("button", { name: "最大化预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最小化浮窗" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument();
    expect(screen.queryByTestId("preview-content-shield")).not.toBeInTheDocument();
    const previewShell = screen.getByTestId("preview-body").parentElement;
    expect(previewShell?.style.transform).toContain("scale(0.14)");
    expect(previewShell?.className).not.toContain("pointer-events-none");

    // Large title bar is drag-only; shrink only via the minimize control (avoids
    // desktop mouseup synthesizing a click that used to collapse the float).
    await user.click(screen.getByText("Cursor Demo Title"));
    expect(float.style.width).toBe("240px");

    await user.click(screen.getByRole("button", { name: "最小化浮窗" }));
    expect(float.style.width).toBe("80px");
    expect(screen.queryByRole("button", { name: "最小化浮窗" })).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-content-shield")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });
});

function emitPopoutMessage(message: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "__genehub_preview_popout_v1__",
        newValue: JSON.stringify({ nonce: "test", message }),
      }),
    );
  });
}
