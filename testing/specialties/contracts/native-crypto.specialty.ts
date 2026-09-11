import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

// Cross-language crypto vectors stay in their owning native package.
defineSpecialty({
  id: "specialty.contracts.native-crypto-baseline",
  title: "Native channel crypto matches the current cross-language wire vector",
  oracle: "The owning daemon package executes its handshake, direction, sequence and v4 golden-vector crypto tests",
  catches: ["Rust/Web encrypted wire drift", "channel record authentication regression"],
  tags: ["contract", "network-risk-v2", "native-crypto", "workbench-baseline"], llm: { default: "none" },
  expectedDurationMs: 30000, timeoutMs: 300000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["native-channel-crypto", "os-process"],
}, async t => {
  try {
    for (const filter of ["channel_auth::tests::", "dataplane::frame::tests::"]) {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", "genet-daemon", "--lib", filter, "--", "--nocapture"], {
      cwd: t.openRoot, env: process.env, timeout: 280000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result, "native crypto baseline did not execute successfully: " + stdout.slice(-3000));
    t.note(`${filter} passed=${result![1]}`);
    }
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`native crypto baseline failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-3000)}`);
  }
});
