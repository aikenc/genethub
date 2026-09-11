import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineSpecialty, BlockedError } from "../../framework/public.ts";

// Keep the role's existing package baselines under the same isolated testctl
// evidence owner as protocol checks. Their native TAP failures are not retried.
for (const component of ["relay", "cloud-server"] as const) {
  defineSpecialty({
    id: `specialty.contracts.network-baseline-${component}`,
    title: `${component} existing contract and authorization baseline`,
    oracle: "Existing package typecheck and Node TAP suites complete with nonzero test count and zero failures",
    catches: ["relay boundary regression", "control-plane authorization regression", "cross-repo type drift"],
    tags: ["network-risk-v2", "contract", "network-baseline"],
    llm: { default: "none" },
    expectedDurationMs: 20000, timeoutMs: 180000,
    resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
    surfaces: [component],
  }, async (t) => {
    const cloudRoot = process.env.TESTCTL_CLOUD_ROOT;
    if (component === "cloud-server" && !cloudRoot) throw new BlockedError("Cloud worktree is required");
    const cwd = component === "relay" ? join(t.openRoot, "apps/relay") : join(cloudRoot!, "server");
    const tests = (await readdir(join(cwd, "test"))).filter((name) => name.endsWith(".test.ts")).sort();
    t.assertions.assert(tests.length > 0, "No package baseline tests found");
    const commands = [
      [join(cwd, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.test.json"],
      ["--test", "--test-reporter=tap", "--import", "tsx", ...tests.map((name) => join(cwd, "test", name))],
    ];
    for (const args of commands) {
      try {
        const { stdout } = await promisify(execFile)(process.execPath, args, {
          cwd, env: process.env, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        });
        if (args[0] === "--test") {
          t.assertions.assert(/^# tests [1-9]\d*$/m.test(stdout) && /^# pass [1-9]\d*$/m.test(stdout) && /^# fail 0$/m.test(stdout), "TAP baseline did not execute successfully");
          t.note(stdout.split("\n").filter((line) => /^# (tests|pass|fail|skipped|cancelled) /.test(line)).join("; "));
        }
      } catch (error) {
        const e = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`${component} baseline failed: ${(e.stdout ?? "").slice(-5000)}\n${(e.stderr ?? e.message).slice(-3000)}`);
      }
    }
  });
}
