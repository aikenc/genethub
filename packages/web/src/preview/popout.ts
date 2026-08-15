import type { Client } from "../protocol/client";
import type { AssetPreviewLocation } from "./url";

const POPOUT_PARAM = "genehubPreviewPopout";
const SESSION_PARAM = "genehubPreviewSession";
const CHANNEL_NAME = "genehub-preview-popout-v1";
const STORAGE_KEY = "__genehub_preview_popout_v1__";
const MESSAGE_SOURCE = "genehub-preview-popout-v1";
const OPENER_BRIDGE_KEY = "__genehub_preview_popout_clients_v1__";

export type PreviewPopoutContext = {
  id: string;
  sessionId: string | null;
};

type PreviewPopoutClientEntry = {
  context: PreviewPopoutContext;
  source: AssetPreviewLocation;
  client: Client;
};

type PreviewPopoutBridgeOwner = Window & {
  [OPENER_BRIDGE_KEY]?: Map<string, PreviewPopoutClientEntry>;
};

const inheritedClients = new Map<
  string,
  PreviewPopoutClientEntry
>();

export type PreviewPopoutMessage =
  | {
      source: typeof MESSAGE_SOURCE;
      type: "ready";
      id: string;
      sessionId: string | null;
    }
  | {
      source: typeof MESSAGE_SOURCE;
      type: "artifact";
      id: string;
      sessionId: string;
      workspacePath: string;
    };

