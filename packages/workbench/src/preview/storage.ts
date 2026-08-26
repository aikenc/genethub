/**
 * Persistent storage for sandboxed HTML previews.
 *
 * Preview iframes run with `sandbox="allow-scripts"` (no allow-same-origin),
 * so `window.localStorage` throws SecurityError on access and nothing inside
 * the frame can persist. Real pages — games saving high scores, apps caching
 * preferences — touch localStorage unconditionally and crash. The shim
 * injected into the srcdoc replaces localStorage with a same-interface
 * object backed by a snapshot inlined at srcdoc build time; writes go
 * through in memory and are posted to the parent, which persists them under
 * a namespace confined to this preview's device/workspace/entry directory.
 * The workbench origin's own storage stays unreachable from the frame.
 *
 * Quotas are enforced on BOTH sides: the shim has the complete state and
 * throws QuotaExceededError synchronously like the native API; the parent
 * re-validates before persisting so a hostile frame cannot exhaust the
 * workbench origin's shared localStorage quota.
 */

export const PREVIEW_STORAGE_SOURCE = "genehub-preview-storage";

/** Per-key and per-value size caps (in UTF-16 chars, like the native API). */
export const PREVIEW_STORAGE_KEY_LIMIT = 1_024;
export const PREVIEW_STORAGE_VALUE_LIMIT = 128_000;
/** Total per namespace — bounds one preview's footprint in the origin quota. */
export const PREVIEW_STORAGE_NAMESPACE_LIMIT = 400_000;

export type PreviewStorageScope = {
  deviceHandle: string;
  workspaceHandle: string;
};

/** Pages of one site (the entry HTML's directory) share a store, like an origin. */
export function previewStorageNamespace(
  scope: PreviewStorageScope,
  entryPath: string,
): string {
  const dir = entryPath.split("/").slice(0, -1).join("/");
  return `${scope.deviceHandle}/${scope.workspaceHandle}/${dir}`;
}

function storageKey(namespace: string): string {
  return `genehub:preview-store:v1:${namespace}`;
}

export function loadPreviewStore(namespace: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey(namespace));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

function storeSize(store: Record<string, string>): number {
  let size = 0;
  for (const [key, value] of Object.entries(store)) size += key.length + value.length;
  return size;
}

export type PreviewStoreMutation =
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string }
  | { op: "clear" };

/** Parses an untrusted bridge message into a mutation, or null if malformed. */
export function parsePreviewStoreMutation(data: {
  op?: unknown;
  key?: unknown;
  value?: unknown;
}): PreviewStoreMutation | null {
  if (data.op === "clear") return { op: "clear" };
  if (typeof data.key !== "string") return null;
  if (data.op === "remove") return { op: "remove", key: data.key };
  if (data.op === "set" && typeof data.value === "string") {
    return { op: "set", key: data.key, value: data.value };
  }
  return null;
}

export function clearPreviewStore(namespace: string): void {
  try {
    localStorage.removeItem(storageKey(namespace));
  } catch {
    // Storage blocked: nothing persisted, so nothing to clear.
  }
}

/**
 * Applies a mutation from the frame, enforcing quota before persisting.
 * Returns false when the mutation is rejected — the shim enforces the same
 * limits synchronously, so a rejection here means a hostile or buggy frame
 * and the write is dropped silently.
 */
