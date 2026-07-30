/**
 * The only module allowed to know which shell it is running in.
 *
 * Business components must never branch on the host. When they need something
 * only one shell can do, it goes behind this interface, or it is declared
 * optional and the entry point is hidden when it is missing — the same way an
 * agent's `Capabilities` decide which controls exist (`web-workbench.md` §7).
 */

import { findMachine, type PairedMachine, readPairingLink, rememberMachine } from "../devices/machines";

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
  /**
   * What this browser got when it paired with the machine. A machine reached
   * through a rendezvous relay will not talk without it.
   */
  credential?: { deviceId: string; secret: string };
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
  /**
   * Opens a page that is part of getting signed in.
   *
   * Separate from `openExternal` because the answer differs by shell: a browser
   * opens a tab, but a desktop app opens a window of its own rather than
   * throwing the user out to a different browser and back. Absent means "no
   * difference here" and callers fall back to `openExternal`.
   */
  openWindow?(url: string): void;
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
  /**
   * The shell asking for a fresh way into this machine's identity. Separate
   * from pairing because it is what someone reaches for after losing the
   * browser they were signed in on, and it must not require finding a setting.
   */
  onClaimRequested?(listener: () => void): () => void;
  /**
   * An unredeemed pairing invite the user arrived with, if this shell can be
   * arrived at by link at all. A desktop app cannot.
   */
  pendingPairing?(): { code: string; endpoint: string } | null;
  /** Records the redeemed pairing so later visits connect without one. */
  rememberPairing?(machine: PairedMachine): void;
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

/**
 * Cached, because which shell we are in cannot change while the page is open,
 * and because a fresh object every call would make this unusable as a React
 * dependency — see the note above `openConnection` in `App.tsx`.
 *
 * Keyed on the thing it decides from rather than cached outright, so it stays
 * honest if the answer does change: that never happens in a real page, and it
 * happens in every test that covers both shells.
 */
let detected: { desktop: boolean; host: Host } | null = null;

export function detectHost(): Host {
  const desktop = typeof window !== "undefined" && !!window.__TAURI__;
  if (!detected || detected.desktop !== desktop) {
    detected = { desktop, host: desktop ? desktopHost() : browserHost() };
  }
  return detected.host;
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
      const paired = findMachine(url);
      return {
        url,
        via: url.includes("/forward/client") ? "relay" : "lan",
        label: paired?.name ?? new URL(url).host,
        fingerprint: paired?.fingerprint,
        credential: paired ? { deviceId: paired.deviceId, secret: paired.secret } : undefined,
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
    pendingPairing() {
      return readPairingLink(location.hash);
    },
    rememberPairing(machine) {
      rememberMachine(machine);
      // Drops the one-time code from the address bar so a reload does not try
      // to spend it twice, and so it stays out of the browser's history.
      window.location.hash = `endpoint=${encodeURIComponent(machine.endpoint)}`;
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
    openWindow(url) {
      void tauri.core.invoke("open_window", { url });
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
    onClaimRequested(listener) {
      return subscribe(tauri, "genehub://claim", listener);
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
