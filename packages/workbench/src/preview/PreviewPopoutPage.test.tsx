import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionArtifactBundle } from "@genehub/proto";

import type { Client } from "../protocol/client";
import { activeDiagnosticClient } from "../diagnostics";
import type { Host } from "../host";
import { registerPreviewPopoutClient } from "./popout";
import { PreviewPopoutPage } from "./PreviewPopoutPage";

const sharedClient = { identity: { machineId: "m_demo" } } as unknown as Client;
const previewMock = vi.hoisted(() => ({
  props: null as null | {
    client?: Client | null;
    host?: Host;
    runtimeSessionId?: string | null;
    onRuntimeArtifactSaved?: (bundle: SessionArtifactBundle) => void;
    onRuntimeReady?: () => void;
  },
}));

vi.mock("./AssetPreviewPage", () => ({
  AssetPreviewPage: (props: typeof previewMock.props) => {
    previewMock.props = props;
    return (
      <>
        <button type="button" onClick={() => props?.onRuntimeReady?.()}>
          simulate collector ready
        </button>
        <button
          type="button"
          onClick={() =>
            props?.onRuntimeArtifactSaved?.({
              relativePath: "artifacts/260813-230004-fbe1",
              workspacePath: ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
              manifestPath:
                ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1/manifest.json",
              createdAtMs: 1,
              totalBytes: 0,
              files: [],
            })
          }
        >
          simulate save
        </button>
      </>
    );
  },
}));

describe("standalone Preview window", () => {
  const posted: unknown[] = [];
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    posted.length = 0;
    previewMock.props = null;
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const opener = {} as Window;
    registerPreviewPopoutClient(
      { id: "popout_demo", sessionId: "s_demo" },
      {
        deviceHandle: "m_demo",
        workspaceHandle: "w_demo",
        path: "r_root/index.html",
      },
      sharedClient,
      opener,
    );
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: opener,
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        addEventListener() {}
        postMessage(message: unknown) {
          posted.push(message);
        }
        close() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: null,
    });
    vi.unstubAllGlobals();
  });

  it("announces readiness and reports each daemon bundle to the workbench", async () => {
    render(
      <PreviewPopoutPage
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/index.html",
        }}
        context={{ id: "popout_demo", sessionId: "s_demo" }}
      />,
    );

    expect(previewMock.props?.runtimeSessionId).toBe("s_demo");
    expect(previewMock.props?.client).toBe(sharedClient);
    expect(activeDiagnosticClient()).toBe(sharedClient);
    expect(posted).not.toContainEqual(expect.objectContaining({ type: "ready" }));

    await userEvent.click(screen.getByRole("button", { name: "simulate collector ready" }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: "ready" })));

    await userEvent.click(screen.getByRole("button", { name: "simulate save" }));
    expect(posted).toContainEqual({
      source: "genehub-preview-popout-v1",
      type: "artifact",
      id: "popout_demo",
      sessionId: "s_demo",
      workspacePath: ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
    });

    const receipt = screen.getByRole("dialog", { name: "运行产物已保存" });
    expect(receipt).toBeInTheDocument();
    const draftLine =
      "运行产物Bundle：`.genethub/sessions/s_demo/artifacts/260813-230004-fbe1`";
    expect(screen.getByRole("textbox", { name: "运行产物引用" })).toHaveValue(draftLine);

    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(draftLine);
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "运行产物已保存" })).not.toBeInTheDocument();
  });

  it("keeps the Bundle line selectable when browser copy permission fails", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(
      <PreviewPopoutPage
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/index.html",
        }}
        context={{ id: "popout_demo", sessionId: "s_demo" }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "simulate save" }));
    await userEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请长按或选中");
    expect(screen.getByRole("textbox", { name: "运行产物引用" })).toHaveValue(
      "运行产物Bundle：`.genethub/sessions/s_demo/artifacts/260813-230004-fbe1`",
    );
  });

  it("recovers the session from the opener bridge when the URL lost it", () => {
    const opener = {} as Window;
    registerPreviewPopoutClient(
      { id: "popout_recovered", sessionId: "s_demo" },
      {
        deviceHandle: "m_demo",
        workspaceHandle: "w_demo",
        path: "r_root/index.html",
      },
      sharedClient,
      opener,
    );
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: opener,
    });

    render(
      <PreviewPopoutPage
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/index.html",
        }}
        context={{ id: "popout_recovered", sessionId: null }}
      />,
    );

    expect(previewMock.props?.runtimeSessionId).toBe("s_demo");
    expect(previewMock.props?.client).toBe(sharedClient);
    expect(previewMock.props?.onRuntimeArtifactSaved).toBeTypeOf("function");
  });

  it("keeps the embedding host available when the shared opener client is unavailable", () => {
    Object.defineProperty(window, "opener", {
      configurable: true,
      writable: true,
      value: null,
    });
    const host = { kind: "browser" } as Host;

    render(
      <PreviewPopoutPage
        source={{
          deviceHandle: "m_demo",
          workspaceHandle: "w_demo",
          path: "r_root/index.html",
        }}
        context={{ id: "popout_direct", sessionId: "s_demo" }}
        host={host}
      />,
    );

    expect(previewMock.props?.host).toBe(host);
    expect(previewMock.props?.runtimeSessionId).toBe("s_demo");
  });
});
