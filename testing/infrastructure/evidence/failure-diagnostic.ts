import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { EnvironmentLease } from "../environment/lease.ts";

export const FAILURE_DIAGNOSTIC_LIMIT = 32 * 1024;

/** Captures only the bounded tail; the run store owns mandatory redaction before persistence. */
export function collectFailureDiagnostic(lease: EnvironmentLease): string | undefined {
  const log = path.join(lease.data, "logs", "daemon.log");
  if (!existsSync(log)) return `## daemon log\n\nNo daemon log was created at the product log path.\n`;
  try {
    const contents = readFileSync(log, "utf8");
    const tail = contents.slice(-FAILURE_DIAGNOSTIC_LIMIT);
    return `## daemon log (last ${tail.length} characters)\n\n\`\`\`text\n${tail}\n\`\`\`\n`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `## daemon log\n\nUnable to read bounded diagnostic: ${message}\n`;
  }
}
