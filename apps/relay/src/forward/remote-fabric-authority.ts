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
import { config } from "../shared/config.js";
import { log } from "../shared/log.js";
import { boundedJson } from "../shared/bounded-json.js";
import { AuthorityHttpError } from "../shared/authority-error.js";

export interface RemoteFabricAuthorityOptions {
  /** Total deadline for one Control HTTP request, including its response body. */
  requestTimeoutMs?: number;
  /** Deadline from SSE response headers to the first valid sync event. */
  firstEventTimeoutMs?: number;
  /** Maximum silence between reads after the initial sync. */
  idleTimeoutMs?: number;
  /** Maximum undecoded SSE event bytes retained between delimiters. */
  maxRevocationBufferBytes?: number;
  /** Maximum bytes in one non-streaming Control JSON response. */
  maxAuthorityResponseBytes?: number;
}

interface ResolvedRemoteFabricAuthorityOptions {
  requestTimeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
  maxRevocationBufferBytes: number;
  maxAuthorityResponseBytes: number;
}

/**
 * The endpoint-neutral Fabric authority, spoken over HTTP to the control plane.
 *
 * This adapter is the only place where Fabric forwarding code interprets JSON.
 * It never sees an application frame: every identifier returned here is opaque
 * to the relay data plane.
 */
export class RemoteFabricAuthority implements FabricAuthority {
  private readonly handlers: Array<(revocation: FabricRevocation) => void> = [];
  private readonly options: ResolvedRemoteFabricAuthorityOptions;

  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    options: RemoteFabricAuthorityOptions = {},
  ) {
    this.options = {
      requestTimeoutMs: positiveTimeout(
        options.requestTimeoutMs,
        config.limits.authorityRequestMs,
        "requestTimeoutMs",
      ),
      firstEventTimeoutMs: positiveTimeout(
        options.firstEventTimeoutMs,
        config.limits.revocationFirstEventMs,
        "firstEventTimeoutMs",
      ),
      idleTimeoutMs: positiveTimeout(
        options.idleTimeoutMs,
        config.limits.revocationIdleMs,
        "idleTimeoutMs",
      ),
      maxRevocationBufferBytes: positiveTimeout(
        options.maxRevocationBufferBytes,
        config.limits.maxRevocationBufferBytes,
        "maxRevocationBufferBytes",
      ),
      maxAuthorityResponseBytes: positiveTimeout(
        options.maxAuthorityResponseBytes,
        config.limits.maxAuthorityResponseBytes,
        "maxAuthorityResponseBytes",
      ),
    };
  }

  async authorizeEndpoint(credential: string): Promise<FabricEndpointGrant | null> {
    const value = await this.post(FABRIC_AUTHORIZE_ENDPOINT, {
      credential,
    });
    if (value === null) return null;
    const grant = endpointGrant(value);
    if (!grant) throw new Error("Fabric authority returned an invalid endpoint grant");
    return grant;
  }

  async authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null> {
    const value = await this.post(FABRIC_AUTHORIZE_ROUTE, {
      sourceEndpointHandle,
      ticket: routeTicket,
    });
    if (value === null) return null;
    const grant = routeGrant(value);
    if (!grant) throw new Error("Fabric authority returned an invalid route grant");
    return grant;
  }

  async reportEndpointPresence(
    endpointHandle: string,
    connectionGeneration: number,
    state: FabricPresenceState,
  ): Promise<void> {
    await this.post(FABRIC_PRESENCE, { endpointHandle, connectionGeneration, state });
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
  watchRevocations(
    options: {
      retryMs?: number;
      onReconnect?: () => void;
      onDisconnect?: () => void;
    } = {},
  ): () => void {
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
        // Existing operation bindings cannot outlive our ability to hear
        // revocations. Failing closed here removes the old lookback window as
        // a security boundary; endpoints obtain fresh one-shot admission when
        // the authority stream is healthy again.
        options.onDisconnect?.();
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
    const scope = linkedAbortController(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await withDeadline(
        Promise.resolve(
          this.fetchImpl(new URL(FABRIC_REVOCATIONS, this.origin), {
            headers: {
              accept: "text/event-stream",
              ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            signal: scope.controller.signal,
          }),
        ),
        scope.controller,
        this.options.requestTimeoutMs,
        "Fabric revocation request",
      );
      if (!response.ok || !response.body) {
        throw new Error(`Fabric revocation stream refused with ${response.status}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const firstEventDeadline = Date.now() + this.options.firstEventTimeoutMs;
      let buffer = "";
      let synced = false;

      for (;;) {
        const readTimeoutMs = synced
          ? this.options.idleTimeoutMs
          : firstEventDeadline - Date.now();
        const { done, value } = await withDeadline(
          reader.read(),
          scope.controller,
          readTimeoutMs,
          synced ? "Fabric revocation stream idle" : "Fabric revocation initial sync",
        );
        if (done) {
          throw new Error(
            synced
              ? "Fabric revocation stream ended"
              : "Fabric revocation stream ended before its initial sync",
          );
        }
        const bufferedBytes = Buffer.byteLength(buffer, "utf8");
        if (
          value.byteLength >
          Math.max(0, this.options.maxRevocationBufferBytes - bufferedBytes - 4)
        ) {
          throw new Error("Fabric revocation stream exceeded its buffer limit");
        }
        buffer += decoder.decode(value, { stream: true });
        // Normalize the accumulated buffer, not only the latest chunk: a CRLF
        // delimiter is allowed to straddle two network reads.
        buffer = buffer.replace(/\r\n/g, "\n");
        if (Buffer.byteLength(buffer, "utf8") > this.options.maxRevocationBufferBytes) {
          throw new Error("Fabric revocation stream exceeded its buffer limit");
        }

        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (!synced) {
            if (this.dispatchInitialSync(chunk)) {
              synced = true;
              // Only re-report surviving endpoints after revocations missed during
              // the outage have been installed in the core.
              onReconnect?.();
            }
          } else {
            this.dispatch(chunk);
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      // Aborting is what releases a real fetch body when a parser or liveness
      // check fails. The deadline race also protects us from test doubles or
      // runtimes which do not promptly reject their promise on abort.
      scope.controller.abort();
      scope.detach();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  /** One post-sync SSE event. Invalid data is fatal because it may be a lost revoke. */
  private dispatch(chunk: string): void {
    const parsed = parseSseData(chunk);
    if (parsed.kind === "heartbeat") return;
    if (parsed.kind === "invalid") {
      throw new Error("Fabric revocation stream sent malformed event data");
    }

    const sync = parsed.value as Partial<FabricRevocationSync>;
    if (Array.isArray(sync.revocations)) {
      const revocations = sync.revocations.map(revocationOf);
      if (revocations.some((event) => event === null)) {
        throw new Error("Fabric revocation stream sent an invalid sync event");
      }
      for (const event of revocations) this.deliverRevocation(event!);
      return;
    }
    const event = revocationOf(parsed.value);
    if (!event) throw new Error("Fabric revocation stream sent an invalid revocation");
    this.deliverRevocation(event);
  }

  private dispatchInitialSync(chunk: string): boolean {
    const parsed = parseSseData(chunk);
    if (parsed.kind === "heartbeat") return false;
    if (parsed.kind === "invalid" || !parsed.value || typeof parsed.value !== "object") {
      throw new Error("Fabric revocation stream did not start with a valid sync");
    }
    if (parsed.event === "sync-complete") return true;
    const sync = parsed.value as Partial<FabricRevocationSync>;
    if (!Array.isArray(sync.revocations)) {
      throw new Error("Fabric revocation stream did not start with a valid sync");
    }
    const revocations = sync.revocations.map(revocationOf);
    if (revocations.some((event) => event === null)) {
      throw new Error("Fabric revocation stream sent an invalid initial sync");
    }
    for (const event of revocations) this.deliverRevocation(event!);
    if (parsed.event === "sync-page") return false;
    if (parsed.event === "sync" || parsed.event === undefined) return true;
    throw new Error("Fabric revocation stream sent an unknown sync event");
  }

  private async post(path: string, body: unknown): Promise<unknown | null> {
    const controller = new AbortController();
    const deadline = Date.now() + this.options.requestTimeoutMs;
    try {
      const response = await withDeadline(
        Promise.resolve(
          this.fetchImpl(new URL(path, this.origin), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
        ),
        controller,
        remainingMs(deadline),
        `Fabric authority request ${path}`,
      );

      if (response.status === 204) return null;
      if (!response.ok) {
        throw new AuthorityHttpError(
          `Fabric authority ${path} returned ${response.status}`,
          response.status,
        );
      }
      return await withDeadline(
        boundedJson(response, this.options.maxAuthorityResponseBytes, controller.signal),
        controller,
        remainingMs(deadline),
        `Fabric authority response ${path}`,
      );
    } catch (error) {
      log.warn("fabric: control plane unreachable", { path, error: String(error) });
      throw error;
    } finally {
      controller.abort();
    }
  }
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function remainingMs(deadline: number): number {
  return deadline - Date.now();
}

function linkedAbortController(parent: AbortSignal): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    detach: () => parent.removeEventListener("abort", abort),
  };
}

function withDeadline<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (controller.signal.aborted) {
    return Promise.reject(abortReason(controller.signal, label));
  }
  if (timeoutMs <= 0) {
    const error = new Error(`${label} timed out`);
    controller.abort(error);
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = () => finish(() => reject(abortReason(controller.signal, label)));
    const timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    controller.signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
}

function opaqueHandle(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

type ParsedSseData =
  | { kind: "heartbeat" }
  | { kind: "invalid" }
  | { kind: "data"; event: string | undefined; value: unknown };

function parseSseData(chunk: string): ParsedSseData {
  const lines = chunk.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return { kind: "heartbeat" };
  const data = dataLines.join("\n");
  if (!data && event === "ping") return { kind: "heartbeat" };
  if (!data) return { kind: "invalid" };
  try {
    return { kind: "data", event, value: JSON.parse(data) as unknown };
  } catch {
    return { kind: "invalid" };
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
  if (
    typeof grant.connectionGeneration !== "number" ||
    !Number.isSafeInteger(grant.connectionGeneration) ||
    grant.connectionGeneration < 1 ||
    typeof grant.presenceLeaseSeconds !== "number" ||
    !Number.isSafeInteger(grant.presenceLeaseSeconds) ||
    grant.presenceLeaseSeconds < 60 ||
    grant.presenceLeaseSeconds > 3600
  ) {
    return null;
  }
  return {
    endpointHandle: grant.endpointHandle,
    revocationHandle: grant.revocationHandle,
    expiresAt: grant.expiresAt,
    connectionGeneration: grant.connectionGeneration,
    presenceLeaseSeconds: grant.presenceLeaseSeconds,
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
