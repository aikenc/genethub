import { describe, expect, it } from "vitest";

import { buildRuntimeArtifactReport } from "./PreviewRuntimeControls";

describe("Preview runtime artifact", () => {
  it("projects bounded recent logs, spaced DOM states, and recording identity", () => {
    const events = Array.from({ length: 250 }, (_, index) => ({
      at: 1_700_000_000_000 + index,
      kind: "console",
      detail: { level: "log", text: `event-${index}` },
    }));
    const frames = Array.from({ length: 10 }, (_, index) => ({
      at: 1_700_000_001_000 + index * 1_000,
      reason: index === 9 ? ("upload" as const) : ("recording-sample" as const),
      pixel: {
        blob: new Blob([`frame-${index}`], { type: "image/webp" }),
        width: 1_280,
        height: 720,
        capturedAt: 1_700_000_001_000 + index * 1_000,
        mode: "element" as const,
      },
      dom: {
        capturedAt: 1_700_000_001_000 + index * 1_000,
        html: `<main data-frame="${index}">ready</main>`,
        truncated: false,
        title: "Prototype",
        location: "https://preview.invalid/",
        viewportWidth: 1_280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: index * 10,
        activeElement: "button#submit",
        mutationCount: index * 3,
      },
    }));

    const report = buildRuntimeArtifactReport({
      entryPath: "r_demo/prototype/index.html",
      sourceVersion: "sha256:test",
      events,
      frames,
      recording: {
        blob: new Blob(["video"], { type: "video/webm" }),
        mimeType: "video/webm",
        durationMs: 9_500,
        requestedFps: 30,
        actualFps: 30,
        mode: "element",
      },
    });

    expect(report).toContain('"schema": "genehub.preview-runtime.v1"');
    expect(report).toContain('"path": "r_demo/prototype/index.html"');
    expect(report).toContain('"requestedFps": 30');
    expect(report).toContain('"captureMode": "element"');
    expect(report).toContain("event-249");
    expect(report).not.toContain("event-0\"");
    expect(report.match(/^### DOM /gm)).toHaveLength(8);
    expect(report).toContain('data-frame="9"');
  });
});
