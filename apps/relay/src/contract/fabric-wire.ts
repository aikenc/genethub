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
export const FABRIC_PRESENCE = "/internal/fabric/v2/presence";
export const FABRIC_REVOCATIONS = "/internal/fabric/v2/revocations";

export interface FabricAuthorizeEndpointRequest {
  credential: string;
}

export interface FabricAuthorizeEndpointResponse {
  endpointHandle: string;
  revocationHandle: string;
  expiresAt: string | null;
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
  state: "online" | "offline";
}

export interface FabricRevocationEvent {
  target: "endpoint" | "route";
  handle: string;
}

export interface FabricRevocationSync {
  revocations: FabricRevocationEvent[];
}
