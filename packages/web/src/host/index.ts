/**
 * The only module allowed to know which shell it is running in.
 *
 * Business components must never branch on the host. When they need something
 * only one shell can do, it goes behind this interface, or it is declared
 * optional and the entry point is hidden when it is missing — the same way an
 * agent's `Capabilities` decide which controls exist (`web-workbench.md` §7).
 */

import type { HubMachine } from "@genehub/proto";
import type { UpdateStatus } from "@genehub/proto";

import { MANIFEST_URL } from "../channel";
import {
  findMachine,
  listMachines,
  type PairedMachine,
  readPairingLink,
  rememberMachine,
} from "../devices/machines";
import {
  Client,
  type LocalServerProof,
  type WebSocketLike,
} from "../protocol/client";

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
  label: string;
  /**
   * The machine this shell is running on. Not a mode: it is one entry in the
   * list, distinguished only by being the one that stays reachable with the
   * network off.
   */
  kind: "local" | "remote";
  /** Only where the source knows. Absent means "no idea", not "offline". */
  online?: boolean;
  fingerprint?: string;
}

/** The local machine's entry, for shells that have one. */
export const LOCAL_TARGET = "local";

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
  /** Fresh hosted-channel secret paired with this one-use Relay URL. */
  channelCredential?: { capabilityId: string; secret: string };
  /** Out-of-band proof that a loopback listener owns the daemon endpoint. */
  localServerProof?: LocalServerProof;
}

export interface Notification {
  title: string;
  body?: string;
}

/**
 * The parts of a window only its owner can move.
 *
 * One object rather than five optional methods, so that "does this shell have a
 * frame we are responsible for drawing?" is a single question. A browser tab is
 * not a window anyone here owns, so this is absent there and the workbench
 * draws no title bar at all.
 */
