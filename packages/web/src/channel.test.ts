import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("hosted Web channel identity", () => {
  it("lets Vite override the dest stamp to official/GeneHub", async () => {
    vi.stubEnv("VITE_GENEHUB_CHANNEL", "official");
    vi.stubEnv("VITE_GENEHUB_BRAND", "GeneHub");
    const { CHANNEL, PRODUCT, MANIFEST_URL } = await import("./channel");
    expect(CHANNEL).toBe("official");
    expect(PRODUCT).toBe("GeneHub");
    expect(MANIFEST_URL).toBe("");
  });

  it("keeps the dest stamp when Vite overrides are unset", async () => {
    vi.stubEnv("VITE_GENEHUB_CHANNEL", "");
    vi.stubEnv("VITE_GENEHUB_BRAND", "");
    const { CHANNEL, PRODUCT, MANIFEST_URL } = await import("./channel");
    expect(CHANNEL).toBe("dev");
    expect(PRODUCT).toBe("GeneHub Dev");
    expect(MANIFEST_URL).toBe("");
  });
});
