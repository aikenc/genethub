import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionArtifactBundle } from "@genehub/proto";

import type { Client } from "../protocol/client";
import { registerPreviewPopoutClient } from "./popout";
import { PreviewPopoutPage } from "./PreviewPopoutPage";

const sharedClient = { identity: { machineId: "m_demo" } } as unknown as Client;
const previewMock = vi.hoisted(() => ({
  props: null as null | {
    client?: Client | null;
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

  beforeEach(() => {
    posted.length = 0;
    previewMock.props = null;
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
  });
});
