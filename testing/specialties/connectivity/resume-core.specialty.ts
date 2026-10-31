import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { defineSpecialty, BlockedError } from "../../framework/public.ts";

// Native framing/nonce properties and the independent TypeScript endpoint.
// This executes language-local properties and TS binding projection, not Rust
// business journeys. The separate logical-resume specialty qualifies the real artifact.
defineSpecialty({
  id: "specialty.connectivity.resume-core",
  title: "Physical connections preserve frame order and end old streams under loss",
  oracle: "Frame limits, cancellation-safe secure-record nonces, DATA/FIN order and endpoint termination without byte replay; new connections use new owners",
  catches: ["incorrect wire limit", "lost carrier retains old streams", "direct-only uses Fabric", "cancelled write consumes nonce", "closed channel delivers late crypto"],
  tags: ["network-risk-v2", "core", "contract", "connectivity", "resume-core"],
  llm: { default: "none" },
  expectedDurationMs: 60000, timeoutMs: 300000,
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["protocol-codec", "rust-u64", "workbench-dataplane"],
}, async (t) => {
  const run = promisify(execFile);
  const generated = await mkdtemp(join(t.env.root, "resume-proto-"));
  const commands: Array<[string, string[], string]> = [
    [process.execPath, [join(t.openRoot, "packages/workbench/node_modules/vitest/vitest.mjs"), "run", "--maxWorkers", "2", "src/dataplane/authenticated-channel.test.ts", "src/dataplane/endpoint.test.ts", "src/dataplane/handshake.test.ts"], join(t.openRoot, "packages/workbench")],
    [process.execPath, [join(t.openRoot, "packages/workbench/node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], join(t.openRoot, "packages/workbench")],
    ["cargo", ["test", "-p", "genehub-proto", "--lib", "export_bindings"], t.openRoot],
    ["cargo", ["test", "-p", "genehub-proto", "--lib", "data::tests", "--", "--nocapture"], t.openRoot],
    ["cargo", ["test", "-p", "genet-daemon", "--lib", "dataplane::authenticated_channel::tests", "--", "--nocapture"], t.openRoot],
  ];
  for (const [executable, args, cwd] of commands) {
    try {
      const { stdout } = await run(executable, args, { cwd, env: { ...process.env, CARGO_TERM_COLOR: "never", TS_RS_EXPORT_DIR: generated }, timeout: 240000, maxBuffer: 1024 * 1024 });
      if (args.includes("export_bindings")) {
        const files = (await readdir(generated)).filter((file) => file.endsWith(".ts"));
        t.assertions.assert(files.includes("index.ts"), "No generated protocol index");
        for (const file of files) {
          t.assertions.assert(await readFile(join(generated, file), "utf8") === await readFile(join(t.openRoot, "packages/proto/bindings", file), "utf8"), `Generated binding drift: ${file}`);
        }
      }
      if (executable === "cargo") t.assertions.assert(/test result: ok\. [1-9]\d* passed/.test(stdout), "Rust property filter executed no tests");
      else if (args[0]!.endsWith("vitest.mjs")) t.assertions.assert(/Tests\s+[1-9]\d* passed/.test(stdout), "TypeScript property filter executed no tests");
      t.note(stdout.split("\n").filter((line) => /test result:|Tests\s|Test Files/.test(line)).join("\n"));
    } catch (error) {
      const e = error as Error & { code?: string; stdout?: string; stderr?: string };
      if (e.code === "ENOENT") throw new BlockedError("Resume property suite requires the installed Rust and Node toolchains");
      const output = e.stdout ?? "", panic = output.indexOf("panicked at");
      const excerpt = panic < 0 ? output.slice(-6000) : output.slice(Math.max(0, panic - 100), panic + 1500) + output.slice(-1500);
      throw new Error(`${executable} property suite failed: ${excerpt}\n${(e.stderr ?? e.message).slice(-3000)}`);
    }
  }
  t.note("Core properties and explicit encrypted stream termination; real socket-loss behavior is qualified separately by logical-resume. RTC handoff is qualified separately by the real Chromium specialty; this suite is not release qualification.");
});
