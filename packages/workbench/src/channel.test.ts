import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("deployed Web channel identity", () => {
  it("lets Vite override the local stamp to stable/GeneHub", async () => {
    vi.stubEnv("VITE_GENEHUB_CHANNEL", "stable");
    vi.stubEnv("VITE_GENEHUB_BRAND", "GeneHub");
    const { CHANNEL, PRODUCT, MANIFEST_URL } = await import("./channel");
    expect(CHANNEL).toBe("stable");
    expect(PRODUCT).toBe("GeneHub");
    expect(MANIFEST_URL).toBe("");
  });

  it("keeps the local stamp when Vite overrides are unset", async () => {
    vi.stubEnv("VITE_GENEHUB_CHANNEL", "");
    vi.stubEnv("VITE_GENEHUB_BRAND", "");
    const { CHANNEL, PRODUCT, MANIFEST_URL } = await import("./channel");
    expect(CHANNEL).toBe("local");
    expect(PRODUCT).toBe("GeneHub Local");
    expect(MANIFEST_URL).toBe("");
  });
});
