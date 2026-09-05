import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentLease } from "../../infrastructure/public.ts";

/** Public third-party CLI protocol replacement, scoped to one daemon's PATH.
 * Complements journey.session.codex-same-timeline's real installed CLI canary.
 * If app-server v2 drifts, update the external frames, never the adapter to fit them.
 */
export function registerScriptedCodex(lease: EnvironmentLease, turns: unknown[][]): string {
  const bin = path.join(lease.root, "codex-bin");
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "codex");
  copyFileSync(fileURLToPath(new URL("../../infrastructure/agents/scripted-codex.mjs", import.meta.url)), executable);
  chmodSync(executable, 0o700);
  const script = path.join(lease.root, "codex-frames.json");
  const journal = path.join(lease.root, "codex-turns.ndjson");
  writeFileSync(script, JSON.stringify({ turns }), { mode: 0o600 });
  lease.env.PATH = bin + path.delimiter + (process.env.PATH ?? "");
  lease.env.GENEHUB_TEST_CODEX_SCRIPT = script;
  lease.env.GENEHUB_TEST_CODEX_JOURNAL = journal;
  return journal;
}
