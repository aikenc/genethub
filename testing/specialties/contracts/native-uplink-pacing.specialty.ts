import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.native-uplink-pacing",
  title: "Native uplink budget distinguishes delivery from abandoned occupancy",
  oracle: "Owning native invariants and Relay protocol properties verify ACK-driven budgets, FIFO, sibling progress, global custody conservation and cancellation without false delivery",
  catches: ["cancellation trains a fictitious rate", "old socket releases new quota", "non-aligned cap never observes saturation"],
  tags: ["contract", "network-risk-v2", "network-review-experiment"], llm: {default: "none"},
  expectedDurationMs: 30000, timeoutMs: 300000,
  resources: {environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0},
  surfaces: ["daemon-pacing", "native-intrinsic", "relay-queue-properties"],
}, async t => {
  for (const [owner, module] of [["genet-daemon", "dataplane::"], ["genet-daemon", "transport::fabric::"], ["genehub-proto", "resume::"]] as const) {
  try {
    const {stdout} = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", owner, "--lib", module, "--", "--nocapture"], {
      cwd: t.openRoot, env: process.env, timeout: 280000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result, "pacing intrinsic tests did not pass: " + stdout.slice(-4000));
    t.note(`${module} tests=${result![1]}`);
  } catch (error) {
    const e = error as Error & {stdout?: string; stderr?: string};
    throw new Error(`pacing tests failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-4000)}`);
  }
  }
  try {
    const { stdout } = await promisify(execFile)("npm", ["--prefix", "apps/relay", "test"], {
      cwd: t.openRoot, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    const count = /^# tests ([1-9]\d*)$/m.exec(stdout);
    t.assertions.assert(!!count && /^# fail 0$/m.test(stdout), "Relay protocol properties failed: " + stdout.slice(-4000));
    t.note(`Relay owning protocol properties=${count![1]}; FIFO/sibling/cancellation/global budget included`);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Relay properties failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-4000)}`);
  }
});
