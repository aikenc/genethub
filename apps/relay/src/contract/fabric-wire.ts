/**
 * Fabric v2's complete control-plane wire contract.
 *
 * This file is mirrored verbatim in genethub-cloud. It deliberately contains
 * only opaque handles: the relay must not learn which account, node,
 * workspace, session, or operation an endpoint represents.
 */

export const FABRIC_WIRE_VERSION = 2;
export const FABRIC_PATH = "/fabric/v2";

export const FABRIC_AUTHORIZE_ENDPOINT = "/internal/fabric/v2/authorize-endpoint";
export const FABRIC_AUTHORIZE_ROUTE = "/internal/fabric/v2/authorize-route";
/** `204` when this generation was applied; `409` when Control fenced it. */
export const FABRIC_PRESENCE = "/internal/fabric/v2/presence";
export const FABRIC_REVOCATIONS = "/internal/fabric/v2/revocations";

export interface FabricAuthorizeEndpointRequest {
  credential: string;
}

export interface FabricAuthorizeEndpointResponse {
  endpointHandle: string;
  revocationHandle: string;
  expiresAt: string | null;
  /** Cloud-issued fencing value for every presence report from this socket. */
  connectionGeneration: number;
  /** Cloud presence lease; every Relay uses the same authoritative duration. */
  presenceLeaseSeconds: number;
}

export interface FabricAuthorizeRouteRequest {
  sourceEndpointHandle: string;
  ticket: string;
}

export interface FabricAuthorizeRouteResponse {
  targetEndpointHandle: string;
  routeHandle: string;
  expiresAt: string;
}

export interface FabricPresenceRequest {
  endpointHandle: string;
  connectionGeneration: number;
  state: "online" | "offline";
}

export interface FabricRevocationEvent {
  target: "endpoint" | "route";
  handle: string;
}

export interface FabricRevocationSync {
  revocations: FabricRevocationEvent[];
}

/** Initial catch-up page and its explicit readiness fence. */
export type FabricRevocationSyncPage = FabricRevocationSync;
export type FabricRevocationSyncComplete = Record<string, never>;
