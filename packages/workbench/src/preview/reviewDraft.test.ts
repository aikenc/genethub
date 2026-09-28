import { describe, expect, it } from "vitest";

import type { PreviewAnnotation, PreviewReviewDraft } from "@genehub/proto";

import { defaultImageRect, previewReviewMessage, rectFromDisplayBox } from "./reviewDraft";

function note(partial: Pick<PreviewAnnotation, "id" | "target" | "comment"> & Partial<PreviewAnnotation>): PreviewAnnotation {
  return {
    source: {
      root: { kind: "primary" },
      relativePath: "docs/spec.md",
      contentVersion: "a".repeat(32),
    },
    createdAtMs: 1,
    ...partial,
  };
}

describe("preview review message", () => {
  it("groups files and keeps image numbers with the snapshot path", () => {
    const draft: PreviewReviewDraft = {
      revision: 3,
      annotations: [
        note({
          id: "ann-1",
          comment: "解释恢复",
          target: { kind: "markdownLines", startLine: 12, endLine: 18, excerpt: "失败后" },
        }),
        note({
          id: "ann-2",
          comment: "对比度偏低",
          source: { root: { kind: "primary" }, relativePath: "design/a.png", contentVersion: "b".repeat(32) },
          markerNo: 1,
          evidencePath: ".genethub/sessions/s1/preview-review-images/bbbb-a.png",
          target: { kind: "imageRect", x: 1, y: 2, width: 3, height: 4, naturalWidth: 20, naturalHeight: 10 },
        }),
      ],
    };
    const text = previewReviewMessage(draft);
    expect(text).toContain("docs/spec.md");
    expect(text).toContain("第 12–18 行");
    expect(text).toContain("「失败后」");
    expect(text).toContain("#1 (1,2,3,4)");
    expect(text).toContain(".genethub/sessions/s1/preview-review-images/bbbb-a.png");
    expect(text).not.toContain("回复");
  });
});

describe("image rectangles", () => {
  it("maps a drag on the displayed box back to original pixels", () => {
    const rect = rectFromDisplayBox({ width: 100, height: 50 }, 200, 100, { x: 0.1, y: 0.2 }, { x: 0.6, y: 0.8 });
    expect(rect).toEqual({ x: 20, y: 20, width: 100, height: 60, naturalWidth: 200, naturalHeight: 100 });
  });

  it("gives a tap a finger-sized box that stays inside the image", () => {
    const rect = defaultImageRect({ x: 0.02, y: 0.98 }, 200, 100);
    expect(rect?.width).toBe(48);
    expect(rect?.height).toBe(48);
    expect(rect && rect.x).toBeGreaterThanOrEqual(0);
    expect(rect && rect.y + rect.height).toBeLessThanOrEqual(100);
  });
});
