/**
 * The machines this browser has paired with.
 *
 * Deliberately local. There is no server keeping a directory in the
 * self-hosted shape of this product, and inventing one here would put back the
 * thing the design removed. The cost is honest and small: a different browser
 * starts empty and pairs again, which takes about ten seconds.
 *
 * The credential is a secret, so it is never exported and never leaves this
 * origin. Anything that offers to "back up your machines" is offering to copy
 * keys around in plain text.
 */

const KEY = "genehub.machines";

export interface PairedMachine {
  machineId: string;
  name: string;
  fingerprint: string;
  /** WebSocket URL, usually a rendezvous slot on a relay. */
  endpoint: string;
  deviceId: string;
  secret: string;
  pairedAt: string;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Blocked by browser settings. Pairing still works for this tab; it just
    // will not be remembered, which is better than refusing to run.
    return null;
  }
}

export function listMachines(storage: Storage | null = store()): PairedMachine[] {
  const raw = storage?.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PairedMachine[]) : [];
  } catch {
    return [];
  }
}

/** Adds or replaces, keyed by machine: pairing again is a repair, not a duplicate. */
export function rememberMachine(
  machine: PairedMachine,
  storage: Storage | null = store(),
): PairedMachine[] {
  const next = [...listMachines(storage).filter((m) => m.machineId !== machine.machineId), machine];
  storage?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function forgetMachine(
  machineId: string,
  storage: Storage | null = store(),
): PairedMachine[] {
  const next = listMachines(storage).filter((machine) => machine.machineId !== machineId);
  storage?.setItem(KEY, JSON.stringify(next));
  return next;
}

export function findMachine(
  endpoint: string,
  storage: Storage | null = store(),
): PairedMachine | null {
  return listMachines(storage).find((machine) => machine.endpoint === endpoint) ?? null;
}

/**
 * The link a machine shows for a new device to open.
 *
 * The pairing code rides in the fragment, not the query string: fragments are
 * not sent to servers, so hosting the workbench somewhere does not put codes
 * in an access log.
 */
export function pairingLink(origin: string, code: string, rendezvousUrl: string): string {
  const fragment = new URLSearchParams({ claim: code, endpoint: rendezvousUrl });
  return `${origin.replace(/\/$/, "")}/#${fragment.toString()}`;
}

/** Reads back what `pairingLink` wrote. */
export function readPairingLink(hash: string): { code: string; endpoint: string } | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const code = fragment.get("claim");
  const endpoint = fragment.get("endpoint");
  return code && endpoint ? { code, endpoint } : null;
}
