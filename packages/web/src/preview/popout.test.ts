import { describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import {
  createPreviewPopoutUrl,
  parsePreviewPopout,
  previewPopoutArtifact,
  previewPopoutReady,
  registerPreviewPopoutClient,
  takePreviewPopoutClient,
} from "./popout";

describe("Preview popout context", () => {
  it("carries the originating session in a standalone Preview URL", () => {
    const opened = createPreviewPopoutUrl(
      "https://example.test/assets/preview/v2/m/w/r/index.html",
      "s_demo",
      "popout_demo",
      "#endpoint=wss%3A%2F%2Frelay.example.test%2Ffabric%2Fv2%3Froute%3Ddemo&ignored=value",
    );
    const url = new URL(opened.url);

    expect(parsePreviewPopout(url.search)).toEqual({
      id: "popout_demo",
      sessionId: "s_demo",
    });
    expect(new URLSearchParams(url.hash.slice(1)).get("endpoint")).toBe(
      "wss://relay.example.test/fabric/v2?route=demo",
    );
    expect(url.hash).not.toContain("ignored");
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

  it("hands one same-origin popout the existing Client without redialing", () => {
    const context = { id: "popout_shared_client", sessionId: "s_demo" } as const;
    const source = {
      deviceHandle: "m_demo",
      workspaceHandle: "w_demo",
      path: "r_root/index.html",
    };
    const client = { identity: { machineId: "m_demo" } } as Client;
    const owner = {} as Window;
    const child = { opener: owner } as Pick<Window, "opener">;

    registerPreviewPopoutClient(context, source, client, owner);

    expect(takePreviewPopoutClient(context, source, child)).toBe(client);
    expect(child.opener).toBeNull();
    // React StrictMode may initialize the popout component twice; the child
    // keeps the already-consumed reference in its own realm.
    expect(takePreviewPopoutClient(context, source, child)).toBe(client);
  });
});
