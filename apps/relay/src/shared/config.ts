export function parseBoundedInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

const boundedEnv = (name: string, fallback: number, min: number, max: number) =>
  parseBoundedInteger(name, process.env[name], fallback, min, max);

const maxFrameBytes = boundedEnv("RELAY_MAX_FRAME_BYTES", 4 * 1024 * 1024, 1024, 16 * 1024 * 1024);
const maxBufferedBytes = boundedEnv(
  "RELAY_MAX_BUFFERED_BYTES",
  8 * 1024 * 1024,
  1024,
  64 * 1024 * 1024,
);
const maxOutboundQueuedBytes = boundedEnv(
  "RELAY_MAX_OUTBOUND_QUEUED_BYTES",
  64 * 1024 * 1024,
  1024,
  512 * 1024 * 1024,
);
export function validateBufferLimits(bufferedBytes: number, frameBytes: number): void {
  if (bufferedBytes >= frameBytes) return;
  throw new Error("RELAY_MAX_BUFFERED_BYTES must be at least RELAY_MAX_FRAME_BYTES");
}
validateBufferLimits(maxBufferedBytes, maxFrameBytes);
export function validateGlobalBufferLimit(globalBytes: number, socketBytes: number): void {
  if (globalBytes >= socketBytes) return;
  throw new Error(
    "RELAY_MAX_OUTBOUND_QUEUED_BYTES must be at least RELAY_MAX_BUFFERED_BYTES",
  );
}
validateGlobalBufferLimit(maxOutboundQueuedBytes, maxBufferedBytes);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set: the relay cannot authorise anything on its own`);
  }
  return value;
}

export function isLiteralLoopbackHost(host: string): boolean {
  if (host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
    ) &&
    parts[0] === "127"
  );
}

function literalLoopbackAuthority(authority: string): boolean {
  const host = authority.startsWith("[")
    ? authority.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1]
    : authority.match(/^([^:]+)(?::\d+)?$/)?.[1];
  return host ? isLiteralLoopbackHost(host) : false;
}

export function validateControlOrigin(value: string): string {
  const match = value.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/);
  if (!match || match[2]!.includes("@")) {
    throw new Error("RELAY_CONTROL_ORIGIN must be an HTTP(S) origin without credentials, query, or fragment");
  }
  const [, scheme, authority] = match;
  if (scheme === "http" && !literalLoopbackAuthority(authority!)) {
    throw new Error("RELAY_CONTROL_ORIGIN must use HTTPS except on a literal loopback IP");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RELAY_CONTROL_ORIGIN must use HTTP(S)");
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export const config = {
  // Port 0 is the operating system's safe ephemeral-port request. It is used
  // by real-process tests and by embedders that must avoid a bind race; the
  // server reports the selected port after listening.
  port: boundedEnv("RELAY_PORT", 8788, 0, 65_535),
  host: process.env.RELAY_HOST ?? "0.0.0.0",

  /**
   * `rendezvous` is the self-hosted mode: no control plane, no database, and
   * no opinion about who may connect — the machine decides that itself.
   */
  mode(): "control" | "rendezvous" {
    return process.env.RELAY_MODE === "rendezvous" ? "rendezvous" : "control";
  },

  /** What a machine has to show to hang an uplink on a rendezvous relay. */
  joinToken(): string | null {
    return process.env.RELAY_JOIN_TOKEN ?? null;
  },

  /**
   * Where the relay asks whether a ticket is good.
   *
   * There is no default and no fallback. A relay that cannot reach a control
   * plane must refuse to start rather than come up and quietly reject every
   * connection, which looks like a network fault and is not one.
   */
  controlOrigin(): string {
    return validateControlOrigin(required("RELAY_CONTROL_ORIGIN"));
  },

  /** Bearer token the control plane expects on the contract endpoints. */
  controlToken(): string {
    return required("RELAY_CONTROL_TOKEN");
  },

  limits: {
    /** All endpoint kinds share this one Fabric admission budget. */
    maxFabricEndpoints: boundedEnv("RELAY_MAX_FABRIC_ENDPOINTS", 10_000, 1, 1_000_000),
    /** Bounds raw upgrades waiting on the remote admission authority. */
    maxFabricPendingUpgrades: boundedEnv("RELAY_MAX_FABRIC_PENDING_UPGRADES", 256, 1, 100_000),
    /** Bounds route authorizations before they consume Control/SQLite work. */
    maxFabricPendingOpensPerEndpoint: boundedEnv(
      "RELAY_MAX_FABRIC_PENDING_OPENS_PER_ENDPOINT",
      32,
      1,
      4096,
    ),
    maxFabricPendingOpens: boundedEnv("RELAY_MAX_FABRIC_PENDING_OPENS", 1024, 1, 1_000_000),
    /** Bounds multiplexing metadata even when every peer behaves correctly. */
    maxFabricStreamsPerEndpoint: boundedEnv(
      "RELAY_MAX_FABRIC_STREAMS_PER_ENDPOINT",
      256,
      1,
      65_536,
    ),
    maxFabricStreams: boundedEnv("RELAY_MAX_FABRIC_STREAMS", 100_000, 1, 2_000_000),
    /**
     * Bounds reconnect replay fences without ever evicting a live security
     * fence. Once full, new endpoint identities fail closed until an expiring
     * identity can be pruned or the stateless relay is restarted.
     */
    maxFabricGenerationFences: boundedEnv(
      "RELAY_MAX_FABRIC_GENERATION_FENCES",
      100_000,
      1,
      2_000_000,
    ),
    /** Protocol faults are scoped to a socket until this bounded threshold. */
    maxFabricStrikes: boundedEnv("RELAY_MAX_FABRIC_STRIKES", 8, 1, 1024),
    /** Admission credentials carried in headers or query strings. */
    maxAdmissionCredentialBytes: boundedEnv(
      "RELAY_MAX_ADMISSION_CREDENTIAL_BYTES",
      4096,
      64,
      16 * 1024,
    ),
    /** Bytes buffered for one peer before we consider it too slow and cut it. */
    maxBufferedBytes,
    /** Process-wide bytes waiting for WebSocket send callbacks across all peers. */
    maxOutboundQueuedBytes,
    /** Largest single frame we will relay. */
    maxFrameBytes,
    /** Uplink is dropped if no traffic and no pong for this long. */
    heartbeatSeconds: boundedEnv("RELAY_HEARTBEAT", 30, 1, 300),
    /** Upper bound while refreshing Control's crash-safe Fabric presence lease. */
    fabricPresenceRefreshMaxSeconds: boundedEnv(
      "RELAY_FABRIC_PRESENCE_REFRESH_MAX",
      30,
      5,
      300,
    ),
    /** Control calls and revocation streams always have explicit deadlines. */
    authorityRequestMs: boundedEnv("RELAY_AUTHORITY_REQUEST_MS", 5_000, 100, 60_000),
    /** Small bound for one admission/presence JSON response. */
    maxAuthorityResponseBytes: boundedEnv(
      "RELAY_MAX_AUTHORITY_RESPONSE_BYTES",
      16 * 1024,
      1024,
      64 * 1024,
    ),
    revocationFirstEventMs: boundedEnv(
      "RELAY_REVOCATION_FIRST_EVENT_MS",
      10_000,
      100,
      600_000,
    ),
    revocationIdleMs: boundedEnv("RELAY_REVOCATION_IDLE_MS", 45_000, 100, 600_000),
    maxRevocationBufferBytes: boundedEnv(
      "RELAY_MAX_REVOCATION_BUFFER_BYTES",
      1024 * 1024,
      1024,
      64 * 1024 * 1024,
    ),
  },
} as const;
