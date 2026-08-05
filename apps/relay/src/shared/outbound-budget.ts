import type { WebSocket } from "ws";

interface SocketAccount {
  bytes: number;
  readonly releases: Set<() => void>;
}

/**
 * One process-wide bound for payloads handed to `ws.send` but not yet
 * acknowledged by its callback. The same instance must be shared by every
 * forwarding surface in a Relay process.
 *
 * A socket also has its own tracked allowance. `bufferedAmount` remains part
 * of that check so bytes queued by the WebSocket implementation cannot hide
 * behind an early or unusual callback implementation.
 */
export class OutboundByteBudget {
  private usedBytes = 0;
  private readonly sockets = new WeakMap<WebSocket, SocketAccount>();

  constructor(
    private readonly globalLimit: number,
    private readonly perSocketLimit: number,
    private readonly minimumChargeBytes = 1024,
  ) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1) {
      throw new Error("global outbound byte limit must be a positive integer");
    }
    if (!Number.isSafeInteger(perSocketLimit) || perSocketLimit < 1) {
      throw new Error("per-socket outbound byte limit must be a positive integer");
    }
    if (globalLimit < perSocketLimit) {
      throw new Error("global outbound byte limit must be at least the per-socket limit");
    }
    if (!Number.isSafeInteger(minimumChargeBytes) || minimumChargeBytes < 1) {
      throw new Error("minimum outbound charge must be a positive integer");
    }
  }

  get bytes(): number {
    return this.usedBytes;
  }

  /** Returns an idempotent release, or null without changing either budget. */
  reserve(socket: WebSocket, bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    // Tiny/empty messages still allocate callback and queue metadata. Charging
    // a conservative floor prevents a zero-byte frame storm bypassing a byte
    // budget and creating millions of live closures.
    const charge = Math.max(bytes, this.minimumChargeBytes);
    let account = this.sockets.get(socket);
    if (!account) {
      account = { bytes: 0, releases: new Set() };
      this.sockets.set(socket, account);
      const releaseAll = () => {
        for (const release of [...account!.releases]) release();
      };
      socket.once("close", releaseAll);
      socket.once("error", releaseAll);
    }

    const socketQueued = Math.max(account.bytes, socket.bufferedAmount);
    if (charge > this.perSocketLimit - socketQueued) return null;
    if (charge > this.globalLimit - this.usedBytes) return null;

    account.bytes += charge;
    this.usedBytes += charge;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      account!.releases.delete(release);
      account!.bytes -= charge;
      this.usedBytes -= charge;
    };
    account.releases.add(release);
    return release;
  }
}
