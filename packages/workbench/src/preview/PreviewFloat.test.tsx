import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { PreviewShell } from "./PreviewToolbar";

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
    call: vi.fn(async (request: { type: string; payload?: { sessionId?: string } }) => {
      const sessionId = request.payload?.sessionId ?? "s_demo";
      if (request.type === "session.artifact.begin") {
        return {
          type: "sessionArtifactUpload",
          data: {
            uploadId: `u_${"1".repeat(32)}`,
            relativePath: "artifacts/260813-230004-fbe1",
            workspacePath: `.genethub/sessions/${sessionId}/artifacts/260813-230004-fbe1`,
            maxChunkBytes: 512 * 1024,
          },
        };
      }
      if (request.type === "session.artifact.finish") {
        return {
          type: "sessionArtifact",
          data: {
            relativePath: "artifacts/260813-230004-fbe1",
            workspacePath: `.genethub/sessions/${sessionId}/artifacts/260813-230004-fbe1`,
            manifestPath:
              `.genethub/sessions/${sessionId}/artifacts/260813-230004-fbe1/manifest.json`,
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
    timeline: { blobs: {} as Record<string, { value: unknown }> },
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
    navigation?: ReactNode;
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
    return <PreviewShell bindTools={() => {}} navigation={props.navigation} information="静态多文件（内联）">
      <div data-testid="preview-body">preview body{props.client ? " shared" : ""}</div>
    </PreviewShell>;
  },
}));

vi.mock("../session/store", () => ({
  useWorkbench: storeMock.useWorkbench,
}));

describe("PreviewFloat", () => {
  beforeEach(() => {
    mountCount.current = 0;
    previewMock.runtimeSubmit = null;
    storeMock.state.activeSessionId = "s_demo";
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

  it("opens full screen and keeps the same preview mounted when opening information and a new window", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      expect(
        screen.getByRole("dialog", { name: "文件预览" }),
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
          sessionId: "s_demo",
        }}
        host={host}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId("preview-body")).toBeInTheDocument();
    expect(mountCount.current).toBe(1);
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();
    const chrome = screen.getByRole("banner", { name: "预览工具栏" });
    expect(chrome).toHaveClass("h-11");
    expect(chrome).not.toHaveTextContent("Cursor Demo Title");
    expect(chrome).not.toHaveTextContent("r_root/demos/index.html");
    expect(screen.queryByRole("button", { name: "最小化" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "预览信息" }));
    expect(screen.getByRole("complementary", { name: "预览信息" })).toBeInTheDocument();
    expect(screen.getByText("静态多文件（内联）")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭信息" }));

    expect(mountCount.current).toBe(1);

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(open).toHaveBeenCalled();
    const opened = new URL(String(open.mock.calls[0]?.[0]));
    expect(opened.pathname).toContain("/assets/preview/v2/");
    expect(opened.searchParams.get("genehubPreviewSession")).toBe("s_demo");
    const popoutId = opened.searchParams.get("genehubPreviewPopout")!;
    expect(open.mock.calls[0]?.[1]).toBe(`genehub-preview-${popoutId}`);
    expect(
      screen.getByRole("dialog", { name: "文件预览" }),
    ).toBeInTheDocument();

    emitPopoutMessage({
      source: "genehub-preview-popout-v1",
      type: "ready",
      id: popoutId,
      sessionId: "s_demo",
    });
    expect(
      await screen.findByRole("dialog", { name: "文件预览" }),
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

    await user.click(screen.getByRole("button", { name: "返回对话" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers a usable link when the browser blocks the new window", async () => {
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
          sessionId: "s_demo",
        }}
        host={{ kind: "browser" } as Host}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(screen.getByRole("dialog", { name: "文件预览" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开预览链接" })).toHaveAttribute("target", "_blank");
  });

  it("saves embedded artifacts into the draft without sending Chat", async () => {
    render(
      <PreviewFloat
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/demos/index.html",
          sessionId: "s_demo",
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

  it("keeps the originating session after the active chat changes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const open = vi.spyOn(window, "open").mockReturnValue(window);
    storeMock.state.activeSessionId = "s_other";

    render(
      <PreviewFloat
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/demos/index.html",
          sessionId: "s_origin",
        }}
        host={{ kind: "browser" } as Host}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "新窗口打开" }));
    const opened = new URL(String(open.mock.calls[0]?.[0]));
    expect(opened.searchParams.get("genehubPreviewSession")).toBe("s_origin");

    await act(async () => {
      await previewMock.runtimeSubmit?.(
        {
          files: [{ name: "events.jsonl", mime: "application/x-ndjson", blob: new Blob([]) }],
          metadata: { schema: "genehub.preview-runtime.v3" },
          summary: { eventCount: 0, frameCount: 0, recording: null },
        },
        () => {},
      );
    });

    expect(storeMock.state.client.call).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.artifact.begin",
        payload: expect.objectContaining({ sessionId: "s_origin" }),
      }),
    );
    expect(storeMock.state.appendComposerDraftLine).toHaveBeenCalledWith(
      "s_origin",
      "运行产物Bundle：`.genethub/sessions/s_origin/artifacts/260813-230004-fbe1`",
    );
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