export interface WindowControls {
  minimize(): void;
  /** Returns whether the window ended up maximised, so the icon can follow. */
  toggleMaximize(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  /**
   * Asks to close. What that means is the shell's business — on the desktop it
   * is "hide and keep the daemon running", which is the whole point of the tray.
   */
  close(): void;
  /** Keeps the colour the OS paints mid-resize in step with the palette. */
  setBackground(dark: boolean): void;
}

export interface Host {
  readonly kind: "browser" | "desktop";
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
  openTarget?(id: string): Promise<Endpoint>;
  notify(notification: Notification): void;
  openExternal(url: string): void;
  /**
   * Asks the OS to run an installer the machine has already downloaded.
   *
   * Desktop only, and no fallback: a browser cannot run a file, and one on a
   * phone is not even on the machine the file is sitting on. Where this is
   * missing the prompt says where the installer is instead of offering a button
   * that could not work.
   */
  installUpdate?(path: string): Promise<void>;
  /**
   * Opens a page that is part of getting signed in.
   *
   * Separate from `openExternal` because the answer differs by shell: a browser
   * opens a tab, but a desktop app opens a window of its own rather than
   * throwing the user out to a different browser and back. Absent means "no
   * difference here" and callers fall back to `openExternal`.
   */
  openWindow?(url: string): void;
  /**
   * Present only where this app owns the window frame, which is where the
   * workbench has to draw the title bar itself.
   */
  window?: WindowControls;
  /** Present only where a native picker exists. */
  pickDirectory?(): Promise<string | null>;
  /**
   * Reveals the log directory in the file manager.
   *
   * Desktop only, and deliberately not a fallback: the logs are on the machine,
   * and a browser on a phone has nothing it could open. The workbench reads logs
   * over the connection instead (`log.tail`), which works from anywhere.
   */
  openLogs?(): void;
  /**
   * Announces that the endpoint has moved, and returns an unsubscribe.
   *
   * A restarted daemon listens on a new port with a new token, so retrying the
   * old address forever is the one thing a client must not do. Only shells that
   * own the daemon can know this; a browser has nothing to offer here.
   */
  onEndpointChange?(listener: () => void): () => void;
  /**
   * This shell's own version.
   *
   * Absent in a browser, which is not a build of anything: the page arrived from
   * wherever it is served, and the only version worth printing there is the one
   * the machine reported. Present on the desktop because the thing a person
   * reinstalls is the shell. When the selected daemon is local, disagreement is
   * how a half-finished bundle upgrade shows itself; with a remote daemon the
   * two belong to different machines and update independently.
   */
  appVersion?(): Promise<string | null>;
  /**
   * Checks the desktop shell itself, on the client where it is installed.
   *
   * This must not go through the selected daemon: that daemon may be a Linux
   * server on the other side of a relay, whose version and platform answer a
   * different update question.
   */
  checkAppUpdate?(): Promise<UpdateStatus>;
  /** The shell asking the workbench to show remote access, e.g. from a tray menu. */
  onPairRequested?(listener: () => void): () => void;
  /**
   * The shell asking whether a newer build exists, e.g. from a tray menu.
   *
   * The shell only asks; the daemon is what looks. So this carries nothing —
   * the answer comes back over the connection the workbench already has, which
   * is also what makes the same button work in a browser on a phone.
   */
  onUpdateRequested?(listener: () => void): () => void;
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
  /**
   * Why there is no endpoint, when the shell is the one that was supposed to
   * provide it. A desktop app with no machine to connect to is broken rather
   * than waiting for the user to choose, and the difference has to reach the
   * screen: the alternative is an app that looks idle while its daemon failed.
   */
  problem?(): Promise<string | null>;
  /** Tries again after `problem()`. Returns once it has an answer either way. */
  retry?(): Promise<void>;
}

/**
 * Tauri injects this; its absence is how we know we are in a browser.
 *
 * Only when `withGlobalTauri` is on, which is why the desktop config sets it and
 * a test there pins it: without it this object is missing, the packaged app
 * decides it is a browser, and it goes looking for an address in the URL of a
 * page that has no URL — which is a first run that says "没有可连接的机器" on a
 * machine whose daemon is running perfectly.
 */
interface TauriGlobal {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
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
        label: machine.name,
        kind: "remote" as const,
        fingerprint: machine.fingerprint,
      }));
    },
    async openTarget(id) {
      const machine = listMachines().find((entry) => entry.machineId === id);
      if (!machine)
        throw new Error("这台机器不在本地名册里，可能已经被忘掉了。");
      // The address bar follows the switch, so a reload stays on the machine
      // the user is looking at rather than jumping back to the one they
      // arrived on.
      window.location.hash = `endpoint=${encodeURIComponent(machine.endpoint)}`;
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
 * The desktop shell already has the daemon running as a sidecar, so it knows
 * the loopback port and asks the shell for a fresh one-use admission rather
 * than making the user pair with their own machine.
 */
export function desktopHost(
  socketFactory?: (url: string) => WebSocketLike,
): Host {
  const tauri = window.__TAURI__!;
  const local = async (): Promise<Endpoint | null> => {
    const found = await tauri.core.invoke<DaemonEndpoint | null>(
      "daemon_endpoint",
    );
    if (!found) return null;
    return {
      url: found.url,
      via: "loopback",
      label: "这台电脑",
      fingerprint: found.fingerprint,
      localServerProof: {
        proof: found.serverProof,
        challenge: found.challenge,
        pid: found.pid,
        machineId: found.machineId,
        fingerprint: found.fingerprint,
        expiresAt: found.expiresAt,
      },
    };
  };
  return {
    kind: "desktop",
    endpoint: local,
    async targets() {
      // This computer first, and always present even when its daemon is down —
      // dropping it would make a failed start look like the machine no longer
      // exists, and the row is where "离线" gets said.
      const here = await local().catch(() => null);
      const paired = listMachines().map((machine) => ({
        id: machine.machineId,
        label: machine.name,
        kind: "remote" as const,
        fingerprint: machine.fingerprint,
      }));
      const known = [
        here?.fingerprint,
        ...paired.map((target) => target.fingerprint),
      ];

      // Everything the Hub knows about, on top. Silently absent when it cannot
      // be asked: the local rows are the ones that still work with the network
      // down, and burying them under an error about an account server is the
      // wrong trade at the moment somebody is trying to open their own laptop.
      const account = here
        ? await hubMachines(here.url, socketFactory).catch(() => [])
        : [];
      return [
        {
          id: LOCAL_TARGET,
          label: "这台电脑",
          kind: "local" as const,
          online: here !== null,
        },
        ...paired,
        // By fingerprint, because the Hub's ids and the ids a local pairing
        // recorded are different namespaces for the same computers. The one
        // this app is running on is in the account's list too, and showing it
        // twice would offer a second row that reaches the daemon underfoot by
        // going out to a relay and back.
        ...account
          .filter((machine) => !known.includes(machine.fingerprint))
          .map((machine) => ({
            id: machine.id,
            label: machine.name,
            kind: "remote" as const,
            online: machine.online,
            fingerprint: machine.fingerprint,
          })),
      ];
    },
    async openTarget(id) {
      if (id === LOCAL_TARGET) {
        const here = await local();
        if (!here) throw new Error("这台电脑上的后台进程没有在运行。");
        return here;
      }
      const machine = listMachines().find((entry) => entry.machineId === id);
      if (machine) return reach(machine, machine.endpoint);

      // Not in the local roster, so it came from the account. The ticket is
      // minted through this machine's own daemon, which means switching keeps
      // working after the connection to the *other* machine drops — the one
      // moment a client that asked the far end would have nobody to ask.
      const here = await local();
      if (!here)
        throw new Error(
          "这台电脑上的后台进程没有在运行，没法替你去连别的机器。",
        );
      // One short-lived connection for both asks: a separate hub.machines dial
      // used to open a second handshake just to read a label, and would fail
      // the whole switch if the daemon hiccupped between the two.
      const switched = await onDaemon(
        here.url,
        async (client) => {
          const ticket = await client.call({
            type: "hub.connect",
            payload: { machineId: id },
          });
          if (ticket?.type !== "hubTicket") return null;
          const machines = await client
            .call({ type: "hub.machines" })
            .catch(() => null);
          const account = machines?.type === "hubMachines" ? machines.data : [];
          return {
            url: ticket.data.url,
            via: "relay" as const,
            label: account.find((entry) => entry.id === id)?.name ?? "远程机器",
            fingerprint: ticket.data.fingerprint,
            channelCredential: {
              capabilityId: ticket.data.channelCapability,
              secret: ticket.data.channelSecret,
            },
          };
        },
        socketFactory,
      );
      if (!switched) throw new Error("这台机器不在你的账号下。");
      return switched;
    },
    notify(notification) {
      void tauri.core.invoke("notify", { ...notification });
    },
    openExternal(url) {
      void tauri.core.invoke("open_external", { url });
    },
    installUpdate(path) {
      return tauri.core.invoke("install_update", { path });
    },
    openWindow(url) {
      void tauri.core.invoke("open_window", { url });
    },
    window: {
      minimize() {
        void tauri.core.invoke("window_minimize");
      },
      toggleMaximize() {
        return tauri.core.invoke<boolean>("window_toggle_maximize");
      },
      isMaximized() {
        return tauri.core.invoke<boolean>("window_is_maximized");
      },
      close() {
        void tauri.core.invoke("window_close");
      },
      setBackground(dark) {
        void tauri.core.invoke("set_window_background", { dark });
      },
    },
    async pickDirectory() {
      return tauri.core.invoke<string | null>("pick_directory");
    },
    openLogs() {
      void tauri.core.invoke("open_logs");
    },
    async appVersion() {
      return tauri.core.invoke<string>("app_version");
    },
    async checkAppUpdate() {
      return tauri.core.invoke<UpdateStatus>("app_update_status", {
        manifestUrl: MANIFEST_URL,
      });
    },
    onEndpointChange(listener) {
      return subscribe(tauri, "genehub://daemon", listener);
    },
    onPairRequested(listener) {
      return subscribe(tauri, "genehub://pair", listener);
    },
    onUpdateRequested(listener) {
      return subscribe(tauri, "genehub://update", listener);
    },
    onClaimRequested(listener) {
      return subscribe(tauri, "genehub://claim", listener);
    },
    async problem() {
      return tauri.core.invoke<string | null>("daemon_problem");
    },
    async retry() {
      // The error is read back through `problem()` rather than thrown: this is
      // called from a button whose job is to leave the screen truthful, not to
      // produce a value.
      await tauri.core.invoke("restart_daemon").catch(() => undefined);
    },
  };
}

/**
 * The account's machines, asked of this machine's own daemon.
 *
 * The daemon is the only thing here that can ask: it holds the uplink
 * credential, and this app deliberately holds no account credential of its own
 * — it is the open-source workbench, and account code is not shipped inside it
 * (`genethub-cloud/desktop/README.md`). An empty list is the honest answer for
 * a machine that was never paired with a Hub.
 */
async function hubMachines(
  url: string,
  socketFactory?: (url: string) => WebSocketLike,
): Promise<HubMachine[]> {
  const reply = await onDaemon(
    url,
    (client) => client.call({ type: "hub.machines" }),
    socketFactory,
  );
  return reply?.type === "hubMachines" ? reply.data : [];
}

/**
 * Runs one exchange on a connection of its own, and hangs up.
 *
 * Not the workbench's connection, because that one has moved: after switching
 * to another machine it points there, and these questions are for the daemon on
 * this computer. A socket that lives for one request costs a handshake on a
 * loopback port and saves keeping a second live client in sync with the first.
 */
async function onDaemon<T>(
  url: string,
  exchange: (client: Client) => Promise<T>,
  socketFactory?: (url: string) => WebSocketLike,
): Promise<T> {
  const client = new Client({
    url,
    clientName: "genehub-app",
    ...(socketFactory ? { socketFactory } : {}),
  });
  // Wait until ready (or give up) rather than failing on the first
  // `reconnecting` flicker: a daemon that is mid-restart would otherwise make
  // every machine switch and every Hub directory read look permanently dead.
  const ready = new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error("这台电脑上的后台进程没有回应。"));
    }, 3_000);
    stop = client.onStateChange((state) => {
      if (state === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
        return;
      }
      if (state === "closed") {
        clearTimeout(timer);
        stop();
        reject(new Error("这台电脑上的后台进程没有在运行。"));
      }
    });
  });
  client.connect();
  try {
    await ready;
    return await exchange(client);
  } finally {
    client.close();
  }
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
    via: url.includes("/forward/client") ? "relay" : "lan",
    label: paired?.name ?? new URL(url).host,
    fingerprint: paired?.fingerprint,
    credential: paired
      ? { deviceId: paired.deviceId, secret: paired.secret }
      : undefined,
  };
}

/** Tauri hands back the unsubscribe asynchronously; React wants it now. */
function subscribe(
  tauri: TauriGlobal,
  name: string,
  listener: () => void,
): () => void {
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

/** The shell mints this from its private endpoint on every reconnect. */
interface DaemonEndpoint {
  port: number;
  url: string;
  machineId: string;
  fingerprint: string;
  pid: number;
  challenge: string;
  expiresAt: number;
  serverProof: string;
}
