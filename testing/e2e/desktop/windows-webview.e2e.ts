import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { BlockedError, defineE2e } from "../../framework/public.ts";

defineE2e(
  {
    id: "e2e.desktop.windows-webview",
    title: "Windows WebView2 loads the remote stable site without a native bridge",
    oracle:
      "Installed Desktop boot page navigates to the channel HTTPS origin; the remote page has no Tauri invoke surface",
    catches: [
      "bundled privileged Web",
      "remote origin with Tauri IPC",
      "offline launch leaving a blank WebView",
    ],
    tags: ["desktop", "e2e", "windows", "webview"],
    runner: "node",
    resources: { environments: 1, cpu: 1, memoryMb: 1024, io: 1, browser: 1, pool: "browser" },
    expectedDurationMs: 60_000,
    timeoutMs: 180_000,
    surfaces: ["desktop"],
  },
  async (t) => {
    if (process.platform !== "win32") {
      throw new BlockedError("the Windows WebView2 gate requires a Windows environment");
    }
    const executable = path.join(
      t.openRoot,
      "apps/desktop/src-tauri/target/release/genethub-desktop-local.exe",
    );
    if (!existsSync(executable)) {
      throw new BlockedError("build the dev Desktop bundle before running the Windows WebView2 gate");
    }
    const script = path.join(t.openRoot, "apps/desktop/scripts/windows-webview-e2e.mjs");
    const result = spawnSync(process.execPath, [script], {
      cwd: t.openRoot,
      env: t.env.env,
      encoding: "utf8",
      timeout: 170_000,
    });
    t.assertions.assert(result.status === 0, result.stderr || result.stdout);
    t.assertions.assert(
      /kept the offline boot page and loaded the unprivileged remote site/u.test(result.stdout),
      "WebView2 proof output is missing",
    );
  },
);
