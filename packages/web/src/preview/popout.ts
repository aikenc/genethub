const POPOUT_PARAM = "genehubPreviewPopout";
const SESSION_PARAM = "genehubPreviewSession";
const CHANNEL_NAME = "genehub-preview-popout-v1";
const STORAGE_KEY = "__genehub_preview_popout_v1__";
const MESSAGE_SOURCE = "genehub-preview-popout-v1";

export type PreviewPopoutContext = {
  id: string;
  sessionId: string | null;
};

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
): { id: string; url: string } {
  const url = new URL(previewUrl, window.location.href);
  url.searchParams.set(POPOUT_PARAM, id);
  if (sessionId) url.searchParams.set(SESSION_PARAM, sessionId);
  else url.searchParams.delete(SESSION_PARAM);
  return { id, url: url.toString() };
}

export function parsePreviewPopout(search: string): PreviewPopoutContext | null {
  const params = new URLSearchParams(search);
  const id = safeToken(params.get(POPOUT_PARAM));
  if (!id) return null;
  const rawSessionId = params.get(SESSION_PARAM);
  const sessionId = rawSessionId === null ? null : safeToken(rawSessionId);
  if (rawSessionId !== null && !sessionId) return null;
  return { id, sessionId };
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

function runtimeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
