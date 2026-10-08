import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { defineSpecialty, scriptAgentRuntimeMirror } from "../../framework/public.ts";

// Native-intrinsic properties stay in the owning crate. Actual Session/CLI/
// browser journeys separately verify the external behavior of this change.
defineSpecialty({
  id: "specialty.contracts.daemon-baseline",
  title: "The owning daemon library baseline keeps authorization, CLI and Session properties",
  oracle: "The complete existing daemon library suite executes a nonempty test set with no failures, including authorization classifications, native interaction persistence and CLI schema consistency",
  catches: ["new RPC breaks exhaustive authorization", "native Session persistence regresses", "CLI discovery differs from implementation"],
  tags: ["contract", "daemon-baseline", "durable-interaction"], llm: { default: "none" },
  expectedDurationMs: 60_000, timeoutMs: 300_000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0, pool: "exclusive" },
  surfaces: ["daemon-owning-package", "native-intrinsic"],
}, async t => {
  try {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", "genet-daemon", "--lib"], {
      cwd: t.openRoot, env: { ...process.env, GENEHUB_PYTHON_MIRRORS: scriptAgentRuntimeMirror(t.openRoot) },
      timeout: 280_000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result, "daemon baseline executed no passing suite");
    t.note(`daemonLibraryTests=${result![1]}; source=${path.basename(t.openRoot)}/apps/daemon`);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`daemon baseline failed: ${(e.stdout ?? "").slice(-9000)}\n${(e.stderr ?? e.message).slice(-2500)}`);
  }
});
