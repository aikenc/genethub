import type { AdjacentProtocolAdapter } from "../codec";

/**
 * Production adapters, oldest first. Every entry converts exactly N -> N+1.
 * There is no adapter yet because v3 is the first protocol under this policy.
 */
export const ADJACENT_PROTOCOL_ADAPTERS: readonly AdjacentProtocolAdapter[] = [];
