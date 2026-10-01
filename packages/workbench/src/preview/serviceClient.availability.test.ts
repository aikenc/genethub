import { describe, expect, it } from "vitest";
import { ServicePreviewQueryError, classifyServiceFailure } from "./serviceClient";

describe("classifyServiceFailure", () => {
  it("treats a missing services grant as unauthorized", () => {
    const error = new ServicePreviewQueryError(
      "this device was not granted `services` on this machine",
      403,
      "forbidden",
    );
    expect(classifyServiceFailure(error)).toEqual({
      state: "unauthorized",
      detail: error.message,
    });
  });

  it("keeps a dead registration reachable-check as unreachable with its own message", () => {
    expect(classifyServiceFailure(new Error("run not ready"))).toEqual({
      state: "unreachable",
      detail: "run not ready",
    });
  });
});
