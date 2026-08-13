import type React from "react";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PreviewRuntimeControls,
  type PreviewDomSnapshot,
  type PreviewRuntimeEvent,
  type RuntimeArtifactSubmission,
} from "./PreviewRuntimeControls";

describe("Preview runtime artifacts without display capture", () => {
  it("records rendered frames and still saves logs and DOM on mobile", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameRef = { current: frame } as React.RefObject<HTMLIFrameElement>;
    const eventsRef = {
      current: [
        {
          at: 1_700_000_000_000,
          kind: "console",
          detail: { level: "log", text: "mobile runtime log" },
        },
      ],
    } as React.MutableRefObject<PreviewRuntimeEvent[]>;
    const requestDomSnapshot = vi.fn(async (): Promise<PreviewDomSnapshot> => ({
      capturedAt: Date.now(),
      html: "<main>mobile live state</main>",
      truncated: false,
      title: "Mobile preview",
      location: "https://preview.invalid/",
      viewportWidth: 390,
      viewportHeight: 844,
      scrollX: 0,
      scrollY: 0,
      activeElement: "body",
      mutationCount: 3,
    }));
    const requestRenderedSnapshot = vi.fn(async () => ({
      blob: new Blob(["rendered"], { type: "image/webp" }),
      width: 390,
      height: 844,
      capturedAt: Date.now(),
      mode: "dom-render" as const,
    }));
    const submitted: RuntimeArtifactSubmission[] = [];
    const onSubmit = vi.fn(async (artifact: RuntimeArtifactSubmission) => {
      submitted.push(artifact);
      return {
        relativePath: ".genethub/sessions/s_mobile/artifacts/260814-001000-abcd",
        addedToDraft: true,
      };
    });
    const user = userEvent.setup();

    render(
      <PreviewRuntimeControls
        frameRef={frameRef}
        ready
        entryPath="mobile/index.html"
        eventsRef={eventsRef}
        eventCount={1}
        requestDomSnapshot={requestDomSnapshot}
        requestRenderedSnapshot={requestRenderedSnapshot}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "录制" }));
    await screen.findByRole("button", { name: "停止" });
    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("画面与 DOM 1fps"),
    );
    await user.click(screen.getByRole("button", { name: "保存运行产物" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(requestRenderedSnapshot).toHaveBeenCalledTimes(3);
    expect(requestDomSnapshot).toHaveBeenCalledTimes(3);
    expect(submitted[0]!.files.map((file) => file.name)).toEqual([
      "events.jsonl",
      "dom.jsonl",
      "frame-001.webp",
      "frame-002.webp",
      "frame-003.webp",
    ]);
    expect(submitted[0]!.metadata).toMatchObject({
      schema: "genehub.preview-runtime.v3",
      eventCount: 1,
      frameCount: 3,
      recording: { kind: "frame-sequence", file: null, requestedFps: 1 },
    });
    expect(screen.getByRole("status")).toHaveTextContent("已加入输入框");
  });
});
