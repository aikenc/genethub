import { describe, expect, it } from "vitest";

import { resolveArtifactRef, resolveWorkspacePath } from "./resolveArtifactRef";

const context = {
  deviceHandle: "m_device",
  workspaceHandle: "w_docs",
  folders: [
    { root: "/srv/product", rootHandle: "r_product" },
    { root: "/srv/docs", rootHandle: "r_docs" },
  ],
};

describe("resolveArtifactRef", () => {
  it("maps cwd-relative paths onto the first workspace root", () => {
    const resolved = resolveArtifactRef("reports/结果.md", context, "https://app.example");
    expect(resolved).toEqual({
      kind: "preview",
      path: "r_product/reports/结果.md",
      href: "https://app.example/assets/preview/v2/m_device/w_docs/r_product/reports/%E7%BB%93%E6%9E%9C.md",
    });
  });

  it("maps absolute filesystem paths to the longest matching root", () => {
    const resolved = resolveArtifactRef(
      "/srv/docs/guide/intro.md",
      context,
      "https://app.example",
    );
    expect(resolved).toMatchObject({
      kind: "preview",
      path: "r_docs/guide/intro.md",
    });
  });

  it("rebinds stale Preview URLs to the current device and project", () => {
    const resolved = resolveArtifactRef(
      "https://old.example/console/assets/preview/v2/m_old/w_old/r_stale/reports/a.md",
      context,
      "https://app.example",
    );
    expect(resolved).toEqual({
      kind: "preview",
      path: "r_stale/reports/a.md",
      href: "https://app.example/assets/preview/v2/m_device/w_docs/r_stale/reports/a.md",
    });
  });

  it("keeps ordinary external links", () => {
    expect(resolveArtifactRef("https://example.com/docs", context)).toEqual({
      kind: "external",
      href: "https://example.com/docs",
    });
  });

  it("blocks javascript and bare data URLs", () => {
    expect(resolveArtifactRef("javascript:alert(1)", context).kind).toBe("blocked");
    expect(resolveArtifactRef("data:text/html,hi", context).kind).toBe("blocked");
  });

  it("resolves document-relative paths for Markdown Preview", () => {
    const path = resolveWorkspacePath("../assets/logo.png", {
      ...context,
      documentPath: "r_product/docs/readme.md",
    });
    expect(path).toBe("r_product/assets/logo.png");
  });

  it("rejects path escape above the document root handle", () => {
    expect(
      resolveWorkspacePath("../../secret.txt", {
        ...context,
        documentPath: "r_product/docs/readme.md",
      }),
    ).toBeNull();
  });
});
