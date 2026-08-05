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
  type RevocationSync,
} from "../contract/wire.js";
import { config } from "../shared/config.js";
import { log } from "../shared/log.js";
import { boundedJson } from "../shared/bounded-json.js";
import { AuthorityHttpError } from "../shared/authority-error.js";

export interface RemoteAuthorityOptions {
  requestTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Maximum undecoded SSE event bytes retained between delimiters. */
  maxRevocationBufferBytes?: number;
  /** Maximum bytes in one non-streaming Control JSON response. */
  maxAuthorityResponseBytes?: number;
}

interface ResolvedRemoteAuthorityOptions {
  requestTimeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
  maxRevocationBufferBytes: number;
  maxAuthorityResponseBytes: number;
}

/**
 * The contract, spoken over HTTP to a control plane that lives somewhere else.
 *
 * This is the only implementation the relay ships. There is no in-process
 * shortcut to fall back to, which is what makes "run your own relay against the
 * hosted control plane" an ordinary configuration rather than a special build.
 */
export class RemoteAuthority implements ChannelAuthority {
  private readonly handlers: Array<(revocation: Revocation) => void> = [];
  private readonly options: ResolvedRemoteAuthorityOptions;

  constructor(
    private readonly origin: string,
    private readonly token: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    options: RemoteAuthorityOptions = {},
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

  async authorizeDaemon(ticket: string): Promise<DaemonGrant | null> {
    const value = await this.post(AUTHORIZE_DAEMON, { ticket });
    if (value === null) return null;
    const grant = daemonGrant(value);
    if (!grant) throw new Error("legacy authority returned an invalid daemon grant");
    return grant;
  }

  async inspectClient(ticket: string): Promise<ClientGrant | null> {
    const value = await this.post(INSPECT_CLIENT, { ticket });
    if (value === null) return null;
    const grant = clientGrant(value);
    if (!grant) throw new Error("legacy authority returned an invalid client grant");
    return grant;
  }

  async authorizeClient(ticket: string): Promise<ClientGrant | null> {
    const value = await this.post(AUTHORIZE_CLIENT, { ticket });
    if (value === null) return null;
    const grant = clientGrant(value);
    if (!grant) throw new Error("legacy authority returned an invalid client grant");
    return grant;
  }

  async reportPresence(
    machineId: string,
    connectionGeneration: number,
    state: PresenceState,
  ): Promise<void> {
    await this.post(PRESENCE, { machineId, connectionGeneration, state });
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
   * `onReconnect` fires only after the mandatory initial sync has been parsed.
   * `onDisconnect` is the fail-closed edge: callers must stop admissions and
   * discard sockets whose revocations can no longer be observed.
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
            log.warn("forward: the revocation stream dropped", { error: String(error) });
          }
        }
        if (stopped) return;
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
          this.fetchImpl(new URL(REVOCATIONS, this.origin), {
            headers: {
              accept: "text/event-stream",
              ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            signal: scope.controller.signal,
          }),
        ),
        scope.controller,
        this.options.requestTimeoutMs,
        "legacy revocation request",
      );
      if (!response.ok || !response.body) {
        throw new Error(`revocation stream refused with ${response.status}`);
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
          synced ? "legacy revocation stream idle" : "legacy revocation initial sync",
        );
        if (done) {
          throw new Error(
            synced
              ? "legacy revocation stream ended"
              : "legacy revocation stream ended before its initial sync",
          );
        }
        const bufferedBytes = Buffer.byteLength(buffer, "utf8");
        if (
          value.byteLength >
          Math.max(0, this.options.maxRevocationBufferBytes - bufferedBytes - 4)
        ) {
          throw new Error("legacy revocation stream exceeded its buffer limit");
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        if (Buffer.byteLength(buffer, "utf8") > this.options.maxRevocationBufferBytes) {
          throw new Error("legacy revocation stream exceeded its buffer limit");
        }

        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (!synced) {
            if (this.dispatchInitialSync(chunk)) {
              synced = true;
              onReconnect?.();
            }
          } else {
            this.dispatch(chunk);
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      scope.controller.abort();
      scope.detach();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  /** One post-sync event. Invalid data is fatal because it may hide a revoke. */
  private dispatch(chunk: string): void {
    const parsed = parseSseData(chunk);
    if (parsed.kind === "heartbeat") return;
    if (parsed.kind === "invalid") {
      throw new Error("legacy revocation stream sent malformed event data");
    }
    if (isRevocationSync(parsed.value)) {
      this.deliverSync(parsed.value);
      return;
    }
    const revocation = revocationOf(parsed.value);
    if (!revocation) throw new Error("legacy revocation stream sent an invalid revocation");
    this.deliverRevocation(revocation);
  }

  private dispatchInitialSync(chunk: string): boolean {
    const parsed = parseSseData(chunk);
    if (parsed.kind === "heartbeat") return false;
    if (parsed.kind === "invalid") {
      throw new Error("legacy revocation stream did not start with a valid sync");
    }
    if (parsed.event === "sync-complete") {
      if (!parsed.value || typeof parsed.value !== "object") {
        throw new Error("legacy revocation stream sent an invalid sync completion");
      }
      return true;
    }
    if (!isRevocationSync(parsed.value)) {
      throw new Error("legacy revocation stream did not start with a valid sync");
    }
    this.deliverSync(parsed.value);
    if (parsed.event === "sync-page") return false;
    // Backward-compatible old Control: one `sync` event was the whole catch-up.
    if (parsed.event === "sync" || parsed.event === undefined) return true;
    throw new Error("legacy revocation stream sent an unknown sync event");
  }

  private deliverSync(sync: RevocationSync): void {
    for (const machineId of sync.machineIds) {
      this.deliverRevocation({
        target: "machine",
        machineId,
        reason: "revoked while the relay was disconnected",
      });
    }
    for (const clientId of sync.clientIds ?? []) {
      this.deliverRevocation({
        target: "client",
        clientId,
        reason: "session revoked while the relay was disconnected",
      });
    }
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
        `legacy authority request ${path}`,
      );

      if (response.status === 204) return null;
      if (!response.ok) {
        throw new AuthorityHttpError(
          `legacy authority ${path} returned ${response.status}`,
          response.status,
        );
      }
      return await withDeadline(
        boundedJson(
          response,
          this.options.maxAuthorityResponseBytes,
          controller.signal,
        ),
        controller,
        remainingMs(deadline),
        `legacy authority response ${path}`,
      );
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

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function daemonGrant(value: unknown): AuthorizeDaemonResponse | null {
  if (!value || typeof value !== "object") return null;
  const grant = value as Partial<AuthorizeDaemonResponse>;
  if (
    !identifier(grant.machineId) ||
    !identifier(grant.daemonId) ||
    typeof grant.connectionGeneration !== "number" ||
    !Number.isSafeInteger(grant.connectionGeneration) ||
    grant.connectionGeneration < 1 ||
    typeof grant.presenceLeaseSeconds !== "number" ||
    !Number.isSafeInteger(grant.presenceLeaseSeconds) ||
    grant.presenceLeaseSeconds < 60 ||
    grant.presenceLeaseSeconds > 3600
  ) return null;
  return {
    machineId: grant.machineId,
    daemonId: grant.daemonId,
    connectionGeneration: grant.connectionGeneration,
    presenceLeaseSeconds: grant.presenceLeaseSeconds,
  };
}

function clientGrant(value: unknown): AuthorizeClientResponse | null {
  if (!value || typeof value !== "object") return null;
  const grant = value as Partial<AuthorizeClientResponse>;
  if (
    !identifier(grant.machineId) ||
    !identifier(grant.clientId) ||
    typeof grant.channelCapability !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(grant.channelCapability)
  ) {
    return null;
  }
  return {
    machineId: grant.machineId,
    clientId: grant.clientId,
    channelCapability: grant.channelCapability,
  };
}

function isRevocationSync(value: unknown): value is RevocationSync {
  if (!value || typeof value !== "object") return false;
  const sync = value as Partial<RevocationSync>;
  return (
    Array.isArray(sync.machineIds) &&
    sync.machineIds.every(identifier) &&
    (sync.clientIds === undefined ||
      (Array.isArray(sync.clientIds) && sync.clientIds.every(identifier)))
  );
}

function revocationOf(value: unknown): Revocation | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const reason = typeof event.reason === "string" ? event.reason : null;
  if (event.target === "client" && identifier(event.clientId) && reason) {
    return { target: "client", clientId: event.clientId, reason };
  }
  // `target` was absent from the original v1 event. Keeping this inference
  // lets either side of the additive rollout be deployed first.
  if (
    (event.target === undefined || event.target === "machine") &&
    identifier(event.machineId) &&
    reason
  ) {
    return { target: "machine", machineId: event.machineId, reason };
  }
  return null;
}
