import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.preview.image-native-orientation",
    title: "Native image preview applies camera orientation before encoding",
    oracle: "A JPEG with EXIF rotation 90 is encoded with swapped display dimensions",
    catches: ["preview image ignores camera orientation"],
    tags: ["preview", "image", "native-host"],
    expectedDurationMs: 30000,
    timeoutMs: 300000,
    resources: { environments: 1, cpu: 4, memoryMb: 2048, io: 1, browser: 0 },
    surfaces: ["genehub-host", "image-decoder"],
  },
  async (t) => {
    try {
      const { stdout } = await promisify(execFile)(
        "cargo",
        ["test", "--profile", "iterate", "-p", "genehub-host", "--bin", "genehub-host-local", "image_preview::tests::", "--", "--nocapture"],
        { cwd: t.openRoot, env: process.env, timeout: 280000, maxBuffer: 4 * 1024 * 1024 },
      );
      t.assertions.assert(/test result: ok\. 1 passed; 0 failed/.test(stdout), `orientation case did not pass: ${stdout.slice(-3000)}`);
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`native image orientation failed: ${(failure.stdout ?? "").slice(-4000)}\n${(failure.stderr ?? failure.message).slice(-3000)}`);
    }
  },
);
