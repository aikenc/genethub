import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host and guest bake the WIT digest after stripping CR", () => {
  for (const rel of ["apps/host/build.rs", "apps/guest/build.rs"]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /b != b'\\r'/, `${rel} must ignore CR`);
  }
});
