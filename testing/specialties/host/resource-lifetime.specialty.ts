import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.host.http-resource-ownership",
  title: "Owned WASI HTTP options do not accumulate or lose their timeouts",
  oracle: "The native Component ownership regression executes nonzero cases, including 200 real loopback HTTP requests in an eight-slot table, synchronous errors, cancellation, connection failure and first-byte timeout",
  catches: ["HTTP options consume the Host table forever", "cleanup loses timeout semantics or the Host header"],
  tags: ["core", "contract", "native-intrinsic", "daemon-resource-isolation"], llm: { default: "none" },
  expectedDurationMs: 30_000, timeoutMs: 600_000,
  resources: { environments: 1, cpu: 4, memoryMb: 4096, io: 1, browser: 0, pool: "heavy" },
  surfaces: ["genehub-host", "native-resource-table"], requiredArtifacts: [],
}, async t => {
  const { stdout } = await promisify(execFile)("cargo", ["test", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local", "http_hooks::tests::", "--", "--nocapture"], {
    cwd: t.openRoot, env: process.env, timeout: 570_000, maxBuffer: 4 * 1024 * 1024,
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`native HTTP ownership failed: ${(error.stdout ?? "").slice(-3000)}\n${(error.stderr ?? error.message).slice(-5000)}`);
  });
  t.assertions.assert(/test result: ok\. [1-9]\d* passed; 0 failed/.test(stdout), "native ownership filter did not execute successfully: " + stdout);
});