export function applyPreviewStoreMutation(
  namespace: string,
  mutation: PreviewStoreMutation,
): boolean {
  try {
    const store = loadPreviewStore(namespace);
    if (mutation.op === "clear") {
      localStorage.setItem(storageKey(namespace), "{}");
      return true;
    }
    if (mutation.key.length > PREVIEW_STORAGE_KEY_LIMIT) return false;
    if (mutation.op === "remove") {
      delete store[mutation.key];
    } else {
      if (mutation.value.length > PREVIEW_STORAGE_VALUE_LIMIT) return false;
      const previous = store[mutation.key];
      const next =
        storeSize(store) -
        (previous === undefined ? 0 : mutation.key.length + previous.length) +
        mutation.key.length +
        mutation.value.length;
      if (next > PREVIEW_STORAGE_NAMESPACE_LIMIT) return false;
      store[mutation.key] = mutation.value;
    }
    localStorage.setItem(storageKey(namespace), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/**
 * Source of the in-frame shim. Installed before application scripts. If the
 * native localStorage turns out to be usable (preview opened outside the
 * sandbox), the shim does nothing. sessionStorage is shimmed memory-only:
 * session semantics never persist across loads anyway.
 */
export function previewStorageShimSource(snapshot: Record<string, string>): string {
  return `(function(){
  var SNAPSHOT = ${JSON.stringify(snapshot)};
  var SOURCE = ${JSON.stringify(PREVIEW_STORAGE_SOURCE)};
  var KEY_LIMIT = ${PREVIEW_STORAGE_KEY_LIMIT};
  var VALUE_LIMIT = ${PREVIEW_STORAGE_VALUE_LIMIT};
  var NAMESPACE_LIMIT = ${PREVIEW_STORAGE_NAMESPACE_LIMIT};
  try {
    var probe = "__genehub_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return; // native storage works — nothing to shim
  } catch (e) {}
  function quotaError() {
    return new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }
  function sizeOf(store) {
    var size = 0;
    for (var k in store) if (Object.prototype.hasOwnProperty.call(store, k)) size += k.length + store[k].length;
    return size;
  }
  function notify(op, key, value) {
    try {
      parent.postMessage({ source: SOURCE, op: op, key: key, value: value }, "*");
    } catch (e) {}
  }
  function createStore(initial, persist) {
    var data = {};
    for (var k0 in initial) if (Object.prototype.hasOwnProperty.call(initial, k0)) data[k0] = String(initial[k0]);
    function keys() {
      var out = [];
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out.push(k);
      return out;
    }
    var api = {
      get length() { return keys().length; },
      key: function(index) { var ks = keys(); return index >= 0 && index < ks.length ? ks[index] : null; },
      getItem: function(key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function(key, value) {
        key = String(key); value = String(value);
        if (key.length > KEY_LIMIT || value.length > VALUE_LIMIT) throw quotaError();
        var had = Object.prototype.hasOwnProperty.call(data, key);
        var next = sizeOf(data) - (had ? key.length + data[key].length : 0) + key.length + value.length;
        if (next > NAMESPACE_LIMIT) throw quotaError();
        data[key] = value;
        if (persist) notify("set", key, value);
      },
      removeItem: function(key) {
        key = String(key);
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          delete data[key];
          if (persist) notify("remove", key, "");
        }
      },
      clear: function() {
        data = {};
        if (persist) notify("clear", "", "");
      }
    };
    if (typeof Proxy === "function") {
      // Property-style access (localStorage.foo) used by some pages.
      api = new Proxy(api, {
        get: function(target, prop) {
          if (typeof prop === "string" && !(prop in target)) return target.getItem(prop);
          var value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
        set: function(target, prop, value) {
          if (typeof prop === "string" && !(prop in target)) { target.setItem(prop, value); return true; }
          return false;
        },
        deleteProperty: function(target, prop) {
          if (typeof prop === "string") target.removeItem(prop);
          return true;
        }
      });
    }
    // Parent-initiated wipe (user cleared this site's Preview storage): reset
    // without notifying back — the parent already cleared its copy.
    return { api: api, reset: function() { data = {}; } };
  }
  var local = createStore(SNAPSHOT, true);
  var session = createStore({}, false);
  try {
    Object.defineProperty(window, "localStorage", { value: local.api, configurable: true, writable: true });
    Object.defineProperty(window, "sessionStorage", { value: session.api, configurable: true, writable: true });
  } catch (e) {
    try { window.localStorage = local.api; } catch (e2) {}
    try { window.sessionStorage = session.api; } catch (e3) {}
  }
  window.addEventListener("message", function(event) {
    var d = event && event.data;
    if (d && typeof d === "object" && d.source === SOURCE && d.command === "clear") local.reset();
  });
  notify("ready", "", String(local.api.length));
})();`;
}
