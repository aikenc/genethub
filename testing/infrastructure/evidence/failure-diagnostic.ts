import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { EnvironmentLease } from "../environment/lease.ts";

export const FAILURE_DIAGNOSTIC_LIMIT = 32 * 1024;

/** Captures only the bounded tail; the run store owns mandatory redaction before persistence. */
export function collectFailureDiagnostic(lease: EnvironmentLease): string | undefined {
  const logs = [
    ["CLI startup log", path.join(lease.data, "logs", "cli-start.log")],
    ["daemon log", path.join(lease.data, "logs", "daemon.log")],
  ] as const;
  const perLogLimit = Math.floor(FAILURE_DIAGNOSTIC_LIMIT / logs.length);
  return logs
    .map(([label, log]) => {
      if (!existsSync(log)) return `## ${label}\n\nNo log was created at the product log path.\n`;
      try {
        const contents = readFileSync(log, "utf8");
        const tail = contents.slice(-perLogLimit);
        return `## ${label} (last ${tail.length} characters)\n\n\`\`\`text\n${tail}\n\`\`\`\n`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `## ${label}\n\nUnable to read bounded diagnostic: ${message}\n`;
      }
    })
    .join("\n");
}
