/**
 * The only module allowed to know which shell it is running in.
 *
 * Business components must never branch on the host. When they need something
 * only one shell can do, it goes behind this interface, or it is declared
 * optional and the entry point is hidden when it is missing — the same way an
 * agent's `Capabilities` decide which controls exist (`web-workbench.md` §7).
 */

export interface Endpoint {
  /** WebSocket URL for the daemon, direct or relayed. */
  url: string;
  /** How we got here, for the connection badge. */
  via: "loopback" | "lan" | "relay";
  label: string;
  /**
   * The daemon's key fingerprint as the shell learned it, without asking the
   * connection. Present only where the shell has an independent source; it is
   * what makes comparing against the handshake worth anything.
   */
  fingerprint?: string;
}

export interface Notification {
  title: string;
  body?: string;
}

export interface Host {
  readonly kind: "browser" | "desktop";
  /** Where to connect on startup, or null when the user has to choose. */
  endpoint(): Promise<Endpoint | null>;
  notify(notification: Notification): void;
  openExternal(url: string): void;
  /** Present only where a native picker exists. */
  pickDirectory?(): Promise<string | null>;
  /**
   * Announces that the endpoint has moved, and returns an unsubscribe.
   *
   * A restarted daemon listens on a new port with a new token, so retrying the
   * old address forever is the one thing a client must not do. Only shells that
   * own the daemon can know this; a browser has nothing to offer here.
   */
  onEndpointChange?(listener: () => void): () => void;
  /** The shell asking the workbench to show remote access, e.g. from a tray menu. */
  onPairRequested?(listener: () => void): () => void;
}

/** Tauri injects this; its absence is how we know we are in a browser. */
interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event?: {
    listen(name: string, handler: () => void): Promise<() => void>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export function detectHost(): Host {
  return typeof window !== "undefined" && window.__TAURI__ ? desktopHost() : browserHost();
}

/**
 * In a browser the endpoint arrives in the fragment, put there by the Hub page
 * that minted the ticket. The fragment rather than the query string on purpose:
 * it is not sent to the server, so the ticket stays out of access logs.
 */
export function browserHost(location: Pick<Location, "hash"> = window.location): Host {
  return {
    kind: "browser",
    async endpoint() {
      const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
      const url = fragment.get("endpoint");
      if (!url) return null;
      return {
        url,
        via: url.includes("/forward/client") ? "relay" : "lan",
        label: new URL(url).host,
      };
    },
    notify({ title, body }) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") {
        new Notification(title, body === undefined ? undefined : { body });
        return;
      }
      if (Notification.permission !== "denied") void Notification.requestPermission();
    },
    openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  };
}

/**
 * The desktop shell already has the daemon running as a sidecar, so it knows
 * the loopback port and token and hands them over rather than making the user
 * pair with their own machine.
 */
export function desktopHost(): Host {
  const tauri = window.__TAURI__!;
  return {
    kind: "desktop",
    async endpoint() {
      const found = await tauri.core.invoke<DaemonEndpoint | null>("daemon_endpoint");
      if (!found) return null;
      return {
        url: `ws://127.0.0.1:${found.port}/ws?token=${found.token}`,
        via: "loopback",
        label: "这台电脑",
        fingerprint: found.fingerprint,
      };
    },
    notify(notification) {
      void tauri.core.invoke("notify", { ...notification });
    },
    openExternal(url) {
      void tauri.core.invoke("open_external", { url });
    },
    async pickDirectory() {
      return tauri.core.invoke<string | null>("pick_directory");
    },
    onEndpointChange(listener) {
      return subscribe(tauri, "genehub://daemon", listener);
    },
    onPairRequested(listener) {
      return subscribe(tauri, "genehub://pair", listener);
    },
  };
}

/** Tauri hands back the unsubscribe asynchronously; React wants it now. */
function subscribe(tauri: TauriGlobal, name: string, listener: () => void): () => void {
  let stop: (() => void) | undefined;
  let cancelled = false;
  void tauri.event?.listen(name, listener).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

/** What the shell reads off the daemon's own startup output. */
interface DaemonEndpoint {
  port: number;
  token: string;
  machineId: string;
  fingerprint: string;
}
