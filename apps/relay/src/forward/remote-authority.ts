import type {
  ChannelAuthority,
  ClientGrant,
  DaemonGrant,
  PresenceState,
  Revocation,
} from "../contract/index.js";
import {
  AUTHORIZE_CLIENT,
  AUTHORIZE_DAEMON,
  INSPECT_CLIENT,
  PRESENCE,
  REVOCATIONS,
  type AuthorizeClientResponse,
  type AuthorizeDaemonResponse,
  type RevocationEvent,
  type RevocationSync,
} from "../contract/wire.js";
import { log } from "../shared/log.js";

/**
 * The contract, spoken over HTTP to a control plane that lives somewhere else.
 *
 * This is the only implementation the relay ships. There is no in-process
 * shortcut to fall back to, which is what makes "run your own relay against the
 * hosted control plane" an ordinary configuration rather than a special build.
 */
export class RemoteAuthority implements ChannelAuthority {
  private readonly handlers: Array<(revocation: Revocation) => void> = [];

  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    return this.post<AuthorizeDaemonResponse>(AUTHORIZE_DAEMON, { ticket });
  }

  async inspectClient(ticket: string): Promise<ClientGrant | null> {
    return this.post<AuthorizeClientResponse>(INSPECT_CLIENT, { ticket });
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    return this.post<AuthorizeClientResponse>(AUTHORIZE_CLIENT, { ticket });
  }

  async reportPresence(machineId: string, state: PresenceState): Promise<void> {
    await this.post(PRESENCE, { machineId, state });
  }

  onRevoked(handler: (revocation: Revocation) => void): void {
    this.handlers.push(handler);
  }

  /** Feeds a revocation in, whatever the transport turns out to be. */
  deliverRevocation(revocation: Revocation): void {
    for (const handler of this.handlers) handler(revocation);
  }

  /**
   * Subscribes to revocations and keeps the subscription up.
   *
   * The relay dials the control plane rather than the other way round, so a
   * relay behind NAT works the same as one in a datacentre — which is what
   * makes "run your own" a real option rather than a paragraph in a README.
   *
   * `onReconnect` fires each time the stream (re-)establishes, first connect
   * included: that is the one moment the relay knows the control plane is
   * (back) up, and therefore the moment to re-sync anything presence-like
   * that was reported only on change.
   */
  watchRevocations(options: { retryMs?: number; onReconnect?: () => void } = {}): () => void {
    const retryMs = options.retryMs ?? 3000;
    let stopped = false;
    let controller: AbortController | null = null;

    const run = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          await this.streamRevocations(controller.signal, options.onReconnect);
        } catch (error) {
          if (!stopped) {
            log.warn("forward: the revocation stream dropped", { error: String(error) });
          }
        }
        if (stopped) return;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    };
    void run();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  private async streamRevocations(
    signal: AbortSignal,
    onReconnect?: () => void,
  ): Promise<void> {
    const response = await this.fetchImpl(new URL(REVOCATIONS, this.origin), {
      headers: {
        accept: "text/event-stream",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`revocation stream refused with ${response.status}`);
    }
    onReconnect?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        this.dispatch(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
  }

  /** One SSE event. Anything unparseable is skipped, never fatal. */
  private dispatch(chunk: string): void {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    // A sync arrives first on every (re)connect, catching up on anything
    // revoked while the stream was down.
    const sync = parsed as Partial<RevocationSync>;
    if (Array.isArray(sync.machineIds)) {
      for (const machineId of sync.machineIds) {
        this.deliverRevocation({ machineId, reason: "revoked while the relay was disconnected" });
      }
      return;
    }

    const event = parsed as Partial<RevocationEvent>;
    if (typeof event.machineId === "string") {
      this.deliverRevocation({
        machineId: event.machineId,
        reason: event.reason ?? "revoked by the owner",
      });
    }
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
