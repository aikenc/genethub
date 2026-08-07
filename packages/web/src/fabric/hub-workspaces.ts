import {
  FabricEndpoint,
  FabricStateError,
  type FabricConnectionState,
  type FabricEndpointOptions,
  type FabricReconnectOptions,
  type FabricSocketLike,
  type FabricStream,
} from "./endpoint";

export interface HubWorkspace {
  id: string;
  name: string;
  availability: "online" | "offline";
  lastSeenAt: string | null;
  revision: number;
}

export interface HubWorkspaceRoute {
  routeTicket: string;
  /** Deadline for spending routeTicket in OPEN. */
  expiresAt: string;
  /** Deadline for the operation after the route is redeemed. */
  operationExpiresAt: string;
  placementRevision: number;
  /** Metadata for a future E2EE handshake; this transport does not verify it. */
  targetFingerprint: string;
  /** Peer-auth secret is returned only to this browser, never to Relay. */
  peerCapability: string;
  peerSecret: string;
}

export interface HubWorkspaceOperation {
  stream: FabricStream;
  route: HubWorkspaceRoute;
}

export interface HubWorkspaceFabricOptions {
  /** Empty means same-origin `/app/...`, which is the browser deployment. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  socketFactory?: (url: string) => FabricSocketLike;
  streamId?: () => string;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Physical reconnect policy; false disables automatic recovery. */
  reconnect?: FabricReconnectOptions | false;
  /** Total deadline for issuing endpoints, routes, and directory reads. */
  requestTimeoutMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export class HubFabricApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Hub Fabric request failed (${status}: ${code})`);
    this.name = "HubFabricApiError";
  }
}

interface EndpointAdmission {
  endpointId: string;
  url: string;
  admissionExpiresAt: string;
  endpointExpiresAt: string;
}

/**
 * Resource-first Hub adapter over one endpoint-neutral Fabric connection.
 *
 * Workspace ids are sent only to the Hub route issuer. FabricEndpoint and the
 * Relay receive an opaque route ticket and opaque bytes. This class does not
 * connect a stream to daemon RPC, grant a capability, or claim E2EE.
 */
export class HubWorkspaceFabric {
  private endpoint: FabricEndpoint | null = null;
  private endpointId: string | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private readonly request: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly requests = new Set<AbortController>();

  constructor(private readonly options: HubWorkspaceFabricOptions = {}) {
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new FabricStateError("Hub Fabric request timeout must be positive");
    }
  }

  get connectionState(): FabricConnectionState {
    return this.endpoint?.connectionState ?? "idle";
  }

  get activeStreamCount(): number {
    return this.endpoint?.activeStreamCount ?? 0;
  }

  /**
   * Establishes the endpoint or joins an automatic physical recovery.
   *
   * Every recovery re-signs the same opaque endpoint id for a fresh one-shot
   * admission. Existing operations fail as outcome-unknown and are not replayed.
   */
  connect(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new FabricStateError("this Hub Fabric client was closed"));
    }
    if (this.endpoint) return this.endpoint.connect();
    if (this.starting) return this.starting;

    const start = this.start();
    this.starting = start;
    const clear = () => {
      if (this.starting === start) this.starting = null;
    };
    void start.then(clear, clear);
    return start;
  }

  /** Reads the account-wide logical workspace directory without choosing a node. */
  async directory(): Promise<HubWorkspace[]> {
    const response = await this.fetchJson("/app/workspaces", { method: "GET" });
    if (!isRecord(response) || !Array.isArray(response.workspaces)) {
      throw new HubFabricApiError(502, "invalid_workspace_directory");
    }
    return response.workspaces.map(workspaceOf);
  }

  /**
   * Resolves a workspace at the Hub, then spends that opaque route on the
   * already-open endpoint. Changing workspace never changes the socket.
   */
  async openWorkspace(
    workspaceId: string,
    opaqueHello: Uint8Array = new Uint8Array(),
  ): Promise<HubWorkspaceOperation> {
    const endpoint = this.endpoint;
    const sourceEndpointId = this.endpointId;
    if (!endpoint || !sourceEndpointId || endpoint.connectionState !== "open") {
      throw new FabricStateError(
        "Hub Fabric is not connected; call connect explicitly before opening a workspace",
      );
    }
    if (!workspaceId || workspaceId.length > 160) {
      throw new FabricStateError("workspace id must be 1..160 characters");
    }

    const response = await this.fetchJson("/app/fabric/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceEndpointId,
        target: { workspaceId },
      }),
    });
    const route = routeOf(response);
    if (expiry(route.expiresAt) <= this.now()) {
      throw new HubFabricApiError(409, "fabric_route_expired");
    }
    if (expiry(route.operationExpiresAt) <= this.now()) {
      throw new HubFabricApiError(409, "fabric_operation_expired");
    }

    // The socket may have dropped while the HTTP route was being minted. In
    // that race `open` fails and the one-shot route is abandoned; it is never
    // retried on a new connection without the caller making that decision.
    return {
      stream: endpoint.open(route.routeTicket, opaqueHello),
      route,
    };
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.endpoint?.close();
  }

  private async start(): Promise<void> {
    const admitted = await this.issueEndpoint(null);
    if (this.stopped) throw new FabricStateError("this Hub Fabric client was closed");
    const endpointId = admitted.endpointId;
    this.endpointId = endpointId;
    const endpointOptions: FabricEndpointOptions = {
      url: admitted.url,
      redial: async () => {
        const resumed = await this.issueEndpoint(endpointId);
        if (resumed.endpointId !== endpointId) {
          throw new HubFabricApiError(502, "fabric_endpoint_identity_changed");
        }
        return resumed.url;
      },
      ...(this.options.socketFactory
        ? { socketFactory: this.options.socketFactory }
        : {}),
      ...(this.options.streamId ? { streamId: this.options.streamId } : {}),
      ...(this.options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: this.options.connectTimeoutMs }),
      ...(this.options.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: this.options.maxFrameBytes }),
      ...(this.options.reconnect === undefined
        ? {}
        : { reconnect: this.options.reconnect }),
      ...(this.options.onError ? { onError: this.options.onError } : {}),
    };
    this.endpoint = new FabricEndpoint(endpointOptions);
    await this.endpoint.connect();
  }

  private async issueEndpoint(resume: string | null): Promise<EndpointAdmission> {
    const response = await this.fetchJson("/app/fabric/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(resume ? { endpointId: resume } : {}),
    });
    const admitted = admissionOf(response);
    if (expiry(admitted.admissionExpiresAt) <= this.now()) {
      throw new HubFabricApiError(409, "fabric_admission_expired");
    }
    if (expiry(admitted.endpointExpiresAt) <= this.now()) {
      throw new HubFabricApiError(401, "fabric_endpoint_expired");
    }
    return admitted;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    this.requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TypeError("Hub Fabric request timed out"));
      }, this.options.requestTimeoutMs ?? 10_000);
    });
    try {
      const response = await Promise.race([
        this.request(this.url(path), {
          ...init,
          credentials: "same-origin",
          signal: controller.signal,
        }),
        timeout,
      ]);
      const body = (await Promise.race([
        response.json().catch(() => null),
        timeout,
      ])) as unknown;
      if (!response.ok) {
        const code =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "request_failed";
        throw new HubFabricApiError(response.status, code);
      }
      return body;
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.requests.delete(controller);
    }
  }

  private url(path: string): string {
    const base = this.options.baseUrl?.trim();
    if (!base) return path;
    // A deployment base is a path prefix, not merely an origin. Leading `/`
    // on the API path would otherwise discard `/relay-dev-0` (or any other
    // reverse-proxy mount) under WHATWG URL resolution.
    const directoryBase = `${base.replace(/\/+$/, "")}/`;
    return new URL(path.replace(/^\/+/, ""), directoryBase).toString();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  error: string,
): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0) {
    throw new HubFabricApiError(502, error);
  }
  return found;
}

function expiry(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function admissionOf(value: unknown): EndpointAdmission {
  if (!isRecord(value)) throw new HubFabricApiError(502, "invalid_fabric_admission");
  const endpointId = requiredString(value, "endpointId", "invalid_fabric_admission");
  const url = requiredString(value, "url", "invalid_fabric_admission");
  const admissionExpiresAt = requiredString(
    value,
    "admissionExpiresAt",
    "invalid_fabric_admission",
  );
  const endpointExpiresAt = requiredString(
    value,
    "endpointExpiresAt",
    "invalid_fabric_admission",
  );
  try {
    const parsed = new URL(url, globalThis.location?.href ?? "https://localhost/");
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("not WS");
  } catch {
    throw new HubFabricApiError(502, "invalid_fabric_admission");
  }
  return { endpointId, url, admissionExpiresAt, endpointExpiresAt };
}

function routeOf(value: unknown): HubWorkspaceRoute {
  if (!isRecord(value)) throw new HubFabricApiError(502, "invalid_fabric_route");
  const placementRevision = value.placementRevision;
  if (!Number.isSafeInteger(placementRevision) || (placementRevision as number) < 0) {
    throw new HubFabricApiError(502, "invalid_fabric_route");
  }
  return {
    routeTicket: requiredString(value, "routeTicket", "invalid_fabric_route"),
    expiresAt: requiredString(value, "expiresAt", "invalid_fabric_route"),
    operationExpiresAt: requiredString(
      value,
      "operationExpiresAt",
      "invalid_fabric_route",
    ),
    placementRevision: placementRevision as number,
    targetFingerprint: requiredString(value, "targetFingerprint", "invalid_fabric_route"),
    peerCapability: requiredString(value, "peerCapability", "invalid_fabric_route"),
    peerSecret: requiredString(value, "peerSecret", "invalid_fabric_route"),
  };
}

function workspaceOf(value: unknown): HubWorkspace {
  if (!isRecord(value)) throw new HubFabricApiError(502, "invalid_workspace_directory");
  const availability = value.availability;
  const revision = value.revision;
  const lastSeenAt = value.lastSeenAt;
  if (
    (availability !== "online" && availability !== "offline") ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    (lastSeenAt !== null && typeof lastSeenAt !== "string")
  ) {
    throw new HubFabricApiError(502, "invalid_workspace_directory");
  }
  return {
    id: requiredString(value, "id", "invalid_workspace_directory"),
    name: requiredString(value, "name", "invalid_workspace_directory"),
    availability,
    lastSeenAt,
    revision: revision as number,
  };
}
