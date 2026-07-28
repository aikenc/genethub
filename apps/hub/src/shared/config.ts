import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type Role = "control" | "forward";

/**
 * Which roles this process runs. Both by default, which is the shipping
 * topology; `ROLES=forward` is what the split-readiness smoke test uses and
 * what a real split would set (`docs/architecture.md` §6.4).
 */
export function rolesFromEnv(raw = process.env.ROLES): Set<Role> {
  const requested = (raw ?? "control,forward")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const roles = new Set<Role>();
  for (const value of requested) {
    if (value === "control" || value === "forward") roles.add(value);
    else throw new Error(`unknown role '${value}' in ROLES`);
  }
  if (roles.size === 0) throw new Error("ROLES must name at least one role");
  return roles;
}

export const config = {
  port: intFromEnv("HUB_PORT", 8787),
  host: process.env.HUB_HOST ?? "127.0.0.1",

  /**
   * Origin clients and daemons reach this deployment on. Behind a proxy it must
   * be set explicitly: the URLs we hand out are built from it.
   */
  publicOrigin: process.env.HUB_PUBLIC_ORIGIN ?? null,

  control: {
    databasePath: process.env.HUB_DB ?? path.resolve(process.cwd(), "data/hub.sqlite"),

    deviceAuthorization: {
      ttlSeconds: intFromEnv("HUB_DEVICE_AUTH_TTL", 600),
      pollIntervalSeconds: Math.max(1, intFromEnv("HUB_DEVICE_AUTH_INTERVAL", 5)),
    },

    transferLink: {
      ttlSeconds: intFromEnv("HUB_TRANSFER_LINK_TTL", 900),
    },

    session: {
      cookieName: "gh_session",
      ttlDays: intFromEnv("HUB_SESSION_TTL_DAYS", 30),
    },

    /** How long a channel ticket stays usable after it is issued. */
    channelTicketTtlSeconds: intFromEnv("HUB_CHANNEL_TICKET_TTL", 120),
  },

  /**
   * The forwarding role's own limits. Deliberately separate from anything the
   * control plane uses: a bandwidth spike must not take logins down with it
   * (`docs/architecture.md` §6.4).
   */
  forward: {
    /**
     * Where the forwarding role reaches the control plane. Unset in the
     * single-process topology, where the call is direct; a split deployment
     * points it at the control tier.
     */
    controlOrigin: process.env.HUB_CONTROL_ORIGIN ?? null,

    maxDaemons: intFromEnv("HUB_FORWARD_MAX_DAEMONS", 5000),
    maxClientsPerMachine: intFromEnv("HUB_FORWARD_MAX_CLIENTS_PER_MACHINE", 8),
    /** Bytes buffered for one peer before we consider it too slow and cut it. */
    maxBufferedBytes: intFromEnv("HUB_FORWARD_MAX_BUFFERED_BYTES", 8 * 1024 * 1024),
    /** Largest single frame we will relay. */
    maxFrameBytes: intFromEnv("HUB_FORWARD_MAX_FRAME_BYTES", 4 * 1024 * 1024),
    /** Uplink is dropped if no traffic and no pong for this long. */
    heartbeatSeconds: intFromEnv("HUB_FORWARD_HEARTBEAT", 30),
  },
} as const;