export function createPreviewPopoutUrl(
  previewUrl: string,
  sessionId: string | null,
  id = runtimeId(),
  connectionHash = typeof window === "undefined" ? "" : window.location.hash,
): { id: string; url: string } {
  const url = new URL(previewUrl, window.location.href);
  url.searchParams.set(POPOUT_PARAM, id);
  if (sessionId) url.searchParams.set(SESSION_PARAM, sessionId);
  else url.searchParams.delete(SESSION_PARAM);
  // Asset Preview locators deliberately omit connection details. A popout is
  // still the same browser on the same origin, though, and needs the current
  // machine rendezvous address to create its own daemon connection. Fragments
  // never reach the HTTP server or access log, so they also carry a fallback
  // copy of the popout/session context.
  const endpoint = new URLSearchParams(
    (url.hash || connectionHash).replace(/^#/, ""),
  ).get("endpoint");
  const fragment = new URLSearchParams();
  if (endpoint) fragment.set("endpoint", endpoint);
  // Keep a fragment copy as a redirect-proof fallback. It never reaches the
  // HTTP server, while the query copy keeps old clients compatible.
  fragment.set(POPOUT_PARAM, id);
  if (sessionId) fragment.set(SESSION_PARAM, sessionId);
  url.hash = fragment.toString();
  return { id, url: url.toString() };
}

export function parsePreviewPopout(
  search: string,
  hash = "",
): PreviewPopoutContext | null {
  const params = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const rawId = params.get(POPOUT_PARAM) ?? fragment.get(POPOUT_PARAM);
  const id = safeToken(rawId);
  if (!id) return null;
  const rawSessionId = params.get(SESSION_PARAM) ?? fragment.get(SESSION_PARAM);
  const sessionId = rawSessionId === null ? null : safeToken(rawSessionId);
  if (rawSessionId !== null && !sessionId) return null;
  return { id, sessionId };
}

/**
 * Makes the already-connected workbench Client available to one same-origin
 * popout. This avoids opening a second Fabric session with the same browser
 * credential, which would evict the workbench connection. The random popout id
 * is the capability and the entry is removed as soon as the child consumes it.
 */
export function registerPreviewPopoutClient(
  context: PreviewPopoutContext,
  source: AssetPreviewLocation,
  client: Client,
  owner: PreviewPopoutBridgeOwner = window,
): () => void {
  const clients = owner[OPENER_BRIDGE_KEY] ?? new Map<string, PreviewPopoutClientEntry>();
  owner[OPENER_BRIDGE_KEY] = clients;
  const entry = { context, source, client } satisfies PreviewPopoutClientEntry;
  clients.set(context.id, entry);
  return () => {
    if (clients.get(context.id) === entry) clients.delete(context.id);
  };
}

/** Consumes the opener's shared Client, then severs the child-to-opener link. */
export function takePreviewPopoutClient(
  context: PreviewPopoutContext,
  source: AssetPreviewLocation,
  child: Pick<Window, "opener"> = window,
): Client | null {
  return takePreviewPopoutBridge(context, source, child)?.client ?? null;
}

/** Takes the shared Client and the opener-authoritative session context. */
export function takePreviewPopoutBridge(
  context: PreviewPopoutContext,
  source: AssetPreviewLocation,
  child: Pick<Window, "opener"> = window,
): { context: PreviewPopoutContext; client: Client } | null {
  const cached = inheritedClients.get(context.id);
  if (cached) {
    if (
      (context.sessionId !== null && cached.context.sessionId !== context.sessionId) ||
      !sameSource(cached.source, source)
    ) {
      return null;
    }
    return { context: cached.context, client: cached.client };
  }
  try {
    const owner = child.opener as PreviewPopoutBridgeOwner | null;
    const clients = owner?.[OPENER_BRIDGE_KEY];
    const entry = clients?.get(context.id);
    if (
      !entry ||
      (context.sessionId !== null && entry.context.sessionId !== context.sessionId) ||
      !sameSource(entry.source, source)
    ) {
      return null;
    }
    clients?.delete(context.id);
    const inherited = {
      context: entry.context,
      source: entry.source,
      client: entry.client,
    };
    inheritedClients.set(context.id, inherited);
    return { context: inherited.context, client: inherited.client };
  } catch {
    return null;
  } finally {
    // The H5 itself runs in an opaque sandbox and cannot reach this property;
    // sever it anyway once the trusted shell has consumed the one-time entry.
    try {
      child.opener = null;
    } catch {
      // Some embedded browsers expose opener as read-only.
    }
  }
}

export function previewPopoutReady(context: PreviewPopoutContext): PreviewPopoutMessage {
  return { source: MESSAGE_SOURCE, type: "ready", ...context };
}

export function previewPopoutArtifact(
  context: PreviewPopoutContext & { sessionId: string },
  workspacePath: string,
): PreviewPopoutMessage {
  return { source: MESSAGE_SOURCE, type: "artifact", ...context, workspacePath };
}

export function createPreviewPopoutChannel(
  onMessage: (message: PreviewPopoutMessage) => void,
): { post(message: PreviewPopoutMessage): void; close(): void } {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event) => {
      const message = validMessage(event.data);
      if (message) onMessage(message);
    });
    return {
      post: (message) => channel.postMessage(message),
      close: () => channel.close(),
    };
  }

  const receive = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const envelope = JSON.parse(event.newValue) as { message?: unknown };
      const message = validMessage(envelope.message);
      if (message) onMessage(message);
    } catch {
      // Another tab may have written malformed or stale data; ignore it.
    }
  };
  window.addEventListener("storage", receive);
  return {
    post(message) {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ nonce: runtimeId(), message }),
        );
      } catch {
        // Capture still persists to daemon if cross-window notification is unavailable.
      }
    },
    close() {
      window.removeEventListener("storage", receive);
    },
  };
}

function validMessage(value: unknown): PreviewPopoutMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== MESSAGE_SOURCE || !safeToken(candidate.id)) return null;
  const sessionId =
    candidate.sessionId === null ? null : safeToken(candidate.sessionId);
  if (candidate.sessionId !== null && !sessionId) return null;
  if (candidate.type === "ready") {
    return {
      source: MESSAGE_SOURCE,
      type: "ready",
      id: candidate.id as string,
      sessionId,
    };
  }
  if (
    candidate.type === "artifact" &&
    sessionId &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.startsWith(`.genethub/sessions/${sessionId}/artifacts/`)
  ) {
    return {
      source: MESSAGE_SOURCE,
      type: "artifact",
      id: candidate.id as string,
      sessionId,
      workspacePath: candidate.workspacePath,
    };
  }
  return null;
}

function safeToken(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) return null;
  return value;
}

function sameSource(left: AssetPreviewLocation, right: AssetPreviewLocation): boolean {
  return (
    left.deviceHandle === right.deviceHandle &&
    left.workspaceHandle === right.workspaceHandle &&
    left.path === right.path
  );
}

function runtimeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
