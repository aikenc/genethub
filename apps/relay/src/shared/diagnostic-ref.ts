import { createHash } from "node:crypto";

/**
 * A log-safe join key for an opaque Fabric endpoint handle.
 *
 * Control can derive the same value for its audit entry, while Relay never
 * writes the underlying handle or any admission/route credential to a log.
 */
export function endpointDiagnosticRef(endpointHandle: string): string {
  return `ep_${createHash("sha256").update(endpointHandle).digest("hex").slice(0, 12)}`;
}
