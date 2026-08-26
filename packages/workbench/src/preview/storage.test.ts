import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPreviewStoreMutation,
  clearPreviewStore,
  loadPreviewStore,
  parsePreviewStoreMutation,
  PREVIEW_STORAGE_KEY_LIMIT,
  PREVIEW_STORAGE_NAMESPACE_LIMIT,
  PREVIEW_STORAGE_SOURCE,
  PREVIEW_STORAGE_VALUE_LIMIT,
  previewStorageNamespace,
  previewStorageShimSource,
} from "./storage";

const NAMESPACE = "machine-a/workspace-b/games/snake";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("previewStorageNamespace", () => {
  it("scopes the store to the entry file's directory so a site's pages share it", () => {
    expect(
      previewStorageNamespace(
        { deviceHandle: "machine-a", workspaceHandle: "workspace-b" },
        "games/snake/index.html",
      ),
    ).toBe(NAMESPACE);
    expect(
      previewStorageNamespace(
        { deviceHandle: "machine-a", workspaceHandle: "workspace-b" },
        "games/snake/level2.html",
      ),
    ).toBe(NAMESPACE);
  });

  it("keeps root files and other directories apart", () => {
    const scope = { deviceHandle: "machine-a", workspaceHandle: "workspace-b" };
    expect(previewStorageNamespace(scope, "index.html")).toBe("machine-a/workspace-b/");
    expect(previewStorageNamespace(scope, "games/other/index.html")).not.toBe(NAMESPACE);
  });
});

describe("parent-side store", () => {
  it("round-trips mutations through localStorage under the namespace", () => {
    expect(loadPreviewStore(NAMESPACE)).toEqual({});
    expect(applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "score", value: "42" })).toBe(
      true,
    );
    expect(applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "name", value: "ada" })).toBe(
      true,
    );
    expect(loadPreviewStore(NAMESPACE)).toEqual({ score: "42", name: "ada" });
    expect(applyPreviewStoreMutation(NAMESPACE, { op: "remove", key: "name" })).toBe(true);
    expect(loadPreviewStore(NAMESPACE)).toEqual({ score: "42" });
  });

  it("does not leak across namespaces", () => {
    applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "score", value: "42" });
    expect(loadPreviewStore("machine-a/workspace-b/games/other")).toEqual({});
    expect(localStorage.getItem("genehub.runtime.by-workspace")).toBeNull();
  });

  it("rejects oversize keys, values and namespaces", () => {
    expect(
      applyPreviewStoreMutation(NAMESPACE, {
        op: "set",
        key: "k".repeat(PREVIEW_STORAGE_KEY_LIMIT + 1),
        value: "v",
      }),
    ).toBe(false);
    expect(
      applyPreviewStoreMutation(NAMESPACE, {
        op: "set",
        key: "k",
        value: "v".repeat(PREVIEW_STORAGE_VALUE_LIMIT + 1),
      }),
    ).toBe(false);
    // Fill most of the namespace budget with per-value-legal writes, then one
    // more key must fail while replacing an existing key same-size still fits.
    const filler = "v".repeat(PREVIEW_STORAGE_VALUE_LIMIT);
    for (const key of ["k1", "k2", "k3"]) {
      expect(applyPreviewStoreMutation(NAMESPACE, { op: "set", key, value: filler })).toBe(true);
    }
    const oversized = "x".repeat(PREVIEW_STORAGE_NAMESPACE_LIMIT - 3 * (2 + filler.length) + 10);
    expect(
      applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "extra", value: oversized }),
    ).toBe(false);
    expect(applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "k1", value: filler })).toBe(
      true,
    );
    expect(loadPreviewStore(NAMESPACE)).toEqual({ k1: filler, k2: filler, k3: filler });
  });

  it("clears only its own namespace", () => {
    applyPreviewStoreMutation(NAMESPACE, { op: "set", key: "score", value: "42" });
    applyPreviewStoreMutation("machine-a/workspace-b/", { op: "set", key: "x", value: "y" });
    clearPreviewStore(NAMESPACE);
    expect(loadPreviewStore(NAMESPACE)).toEqual({});
    expect(loadPreviewStore("machine-a/workspace-b/")).toEqual({ x: "y" });
  });

  it("treats malformed stored JSON as empty", () => {
    localStorage.setItem(`genehub:preview-store:v1:${NAMESPACE}`, "not json{");
    expect(loadPreviewStore(NAMESPACE)).toEqual({});
    localStorage.setItem(`genehub:preview-store:v1:${NAMESPACE}`, '["array"]');
    expect(loadPreviewStore(NAMESPACE)).toEqual({});
    localStorage.setItem(
      `genehub:preview-store:v1:${NAMESPACE}`,
      '{"good":"1","bad":2,"alsoBad":null}',
    );
    expect(loadPreviewStore(NAMESPACE)).toEqual({ good: "1" });
  });
});

