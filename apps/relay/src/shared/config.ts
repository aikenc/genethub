function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set: the relay cannot authorise anything on its own`);
  }
  return value;
}

export const config = {
  port: intFromEnv("RELAY_PORT", 8788),
  host: process.env.RELAY_HOST ?? "0.0.0.0",

  /**
   * Where the relay asks whether a ticket is good.
   *
   * There is no default and no fallback. A relay that cannot reach a control
   * plane must refuse to start rather than come up and quietly reject every
   * connection, which looks like a network fault and is not one.
   */
  controlOrigin(): string {
    return required("RELAY_CONTROL_ORIGIN").replace(/\/$/, "");
  },

  /** Bearer token the control plane expects on the contract endpoints. */
  controlToken(): string | null {
    return process.env.RELAY_CONTROL_TOKEN ?? null;
  },

  limits: {
    maxDaemons: intFromEnv("RELAY_MAX_DAEMONS", 5000),
    maxClientsPerMachine: intFromEnv("RELAY_MAX_CLIENTS_PER_MACHINE", 8),
    /** Bytes buffered for one peer before we consider it too slow and cut it. */
    maxBufferedBytes: intFromEnv("RELAY_MAX_BUFFERED_BYTES", 8 * 1024 * 1024),
    /** Largest single frame we will relay. */
    maxFrameBytes: intFromEnv("RELAY_MAX_FRAME_BYTES", 4 * 1024 * 1024),
    /** Uplink is dropped if no traffic and no pong for this long. */
    heartbeatSeconds: intFromEnv("RELAY_HEARTBEAT", 30),
  },
} as const;
