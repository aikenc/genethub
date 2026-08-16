import { describe, expect, it, vi } from "vitest";

import { browserHost, detectHost } from "./index";

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

  it("stays an ordinary browser even when displayed inside a native WebView", () => {
    expect(detectHost().kind).toBe("browser");
    // A compromised or accidentally injected marker must not activate a native
    // product path. The released shell sets withGlobalTauri=false as the harder
    // boundary; this keeps the Web package independent as well.
    vi.stubGlobal("window", { __TAURI__: { core: { invoke: vi.fn() } } });
    expect(detectHost().kind).toBe("browser");
    vi.unstubAllGlobals();
  });
});
