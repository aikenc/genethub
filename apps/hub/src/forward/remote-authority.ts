import type {
  ChannelAuthority,
  ClientGrant,
  DaemonGrant,
  PresenceState,
  Revocation,
} from "../contract/index.js";
import { log } from "../shared/log.js";

/**
 * The contract spoken over HTTP, for when the two roles run as separate
 * services.
 *
 * This exists in the single-process era on purpose. An interface that has only
 * ever been called in-process quietly accumulates assumptions — a shared
 * transaction here, a synchronous read there — and the day someone tries to
 * split it, none of them hold. Having a second implementation means the
 * assumptions cannot form.
 */
export class RemoteAuthority implements ChannelAuthority {
  private readonly handlers: Array<(revocation: Revocation) => void> = [];

  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    return this.post<DaemonGrant>("/internal/authorize-daemon", { ticket });
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    return this.post<ClientGrant>("/internal/authorize-client", { ticket });
  }

  async reportPresence(machineId: string, state: PresenceState): Promise<void> {
    await this.post("/internal/presence", { machineId, state });
  }

  onRevoked(handler: (revocation: Revocation) => void): void {
    this.handlers.push(handler);
  }

  /** Feeds a revocation in, whatever the transport turns out to be. */
  deliverRevocation(revocation: Revocation): void {
    for (const handler of this.handlers) handler(revocation);
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      log.warn("forward: control plane unreachable", { path, error: String(error) });
      return null;
    });

    if (!response) return null;
    if (response.status === 204) return null;
    if (!response.ok) return null;
    return (await response.json()) as T;
  }
}
