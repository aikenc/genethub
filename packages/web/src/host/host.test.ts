import { describe, expect, it, vi } from "vitest";

import { browserHost, desktopHost, detectHost } from "./index";

describe("finding the machine to connect to", () => {
  it("reads the endpoint out of the fragment, where it stays out of server logs", async () => {
    const host = browserHost({
      hash: "#endpoint=" + encodeURIComponent("wss://hub.example.com/forward/client?ticket=abc"),
    });
    const endpoint = await host.endpoint();
    expect(endpoint?.via).toBe("relay");
    expect(endpoint?.url).toContain("ticket=abc");
  });

  it("calls a direct address direct, rather than labelling everything relayed", async () => {
    const host = browserHost({ hash: "#endpoint=" + encodeURIComponent("ws://192.168.1.9:7777/ws") });
    expect((await host.endpoint())?.via).toBe("lan");
  });

  it("returns nothing when there is no endpoint, so the app can say so", async () => {
    expect(await browserHost({ hash: "" }).endpoint()).toBeNull();
  });

  it("builds the loopback url from what the desktop shell read off the daemon", async () => {
    const invoke = vi.fn(async () => ({
      port: 42123,
      token: "tok",
      machineId: "m_1",
      fingerprint: "AB-CD",
    }));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });

    const endpoint = await desktopHost().endpoint();
    expect(endpoint).toEqual({
      url: "ws://127.0.0.1:42123/ws?token=tok",
      via: "loopback",
      label: "这台电脑",
      // Carried through so the settings page can hold it up against what the
      // handshake claims.
      fingerprint: "AB-CD",
    });
    vi.unstubAllGlobals();
  });

  it("picks the desktop host only when the shell is actually there", () => {
    vi.stubGlobal("window", {});
    expect(detectHost().kind).toBe("browser");

    vi.stubGlobal("window", { __TAURI__: { core: { invoke: vi.fn() } } });
    expect(detectHost().kind).toBe("desktop");
    vi.unstubAllGlobals();
  });
});
