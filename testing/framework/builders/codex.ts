import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentLease } from "../../infrastructure/public.ts";
import { HOST_AGENT_CLIS, pathWithout, seedScriptAgentRuntime } from "./script-agent.ts";

/** Public third-party CLI protocol replacement, scoped to one daemon's PATH.
 * Complements journey.session.codex-same-timeline's real installed CLI canary.
 * If app-server v2 drifts, update the external frames, never the script to fit them.
 * The built-in codex script Agent drives it, so this also seeds the script
 * runtime (`seedScriptAgentRuntime`).
 */
export function registerScriptedCodex(lease: EnvironmentLease, turns: unknown[][]): string {
  seedScriptAgentRuntime(lease);
  const bin = path.join(lease.root, "codex-bin");
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "codex");
  copyFileSync(fileURLToPath(new URL("../../infrastructure/agents/scripted-codex.mjs", import.meta.url)), executable);
  chmodSync(executable, 0o700);
  const script = path.join(lease.root, "codex-frames.json");
  const journal = path.join(lease.root, "codex-turns.ndjson");
  writeFileSync(script, JSON.stringify({ turns }), { mode: 0o600 });
  // The double is the only Agent CLI this daemon can find (see hideHostAgentClis).
  lease.env.PATH = bin + path.delimiter + pathWithout(HOST_AGENT_CLIS, process.env.PATH ?? "");
  lease.env.GENEHUB_TEST_CODEX_SCRIPT = script;
  lease.env.GENEHUB_TEST_CODEX_JOURNAL = journal;
  return journal;
}

/** The npm package the built-in codex script installs and updates. */
export const CODEX_NPM_PACKAGE = "@openai/codex";

/** Where the built-in codex script keeps its own npm installation. */
export function codexNpmPrefix(lease: EnvironmentLease): string {
  return path.join(lease.data, "agents", "state", "codex", "npm");
}

/**
 * Points a real Codex CLI at the mock LLM through Codex's own user
 * configuration (`~/.codex/config.toml` in the lease home): a custom model
 * provider speaking the Responses API with the logged-in API key as bearer.
 * This replaces only the LLM endpoint; the CLI, its login, its app-server and
 * the GeneHub script are all real. Codex reads the file at each start.
 */
export function pointCodexAtMockLlm(lease: EnvironmentLease, origin: string): string {
  const dir = path.join(lease.home, ".codex");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");
  writeFileSync(
    file,
    [
      'model_provider = "mock"',
      "",
      "[model_providers.mock]",
      'name = "mock"',
      `base_url = ${JSON.stringify(`${origin}/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "supports_websockets = false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return file;
}
