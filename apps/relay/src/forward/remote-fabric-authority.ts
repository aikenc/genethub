import type {
  FabricAuthority,
  FabricEndpointGrant,
  FabricPresenceState,
  FabricRevocation,
  FabricRouteGrant,
} from "../contract/fabric.js";
import {
  FABRIC_AUTHORIZE_ENDPOINT,
  FABRIC_AUTHORIZE_ROUTE,
  FABRIC_PRESENCE,
  FABRIC_REVOCATIONS,
  type FabricAuthorizeEndpointResponse,
  type FabricAuthorizeRouteResponse,
  type FabricRevocationEvent,
  type FabricRevocationSync,
} from "../contract/fabric-wire.js";
import { log } from "../shared/log.js";

/**
 * The endpoint-neutral Fabric authority, spoken over HTTP to the control plane.
 *
 * This adapter is the only place where Fabric forwarding code interprets JSON.
 * It never sees an application frame: every identifier returned here is opaque
 * to the relay data plane.
 */
export class RemoteFabricAuthority implements FabricAuthority {
  private readonly handlers: Array<(revocation: FabricRevocation) => void> = [];

  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async authorizeEndpoint(credential: string): Promise<FabricEndpointGrant | null> {
    const value = await this.post(FABRIC_AUTHORIZE_ENDPOINT, {
      credential,
    });
    return endpointGrant(value);
  }

  async authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null> {
    const value = await this.post(FABRIC_AUTHORIZE_ROUTE, {
      sourceEndpointHandle,
      ticket: routeTicket,
    });
    return routeGrant(value);
  }

  async reportEndpointPresence(
    endpointHandle: string,
    state: FabricPresenceState,
  ): Promise<void> {
    await this.post(FABRIC_PRESENCE, { endpointHandle, state });
  }

  onFabricRevoked(handler: (revocation: FabricRevocation) => void): void {
    this.handlers.push(handler);
  }

  /** Feeds one validated opaque revocation to the forwarding core. */
  deliverRevocation(revocation: FabricRevocation): void {
    for (const handler of this.handlers) handler(revocation);
  }

  /**
   * Maintains the outbound SSE subscription used for endpoint and route
   * revocation. The relay dials the control plane, preserving the same NAT and
   * self-hosting boundary as the v1 authority adapter.
   */
  watchRevocations(options: { retryMs?: number; onReconnect?: () => void } = {}): () => void {
    const retryMs = options.retryMs ?? 3000;
    let stopped = false;
    let controller: AbortController | null = null;
    let cancelRetry: (() => void) | null = null;

    const run = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          await this.streamRevocations(controller.signal, options.onReconnect);
        } catch (error) {
          if (!stopped) {
            log.warn("fabric: the revocation stream dropped", { error: String(error) });
          }
        }
        if (stopped) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          timer.unref?.();
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = null;
      }
    };
    void run();

    return () => {
      stopped = true;
      controller?.abort();
      cancelRetry?.();
    };
  }

  private async streamRevocations(
    signal: AbortSignal,
    onReconnect?: () => void,
  ): Promise<void> {
    const response = await this.fetchImpl(new URL(FABRIC_REVOCATIONS, this.origin), {
      headers: {
        accept: "text/event-stream",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Fabric revocation stream refused with ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let synced = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Normalize the accumulated buffer, not only the latest chunk: a CRLF
      // delimiter is allowed to straddle two network reads.
      buffer = buffer.replace(/\r\n/g, "\n");

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!synced) {
          if (!this.dispatchInitialSync(chunk)) {
            throw new Error("Fabric revocation stream did not start with a valid sync");
          }
          synced = true;
          // Only re-report surviving endpoints after revocations missed during
          // the outage have been installed in the core.
          onReconnect?.();
        } else {
          this.dispatch(chunk);
        }
        split = buffer.indexOf("\n\n");
      }
    }
  }

  /** One SSE event. Malformed or unknown events are ignored, never fatal. */
  private dispatch(chunk: string): void {
    const parsed = parseSseData(chunk);
    if (parsed === null) return;

    const sync = parsed as Partial<FabricRevocationSync>;
    if (Array.isArray(sync.revocations)) {
      for (const event of sync.revocations) this.deliverIfValid(event);
      return;
    }
    this.deliverIfValid(parsed);
  }

  private dispatchInitialSync(chunk: string): boolean {
    const parsed = parseSseData(chunk);
    if (!parsed || typeof parsed !== "object") return false;
    const sync = parsed as Partial<FabricRevocationSync>;
    if (!Array.isArray(sync.revocations)) return false;
    const revocations = sync.revocations.map(revocationOf);
    if (revocations.some((event) => event === null)) return false;
    for (const event of revocations) this.deliverRevocation(event!);
    return true;
  }

  private deliverIfValid(value: unknown): void {
    const event = revocationOf(value);
    if (event) this.deliverRevocation(event);
  }

  private async post(path: string, body: unknown): Promise<unknown | null> {
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      log.warn("fabric: control plane unreachable", { path, error: String(error) });
      return null;
    });

    if (!response) return null;
    if (response.status === 204) return null;
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }
}

function opaqueHandle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function parseSseData(chunk: string): unknown | null {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function revocationOf(value: unknown): FabricRevocationEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Partial<FabricRevocationEvent>;
  if (
    (event.target !== "endpoint" && event.target !== "route") ||
    !opaqueHandle(event.handle)
  ) {
    return null;
  }
  return { target: event.target, handle: event.handle };
}

function endpointGrant(value: unknown): FabricAuthorizeEndpointResponse | null {
  if (!value || typeof value !== "object") return null;
  const grant = value as Partial<FabricAuthorizeEndpointResponse>;
  if (!opaqueHandle(grant.endpointHandle) || !opaqueHandle(grant.revocationHandle)) return null;
  if (grant.expiresAt !== null && typeof grant.expiresAt !== "string") return null;
  return {
    endpointHandle: grant.endpointHandle,
    revocationHandle: grant.revocationHandle,
    expiresAt: grant.expiresAt,
  };
}

function routeGrant(value: unknown): FabricAuthorizeRouteResponse | null {
  if (!value || typeof value !== "object") return null;
  const grant = value as Partial<FabricAuthorizeRouteResponse>;
  if (
    !opaqueHandle(grant.targetEndpointHandle) ||
    !opaqueHandle(grant.routeHandle) ||
    typeof grant.expiresAt !== "string"
  ) {
    return null;
  }
  return {
    targetEndpointHandle: grant.targetEndpointHandle,
    routeHandle: grant.routeHandle,
    expiresAt: grant.expiresAt,
  };
}
