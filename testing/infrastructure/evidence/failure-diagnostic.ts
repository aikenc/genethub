import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { EnvironmentLease } from "../environment/lease.ts";

export const FAILURE_DIAGNOSTIC_LIMIT = 32 * 1024;

/** Captures only the bounded tail; the run store owns mandatory redaction before persistence. */
export function collectFailureDiagnostic(lease: EnvironmentLease): string | undefined {
  const logs = [
    { name: "lease/daemon.log", file: path.join(lease.logs, "daemon.log") },
    { name: "product/daemon.log", file: path.join(lease.data, "logs", "daemon.log") },
    { name: "product/cli-start.log", file: path.join(lease.data, "logs", "cli-start.log") },
  ].filter(({ file }, index, values) =>
    existsSync(file) && values.findIndex((candidate) => path.resolve(candidate.file) === path.resolve(file)) === index
  );
  if (logs.length === 0) {
    return `## daemon logs\n\nNo daemon or launcher log was created at the product log path.\n`;
  }
  const perLogLimit = Math.max(1, Math.floor(FAILURE_DIAGNOSTIC_LIMIT / logs.length));
  return logs
    .map(({ name, file }) => {
      try {
        const contents = readFileSync(file, "utf8");
        const tail = contents.slice(-perLogLimit);
        return `## ${name} (last ${tail.length} characters)\n\n\`\`\`text\n${tail}\n\`\`\`\n`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `## ${name}\n\nUnable to read bounded diagnostic: ${message}\n`;
      }
    })
    .join("\n");
}
