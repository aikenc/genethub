import { describe, expect, it } from "vitest";

import { assetPreviewBaseUrl, assetPreviewUrl, parseAssetPreviewPath } from "./url";

describe("portable Asset Preview locators", () => {
  it("keeps the device, workspace and workspace-relative path visible", () => {
    const url = assetPreviewUrl(
      "device-office",
      "workspace-demo",
      "r_docs/docs/设计 说明.md",
      "https://app.example",
    );
    expect(url).toBe(
      "https://app.example/assets/preview/v2/device-office/workspace-demo/r_docs/docs/%E8%AE%BE%E8%AE%A1%20%E8%AF%B4%E6%98%8E.md",
    );
    expect(parseAssetPreviewPath(new URL(url).pathname)).toEqual({
      deviceHandle: "device-office",
      workspaceHandle: "workspace-demo",
      path: "r_docs/docs/设计 说明.md",
    });
  });

  it.each([
    "/assets/preview/v1/device/workspace/r_root/file.md",
    "/assets/preview/v2/device/workspace/r_root/../secret.md",
    "/assets/preview/v2/device/workspace/r_root/%2E%2E/secret.md",
    "/assets/preview/v2/device/workspace/r_root/docs%2Fsecret.md",
    "/assets/preview/v2/device/workspace/r_root/a//b.md",
    "/assets/preview/v2/device/workspace/C%3A/secret.md",
  ])("rejects ambiguous or escaping spelling: %s", (pathname) => {
    expect(parseAssetPreviewPath(pathname)).toBeNull();
  });

  it("refuses a locator too large for the bounded exchange head", () => {
    expect(() =>
      assetPreviewUrl("device", "workspace", `r_root/a${"x".repeat(4096)}`),
    ).toThrow(/canonical root-qualified/);
  });

  it("keeps a deployment subpath in both generation and parsing", () => {
    const url = assetPreviewUrl(
      "device",
      "workspace",
      "r_docs/docs/readme.md",
      "https://app.example",
      "/genehub/",
    );
    expect(url).toBe(
      "https://app.example/genehub/assets/preview/v2/device/workspace/r_docs/docs/readme.md",
    );
    expect(parseAssetPreviewPath(new URL(url).pathname, "/genehub/")).toEqual({
      deviceHandle: "device",
      workspaceHandle: "workspace",
      path: "r_docs/docs/readme.md",
    });
    expect(parseAssetPreviewPath(new URL(url).pathname, "/")).toBeNull();
  });

  it("composes the Agent artifact prefix from origin, channel, device and workspace", () => {
    expect(
      assetPreviewBaseUrl(
        "device office",
        "workspace docs",
        "r_docs",
        "https://app.example",
        "/relay-dev-2/",
      ),
    ).toBe(
      "https://app.example/relay-dev-2/assets/preview/v2/device%20office/workspace%20docs/r_docs/",
    );
    expect(
      assetPreviewBaseUrl(
        "device office",
        "workspace docs",
        "r_product",
        "https://app.example",
        "/relay-dev-2/",
      ),
    ).toBe(
      "https://app.example/relay-dev-2/assets/preview/v2/device%20office/workspace%20docs/r_product/",
    );
  });
});
