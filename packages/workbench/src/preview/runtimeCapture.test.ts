import { afterEach, describe, expect, it, vi } from "vitest";

import { restrictTrackToElement } from "./runtimeCapture";

describe("Preview pixel capture capability routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers Element Capture for compositor-accurate iframe pixels", async () => {
    const restriction = { kind: "restriction" };
    const restrictTo = vi.fn().mockResolvedValue(undefined);
    const cropTo = vi.fn().mockResolvedValue(undefined);
    const fromRestriction = vi.fn().mockResolvedValue(restriction);
    const fromCrop = vi.fn().mockResolvedValue({ kind: "crop" });
    vi.stubGlobal("RestrictionTarget", { fromElement: fromRestriction });
    vi.stubGlobal("CropTarget", { fromElement: fromCrop });

    const target = document.createElement("iframe");
    const mode = await restrictTrackToElement(
      { restrictTo, cropTo } as unknown as MediaStreamTrack,
      target,
    );

    expect(mode).toBe("element");
    expect(fromRestriction).toHaveBeenCalledWith(target);
    expect(restrictTo).toHaveBeenCalledWith(restriction);
    expect(cropTo).not.toHaveBeenCalled();
  });

  it("falls back to Region Capture when Element Capture rejects the target", async () => {
    const crop = { kind: "crop" };
    const restrictTo = vi.fn().mockRejectedValue(new DOMException("ineligible"));
    const cropTo = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("RestrictionTarget", {
      fromElement: vi.fn().mockResolvedValue({ kind: "restriction" }),
    });
    vi.stubGlobal("CropTarget", { fromElement: vi.fn().mockResolvedValue(crop) });

    const mode = await restrictTrackToElement(
      { restrictTo, cropTo } as unknown as MediaStreamTrack,
      document.createElement("iframe"),
    );

    expect(mode).toBe("region");
    expect(cropTo).toHaveBeenCalledWith(crop);
  });

  it("returns no unsafe crop mode when browser target APIs are absent", async () => {
    const mode = await restrictTrackToElement(
      {} as MediaStreamTrack,
      document.createElement("iframe"),
    );

    expect(mode).toBeNull();
  });
});
