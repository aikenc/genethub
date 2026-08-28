import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BlockedError, defineSpecialty, tryLocateGuestProbe, tryLocateHost } from "../../framework/public.ts";

function build(openRoot: string, args: string[]): void {
  const result = spawnSync("cargo", args, {
    cwd: openRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new BlockedError(`cargo ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

defineSpecialty(
  {
    id: "specialty.host.component-health",
    title: "v2 host loads a wasip2 Component and the guest serves loopback /health",
    oracle: "HTTP GET /health returns 200 after the host compiles verified in-memory bytes",
    catches: [
      "host re-opens verified bytes through Component::from_file",
      "guest bind stays in native",
      "wasip2 listener never accepts",
      "js-sys/wasm-bindgen sneak into the probe",
    ],
    tags: ["core", "contract", "native-intrinsic"],
    llm: { default: "none" },
    expectedDurationMs: 90_000,
    timeoutMs: 240_000,
    resources: { environments: 1, cpu: 2, memoryMb: 2048, io: 1, browser: 0, pool: "heavy" },
    surfaces: ["genehub-host", "guest-probe"],
    productInterfaces: ["genehub-host"],
  },
  async (t) => {
    const hostSrc = path.join(t.openRoot, "apps/host/src/load.rs");
    const load = readFileSync(hostSrc, "utf8");
    t.assertions.assert(
      load.includes("precompile_component(&bytes)") && load.includes("Component::deserialize"),
      "host lost the in-memory precompile and deserialize path",
    );
    t.assertions.assert(!/Component::from_file\b/.test(load), "host must not call from_file");
    t.assertions.assert(load.includes("CHANNEL") && load.includes("\"local\""), "local channel is not compile-time");

    let host = tryLocateHost(t.openRoot);
    let guest = tryLocateGuestProbe(t.openRoot);
    if (!guest) {
      build(t.openRoot, ["build", "-p", "genehub-guest-probe", "--target", "wasm32-wasip2"]);
      guest = tryLocateGuestProbe(t.openRoot);
    }
    if (!host) {
      build(t.openRoot, ["build", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local"]);
      host = tryLocateHost(t.openRoot);
    }
    if (!host || !guest) {
      throw new BlockedError("genehub-host-local or genehub-guest-probe.wasm is missing after build");
    }

    const child = spawn(host, ["run", "--component", guest], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    const listening = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`guest did not print listening: ${combined}`)), 60_000);
      const onChunk = (chunk: Buffer) => {
        combined += chunk.toString("utf8");
        const match = combined.match(/listening\s+(127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`host exited ${code}: ${combined}`));
      });
    });

    try {
      const response = await fetch(`http://${listening}/health`);
      const body = await response.text();
      t.assertions.assert(response.status === 200, `health status ${response.status}`);
      t.assertions.assert(body.includes("ok"), `health body ${body}`);
    } finally {
      child.kill("SIGTERM");
    }
  },
);
