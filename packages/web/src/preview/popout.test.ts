import { describe, expect, it } from "vitest";

import {
  createPreviewPopoutUrl,
  parsePreviewPopout,
  previewPopoutArtifact,
  previewPopoutReady,
} from "./popout";

describe("Preview popout context", () => {
  it("carries the originating session in a standalone Preview URL", () => {
    const opened = createPreviewPopoutUrl(
      "https://example.test/assets/preview/v2/m/w/r/index.html",
      "s_demo",
      "popout_demo",
    );
    const url = new URL(opened.url);

    expect(parsePreviewPopout(url.search)).toEqual({
      id: "popout_demo",
      sessionId: "s_demo",
    });
  });

  it("creates scoped ready and artifact messages", () => {
    const context = { id: "popout_demo", sessionId: "s_demo" } as const;
    expect(previewPopoutReady(context)).toMatchObject({ type: "ready", ...context });
    expect(
      previewPopoutArtifact(
        context,
        ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
      ),
    ).toMatchObject({
      type: "artifact",
      ...context,
      workspacePath: ".genethub/sessions/s_demo/artifacts/260813-230004-fbe1",
    });
  });
});
