import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

// Native-only RTC resource facts stay in their owning Rust package; testctl
// owns execution and evidence alongside the public browser business cases.
defineSpecialty({
  id: "specialty.contracts.native-rtc-baseline",
  title: "Native RTC resource preserves queue order and wakes blocked consumers on close",
  oracle: "The owning host package's RTC tests execute nonzero cases with zero failures, including real peer exchange and bounded queue wait/close",
  catches: ["full host RTC inbox drops authenticated records", "resource close leaves native receiver waiting"],
  tags: ["contract", "network-risk-v2", "event-flood", "native-rtc"], llm: { default: "none" },
  expectedDurationMs: 30000, timeoutMs: 300000,
  resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
  surfaces: ["native-rtc-resource", "real-webrtc-peer", "os-process"],
}, async t => {
  try {
    const { stdout } = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local", "rtc::tests::", "--", "--nocapture"], {
      cwd: t.openRoot, env: process.env, timeout: 280000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = stdout.match(/test result: ok\. ([1-9]\d*) passed; 0 failed/);
    t.assertions.assert(!!result, "native RTC baseline did not execute successfully: " + stdout.slice(-3000));
    t.note(`nativeRtcTests=${result![1]}`);
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`native RTC baseline failed: ${(e.stdout ?? "").slice(-4000)}\n${(e.stderr ?? e.message).slice(-3000)}`);
  }
});
