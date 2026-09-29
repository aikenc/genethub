import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

// Retain owning native facts once; protocol exports go to isolated scratch so
// running the suite cannot change the candidate it claims to verify.
defineSpecialty({
  id: "specialty.contracts.native-properties",
  title: "Owning native regressions and intrinsic properties execute once",
  oracle: "Owning Cargo suites execute nonzero tests without failed or ignored facts; generated public bindings match the candidate",
  catches: ["native protocol drift", "process lifecycle regression", "session refactor loses existing facts"],
  tags: ["contract", "core", "native-retained", "refactor-native", "native-crypto", "native-rtc", "native-agent-cli", "workflow", "storage", "recovery", "network-risk-v2"],
  llm: { default: "none" }, requiredArtifacts: [],
  resources: { environments: 1, cpu: 8, memoryMb: 8192, io: 2 },
  expectedDurationMs: 120000, timeoutMs: 1800000,
  surfaces: ["native-properties", "os-process", "daemon", "agent", "host-rtc", "protocol-binding"],
}, async t => {
  const generated = await mkdtemp(join(t.env.root, "native-bindings-"));
  const commands = [
    ["test", "--profile", "iterate", "-p", "genet-daemon", "-p", "genet-agent", "-p", "genehub-proto", "-p", "genet-frontdoor", "-p", "genet-http", "-p", "genet-native", "-p", "genehub-identity", "--lib", "--", "--test-threads=4"],
    ["test", "--profile", "iterate", "-p", "genet-cli", "--bin", "genet-local", "--", "--test-threads=4"],
    ["test", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local", "--", "--test-threads=4"],
  ];
  for (const args of commands) {
    try {
      const { stdout } = await promisify(execFile)("cargo", args, {
        cwd: t.openRoot,
        env: { ...process.env, RUST_MIN_STACK: "16777216", TS_RS_EXPORT_DIR: generated },
        timeout: 1750000, maxBuffer: 16 * 1024 * 1024,
      });
      const results = [...stdout.matchAll(/test result: ok\. (\d+) passed; 0 failed; (\d+) ignored/g)];
      t.assertions.assert(results.length >= (args.includes("--lib") ? 7 : 1) &&
        results.every(r => Number(r[1]) > 0 && Number(r[2]) === 0),
        "Owning native suites did not all execute: " + stdout.slice(-6000));
      t.note(results.map(r => r[0]).join("\n"));
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`Native properties failed: ${(e.stdout ?? "").slice(-12000)}\n${(e.stderr ?? e.message).slice(-6000)}`);
    }
  }
  const files = (await readdir(generated)).filter(file => file.endsWith(".ts"));
  t.assertions.assert(files.includes("index.ts"), "Native suite did not generate the public protocol bindings");
  for (const file of files) t.assertions.assert(
    await readFile(join(generated, file), "utf8") === await readFile(join(t.openRoot, "packages/proto/bindings", file), "utf8"),
    `Generated public binding drift: ${file}`);
});
