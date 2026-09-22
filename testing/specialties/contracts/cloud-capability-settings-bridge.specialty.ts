import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { BlockedError, defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.contracts.cloud-capability-settings-bridge",
  title: "Cloud bridge permits machine-global Agent tag and cost writes",
  oracle:
    "Machine diagnostics retain global Agent settings and every tag-routed Session operation, and the owning Cloud server still typechecks",
  catches: [
    "remote Workbench can read Agent tag/cost settings but cannot save them",
    "tag-routed Session failures are silently discarded from feedback diagnostics",
    "the Cloud app API bridge drifts from the daemon request surface",
  ],
  tags: ["contract", "cloud-server", "tag-routing"],
  llm: { default: "none" },
  requiredRepos: ["cloud"],
  expectedDurationMs: 30_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 1536, io: 1, browser: 0 },
  surfaces: ["cloud-server", "app-api"],
  productInterfaces: ["settings.setAgentPreferences"],
}, async t => {
  const cloudRoot = process.env.TESTCTL_CLOUD_ROOT;
  if (!cloudRoot) throw new BlockedError("The paired Cloud repository is required");
  const serverRoot = path.join(cloudRoot, "server");
  const bridge = readFileSync(path.join(serverRoot, "src/http/app-api.ts"), "utf8");
  const safeOperations = bridge.match(
    /const SAFE_MACHINE_OPERATIONS = new Set\(\[([\s\S]*?)\]\);/,
  )?.[1];
  for (const operation of [
    "settings.setAgentPreferences",
    "session.createRouted",
    "session.forkRouted",
    "session.forkImportRouted",
    "session.route",
    "session.switchAgent",
  ]) {
    t.assertions.assert(
      safeOperations?.includes(`"${operation}"`) === true,
      `${operation} is missing from SAFE_MACHINE_OPERATIONS`,
    );
  }
  try {
    await promisify(execFile)(
      process.execPath,
      [
        path.join(serverRoot, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.test.json",
        "--noEmit",
      ],
      { cwd: serverRoot, timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Cloud server typecheck failed\n${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`,
    );
  }
  t.note("Cloud app API safe operation and server typecheck passed");
});
