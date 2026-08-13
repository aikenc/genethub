import { describe, expect, it } from "vitest";

import { buildRuntimeArtifactSubmission } from "./PreviewRuntimeControls";

describe("Preview runtime artifact", () => {
  it("keeps full bounded logs, every pixel/DOM frame, and the recording as files", async () => {
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

    const artifact = await buildRuntimeArtifactSubmission({
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

    expect(artifact.metadata).toMatchObject({
      schema: "genehub.preview-runtime.v2",
      source: { path: "r_demo/prototype/index.html", version: "sha256:test" },
      eventCount: 250,
      frameCount: 10,
      recording: { requestedFps: 30, captureMode: "element" },
    });
    expect(artifact.files.map((file) => file.name)).toEqual([
      "events.jsonl",
      "dom.jsonl",
      ...Array.from({ length: 10 }, (_, index) =>
        `frame-${String(index + 1).padStart(3, "0")}.webp`,
      ),
      "recording.webm",
    ]);
    const eventsText = await readBlob(artifact.files[0]!.blob);
    const domText = await readBlob(artifact.files[1]!.blob);
    expect(eventsText).toContain("event-0");
    expect(eventsText).toContain("event-249");
    expect(domText).toContain('data-frame=\\"9\\"');
    expect(domText.trim().split("\n")).toHaveLength(10);
  });
});

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
