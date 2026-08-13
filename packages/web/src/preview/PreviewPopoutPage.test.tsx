import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionArtifactBundle } from "@genehub/proto";

import { PreviewPopoutPage } from "./PreviewPopoutPage";

const previewMock = vi.hoisted(() => ({
  props: null as null | {
    runtimeSessionId?: string | null;
    onRuntimeArtifactSaved?: (bundle: SessionArtifactBundle) => void;
  },
}));

vi.mock("./AssetPreviewPage", () => ({
  AssetPreviewPage: (props: typeof previewMock.props) => {
    previewMock.props = props;
    return (
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
    );
  },
}));

describe("standalone Preview window", () => {
  const posted: unknown[] = [];

  beforeEach(() => {
    posted.length = 0;
    previewMock.props = null;
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

    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: "ready" })));
    expect(previewMock.props?.runtimeSessionId).toBe("s_demo");

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