describe("parsePreviewStoreMutation", () => {
  it("accepts well-formed mutations", () => {
    expect(parsePreviewStoreMutation({ op: "set", key: "k", value: "v" })).toEqual({
      op: "set",
      key: "k",
      value: "v",
    });
    expect(parsePreviewStoreMutation({ op: "remove", key: "k" })).toEqual({
      op: "remove",
      key: "k",
    });
    expect(parsePreviewStoreMutation({ op: "clear" })).toEqual({ op: "clear" });
  });

  it("rejects malformed messages from the frame", () => {
    expect(parsePreviewStoreMutation({})).toBeNull();
    expect(parsePreviewStoreMutation({ op: "set", key: "k" })).toBeNull();
    expect(parsePreviewStoreMutation({ op: "set", key: 1, value: "v" })).toBeNull();
    expect(parsePreviewStoreMutation({ op: "remove" })).toBeNull();
    expect(parsePreviewStoreMutation({ op: "ready", key: "k", value: "0" })).toBeNull();
    expect(parsePreviewStoreMutation({ op: "__proto__", key: "k", value: "v" })).toBeNull();
  });
});

describe("in-frame shim", () => {
  function installShimWithBrokenNativeStorage(snapshot: Record<string, string>) {
    const native = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    const messages: Array<{ source?: string; op?: string; key?: string; value?: string }> = [];
    const listener = (event: MessageEvent) => {
      if (event.data?.source === PREVIEW_STORAGE_SOURCE) messages.push(event.data);
    };
    window.addEventListener("message", listener);
    // eslint-disable-next-line no-eval
    (0, eval)(previewStorageShimSource(snapshot));
    return {
      messages,
      restore() {
        window.removeEventListener("message", listener);
        Object.defineProperty(window, "localStorage", { configurable: true, value: native });
      },
    };
  }

  it("does nothing when native localStorage is usable", () => {
    const native = window.localStorage;
    // eslint-disable-next-line no-eval
    (0, eval)(previewStorageShimSource({ seeded: "1" }));
    expect(window.localStorage).toBe(native);
    expect(window.localStorage.getItem("seeded")).toBeNull();
  });

  it("serves the snapshot synchronously and posts writes to the parent", async () => {
    const shim = installShimWithBrokenNativeStorage({ score: "7" });
    try {
      const store = window.localStorage;
      expect(store.getItem("score")).toBe("7");
      store.setItem("name", "ada");
      expect(store.getItem("name")).toBe("ada");
      expect(store.length).toBe(2);
      expect(store.key(0)).toBe("score");
      store.removeItem("score");
      expect(store.getItem("score")).toBeNull();
      await vi.waitFor(() => {
        expect(shim.messages).toContainEqual({
          source: PREVIEW_STORAGE_SOURCE,
          op: "set",
          key: "name",
          value: "ada",
        });
        expect(shim.messages).toContainEqual({
          source: PREVIEW_STORAGE_SOURCE,
          op: "remove",
          key: "score",
          value: "",
        });
      });
      expect(shim.messages[0]).toMatchObject({ op: "ready", value: "1" });
    } finally {
      shim.restore();
    }
  });

  it("supports property-style access and throws QuotaExceededError over budget", () => {
    const shim = installShimWithBrokenNativeStorage({});
    try {
      const store = window.localStorage as unknown as Record<string, unknown> & Storage;
      store.highScore = "99";
      expect(store.highScore).toBe("99");
      expect(() =>
        store.setItem("huge", "v".repeat(PREVIEW_STORAGE_VALUE_LIMIT + 1)),
      ).toThrowError(expect.objectContaining({ name: "QuotaExceededError" }));
    } finally {
      shim.restore();
    }
  });

  it("wipes its in-memory copy when the parent commands a clear", async () => {
    const shim = installShimWithBrokenNativeStorage({ score: "7" });
    try {
      expect(window.localStorage.getItem("score")).toBe("7");
      window.postMessage({ source: PREVIEW_STORAGE_SOURCE, command: "clear" }, "*");
      await vi.waitFor(() => {
        expect(window.localStorage.getItem("score")).toBeNull();
        expect(window.localStorage.length).toBe(0);
      });
    } finally {
      shim.restore();
    }
  });

  it("shims sessionStorage memory-only without notifying", async () => {
    const shim = installShimWithBrokenNativeStorage({});
    try {
      window.sessionStorage.setItem("tab", "only");
      expect(window.sessionStorage.getItem("tab")).toBe("only");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        shim.messages.filter((m) => m.op !== "ready" && m.key === "tab"),
      ).toEqual([]);
    } finally {
      shim.restore();
    }
  });
});
