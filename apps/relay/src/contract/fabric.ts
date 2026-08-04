/**
 * Runtime boundary between the endpoint-neutral Fabric forwarder and whichever
 * authority decides admission. All identifiers are deliberately opaque.
 */

export interface FabricEndpointGrant {
  endpointHandle: string;
  revocationHandle: string;
  expiresAt: string | null;
  /** Authority-issued monotonic fence for this physical connection. */
  connectionGeneration: number;
}

export interface FabricRouteGrant {
  targetEndpointHandle: string;
  routeHandle: string;
  expiresAt: string;
}

export type FabricPresenceState = "online" | "offline";

export interface FabricRevocation {
  target: "endpoint" | "route";
  handle: string;
}

export interface FabricAuthority {
  authorizeEndpoint(credential: string): Promise<FabricEndpointGrant | null>;
  authorizeRoute(
    sourceEndpointHandle: string,
    routeTicket: string,
  ): Promise<FabricRouteGrant | null>;
  reportEndpointPresence(
    endpointHandle: string,
    connectionGeneration: number,
    state: FabricPresenceState,
  ): Promise<void>;
  onFabricRevoked(handler: (revocation: FabricRevocation) => void): void;
}
