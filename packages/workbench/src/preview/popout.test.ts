import { describe, expect, it } from "vitest";

import type { Client } from "../protocol/client";
import {
  createPortablePreviewUrl,
  createPreviewPopoutUrl,
  parsePortablePreviewTicket,
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

    expect(parsePreviewPopout(url.search, url.hash)).toEqual({
      id: "popout_demo",
      sessionId: "s_demo",
    });
    expect(parsePreviewPopout("", url.hash)).toEqual({
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

describe("portable Preview ticket link", () => {
  const ticket = {
    url: "wss://relay.example.test/fabric/v2",
    fabricRouteTicket: "route-ticket_demo.123",
    channelCapability: "capability-demo",
    channelSecret: "channel+secret/demo=",
  };

  it("round-trips every ticket part through the fragment", () => {
    const url = new URL(
      createPortablePreviewUrl(
        "https://example.test/assets/preview/v2/m/w/r/clip.mp4",
        ticket,
        "s_demo",
      ),
    );

    expect(parsePortablePreviewTicket(url.search, url.hash)).toEqual(ticket);
    expect(parsePreviewPopout(url.search, url.hash)).toBeNull();
    // The session rides along so runtime artifacts can still be saved.
    expect(new URLSearchParams(url.search).get("genehubPreviewSession")).toBe("s_demo");
  });

  it("keeps every secret out of the query string that servers log", () => {
    const url = new URL(
      createPortablePreviewUrl(
        "https://example.test/assets/preview/v2/m/w/r/clip.mp4",
        ticket,
        null,
      ),
    );

    expect(url.search).not.toContain("genehubPreviewRoute");
    expect(url.search).not.toContain("genehubPreviewCapability");
    expect(url.search).not.toContain("genehubPreviewSecret");
    expect(url.search).not.toContain("endpoint=");
    // ...and secrets pasted into the query by hand are not accepted either.
    const forged = `?endpoint=${encodeURIComponent(ticket.url)}&genehubPreviewRoute=${ticket.fabricRouteTicket}&genehubPreviewCapability=${ticket.channelCapability}&genehubPreviewSecret=${encodeURIComponent(ticket.channelSecret)}`;
    expect(parsePortablePreviewTicket(forged, "")).toBeNull();
  });

  it("rejects partial or malformed tickets", () => {
    expect(parsePortablePreviewTicket("", "")).toBeNull();
    expect(
      parsePortablePreviewTicket("", "#endpoint=wss://relay.example.test/fabric/v2"),
    ).toBeNull();
    expect(
      parsePortablePreviewTicket(
        "",
        `#endpoint=wss://relay.example.test/fabric/v2&genehubPreviewRoute=${ticket.fabricRouteTicket}&genehubPreviewCapability=${ticket.channelCapability}&genehubPreviewSecret=bad secret with spaces`,
      ),
    ).toBeNull();
  });
});
