/**
 * The only module allowed to know how this browser reached its machines.
 *
 * Business components never infer a native shell. Official Web, Desktop
 * WebView, mobile and self-hosted pages all use this browser contract.
 */


import {
  findMachine,
  listMachines,
  type PairedMachine,
  readPairingLink,
  rememberMachine,
} from "../devices/machines";
import type { LocalServerProof } from "../protocol/client";

/**
 * A machine this client can control.
 *
 * Deliberately says nothing about accounts. "Which machines am I allowed to
 * drive" is a question a self-hosted copy asks too — it answers it from the
 * machines this browser paired with — and a deployment that has accounts
 * answers the same question from a better source. Putting a user on this type
 * would make the switcher an account feature, which is exactly the coupling
 * this indirection exists to avoid.
 */
export interface Target {
  id: string;
  /** Stable daemon-owned handle used in portable asset-preview URLs. */
  deviceHandle?: string;
  label: string;
  /**
   * A direct/local roster entry. This describes the route, not a native host.
   */
  kind: "local" | "remote";
  /** Only where the source knows. Absent means "no idea", not "offline". */
  online?: boolean;
  fingerprint?: string;
}

/** The conventional id for a browser roster's direct/local entry. */
export const LOCAL_TARGET = "local";

export interface Endpoint {
  /** WebSocket URL for the daemon, direct or relayed. */
  url: string;
  /** How we got here, for the connection badge. */
  via: "loopback" | "lan" | "relay";
  label: string;
  /**
   * The daemon's key fingerprint as the host learned it, without asking the
   * connection. Present only where the host has an independent source; it is
   * what makes comparing against the handshake worth anything.
   */
  fingerprint?: string;
  /**
   * What this browser got when it paired with the machine. A machine reached
   * through a rendezvous relay will not talk without it.
   */
  credential?: { deviceId: string; secret: string };
  /** Fresh hosted-channel secret paired with this one-use Relay URL. */
  channelCredential?: { capabilityId: string; secret: string };
  /** One-use opaque route consumed as the first OPEN on a Fabric endpoint. */
  fabricRouteTicket?: string;
  /** Out-of-band proof that a loopback listener owns the daemon endpoint. */
  localServerProof?: LocalServerProof;
}

export interface Notification {
  title: string;
  body?: string;
}

export interface Host {
  /** Every product surface is an ordinary browser, including Desktop WebView. */
  readonly kind: "browser";
  /** Where to connect on startup, or null when the user has to choose. */
  endpoint(): Promise<Endpoint | null>;
  /**
   * Every machine this client can drive, for the switcher in the sidebar.
   *
   * Optional so that a host with exactly one machine — a test double, an
   * embedder that only ever points at one daemon — stays a two-method object
   * and gets no switcher rather than a list of one.
   */
  targets?(): Promise<Target[]>;
  /**
   * Switches to one of them, returning where to connect.
   *
   * Called again on every reconnect rather than once per switch, because a
   * forwarding ticket is spent by the connection that used it: a host that
   * mints one here must mint a fresh one each time, and one that does not
   * simply returns the same address.
   */
  openTarget?(id: string, options?: { remember?: boolean }): Promise<Endpoint>;
  notify(notification: Notification): void;
  openExternal(url: string): void;
  /**
   * An unredeemed pairing invite the browser arrived with. The official
   * Desktop auth-first route does not use fragment pairing links.
   */
  pendingPairing?(): { code: string; endpoint: string } | null;
  /** Records the redeemed pairing so later visits connect without one. */
  rememberPairing?(machine: PairedMachine): void;
}

/**
 * Product Web is a browser application on every surface. The desktop shell
 * loads the official origin without injecting a Tauri global, so the same
 * account, machine directory and Relay/WebRTC path is used by desktop, mobile
 * and a normal browser. Cache the object because React uses it as a dependency.
 */
let detected: Host | null = null;

export function detectHost(): Host {
  detected ??= browserHost();
  return detected;
}

/**
 * In a browser the endpoint arrives in the fragment, put there by the Hub page
 * that minted the ticket. The fragment rather than the query string on purpose:
 * it is not sent to the server, so the ticket stays out of access logs.
 */
export function browserHost(
  location: Pick<Location, "hash"> = window.location,
): Host {
  return {
    kind: "browser",
    async endpoint() {
      const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
      const url = fragment.get("endpoint");
      if (!url) return null;
      return reach(findMachine(url), url);
    },
    async targets() {
      // Every paired machine is remote here. The browser is not running on any
      // of them; even the one on this very computer is reached the same way.
      return listMachines().map((machine) => ({
        id: machine.machineId,
        deviceHandle: machine.machineId,
        label: machine.name,
        kind: "remote" as const,
        fingerprint: machine.fingerprint,
      }));
    },
    async openTarget(id, options) {
      const machine = listMachines().find((entry) => entry.machineId === id);
      if (!machine)
        throw new Error("这台机器不在本地名册里，可能已经被忘掉了。");
      // The address bar follows the switch, so a reload stays on the machine
      // the user is looking at rather than jumping back to the one they
      // arrived on.
      if (options?.remember !== false) {
        window.location.hash = `endpoint=${encodeURIComponent(machine.endpoint)}`;
      }
      return reach(machine, machine.endpoint);
    },
    notify({ title, body }) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") {
        new Notification(title, body === undefined ? undefined : { body });
        return;
      }
      if (Notification.permission !== "denied")
        void Notification.requestPermission();
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
      const clean = `${window.location.pathname}${window.location.search}#endpoint=${encodeURIComponent(machine.endpoint)}`;
      window.history.replaceState(window.history.state, "", clean);
    },
  };
}

/**
 * What it takes to reach a machine we paired with.
 *
 * The credential has to ride along: a machine reached through a rendezvous
 * relay will not answer without it, and it is the one thing the address alone
 * cannot carry.
 */
function reach(paired: PairedMachine | null, url: string): Endpoint {
  return {
    url,
    via: url.includes("/fabric/v2") ? "relay" : "lan",
    label: paired?.name ?? new URL(url).host,
    fingerprint: paired?.fingerprint,
    credential: paired
      ? { deviceId: paired.deviceId, secret: paired.secret }
      : undefined,
  };
}
