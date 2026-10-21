import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.install.live-loopback-dev-only",
  title: "publication plans reject HTTP outside literal dev loopback before any build or publication",
  oracle: "the real publisher CLI plan refuses beta/stable loopback HTTP and dev remote HTTP with an HTTPS error; dev literal loopback and HTTPS reach the missing-store preflight, without a build or release",
  catches: ["non-dev public HTTP accepted", "dev remote HTTP accepted", "dev loopback validation broken"],
  tags: ["core", "install", "merge-remediation"], requiredRepos: ["cloud"], llm: { default: "none" },
  expectedDurationMs: 3000, timeoutMs: 30000, surfaces: ["publish-cli"],
}, async t => {
  for (const [channel, origin, allowed] of [
    ["beta", "http://127.0.0.1:1234", false], ["stable", "http://127.0.0.1:1234", false],
    ["dev", "http://example.invalid", false], ["dev", "http://127.0.0.1:1234", true],
    ["beta", "https://example.invalid", true],
  ] as const) {
    let output = "";
    try {
      await promisify(execFile)(process.execPath, [path.join(t.openRoot, "scripts/publish-component.mjs"),
        "--plan", "--channel", channel, "--cloud-root", process.env.TESTCTL_CLOUD_ROOT!, "--public-origin", origin], { timeout: 10000 });
      throw new Error("plan unexpectedly progressed without its required store");
    } catch (error) {
      output = String((error as { stderr?: string }).stderr ?? error);
    }
    t.assertions.assert(allowed ? output.includes("--store or --stage") : /https|loopback/i.test(output), `${channel} ${origin}: ${output}`);
  }
});
