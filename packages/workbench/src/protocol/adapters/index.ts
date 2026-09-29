import type { AdjacentProtocolAdapter } from "../codec";
import { v3ToV4 } from "./v3-to-v4";

/** Adjacent, pure business conversions; retained generations need a complete chain. */
export const ADJACENT_PROTOCOL_ADAPTERS: readonly AdjacentProtocolAdapter[] = [v3ToV4];
