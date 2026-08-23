import { describe, expect, it, vi } from "vitest";

import { browserHost, desktopHost, detectHost } from "./index";

describe("finding the machine to connect to", () => {
  it("reads the endpoint out of the fragment, where it stays out of server logs", async () => {
    const host = browserHost({
      hash:
        "#endpoint=" +
        encodeURIComponent(
          "wss://hub.example.com/fabric/v2?ticket=client-abc&route=machine-abc",
        ),
    });
    const endpoint = await host.endpoint();
    expect(endpoint?.via).toBe("relay");
    expect(endpoint?.url).toContain("ticket=client-abc");
  });

  it("calls a direct address direct, rather than labelling everything relayed", async () => {
    const host = browserHost({
      hash: "#endpoint=" + encodeURIComponent("ws://192.168.1.9:7777/ws"),
    });
    expect((await host.endpoint())?.via).toBe("lan");
  });

  it("returns nothing when there is no endpoint, so the app can say so", async () => {
    expect(await browserHost({ hash: "" }).endpoint()).toBeNull();
  });

  it("builds the loopback url from what the desktop shell read off the daemon", async () => {
    const invoke = vi.fn(async () => ({
      port: 42123,
      url: "ws://127.0.0.1:42123/ws?challenge=fresh&pid=42&expiresAt=1&proof=proof",
      machineId: "m_1",
      fingerprint: "AB-CD",
      pid: 42,
      challenge: "fresh",
      expiresAt: 1,
      serverProof: "server-proof",
    }));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    const endpoint = await desktopHost().endpoint();
    expect(endpoint).toEqual({
      url: "ws://127.0.0.1:42123/ws?challenge=fresh&pid=42&expiresAt=1&proof=proof",
      via: "loopback",
      label: "这台电脑",
      // Carried through so the settings page can hold it up against what the
      // handshake claims.
      fingerprint: "AB-CD",
      localServerProof: {
        proof: "server-proof",
        challenge: "fresh",
        pid: 42,
        machineId: "m_1",
        fingerprint: "AB-CD",
        expiresAt: 1,
      },
    });
    vi.unstubAllGlobals();
  });

  it("stays an ordinary browser even when displayed inside a native WebView", () => {
    vi.stubGlobal("window", {});
    expect(detectHost().kind).toBe("browser");

    vi.stubGlobal("window", { __TAURI__: { core: { invoke: vi.fn() } } });
    expect(detectHost().kind).toBe("browser");
    vi.unstubAllGlobals();
  });
});
