import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTENT_CATEGORIES,
  contentEntries,
  summarizeContent,
} from "../src/content/registry.js";
import { createGameState } from "../src/core/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const shellReady = existsSync(path.join(root, "src", "ui.css"));
const knownCategories = new Set([...CONTENT_CATEGORIES, "unknown"]);

function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name), relative)
        : [relative];
    })
    .sort();
}

test("summarizeContent groups synthetic tower and enemy entries", { skip: !shellReady }, () => {
  const synthetic = [
    { id: "t1", category: "tower" },
    { id: "t2", category: "tower" },
    { id: "t3", category: "tower" },
    { id: "e1", category: "enemy" },
    { id: "e2", category: "enemy" },
  ];
  assert.deepEqual(summarizeContent(synthetic), { tower: 3, enemy: 2 });
});

test("baseline contract normalizes invalid categories to unknown", { skip: !shellReady }, () => {
  const hostile = [
    { id: "x1" },
    { id: "x2", category: 42 },
    { id: "x3", category: null },
    { id: "x4", category: "mystery" },
    { id: "x5", category: "<img onerror=alert(1)>" },
    { id: "x6", category: "&lt;script&gt;" },
    {},
  ];
  const summary = summarizeContent(hostile);
  assert.deepEqual(summary, { unknown: 7 });
  for (const category of Object.keys(summary)) {
    assert.ok(knownCategories.has(category));
    assert.doesNotMatch(category, /img|script|mystery|&lt;|&gt;|</i);
  }
});

test("render model surfaces only whitelisted categories", { skip: !shellReady }, async () => {
  const { buildHudModel, renderHudLines } = await import("../src/main.js");
  const synthetic = [
    { id: "t1", category: "tower" },
    { id: "e1", category: "enemy" },
    { id: "b1", category: "mystery" },
    { id: "b2", category: "<img onerror=alert(1)>" },
  ];
  const model = buildHudModel(
    createGameState(3),
    synthetic,
    summarizeContent(synthetic),
  );
  for (const group of model.contentGroups) {
    assert.ok(knownCategories.has(group.category));
    assert.equal(typeof group.label, "string");
    assert.ok(Number.isInteger(group.count) && group.count > 0);
  }
  const rendered = renderHudLines(model).join("\n");
  assert.doesNotMatch(rendered, /<img|mystery|onerror|&lt;script/i);
  assert.match(rendered, /Wave 0/);
  assert.match(rendered, /Uncatalogued: 2/);
});

test("actual registry totals remain internally consistent", { skip: !shellReady }, () => {
  const summary = summarizeContent(contentEntries);
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
  assert.equal(total, contentEntries.length);
  for (const category of Object.keys(summary)) {
    assert.ok(knownCategories.has(category));
  }
});

test("build discovers future nested source modules instead of freezing a baseline file list", { skip: !shellReady }, () => {
  const probeRoot = path.join(root, "src", "__build-contract-probe__");
  const probeDirectory = path.join(probeRoot, "future", "nested");
  const probe = path.join(probeDirectory, "__build-contract-probe__.js");
  const probeSource = "export const buildContractProbe = 'future-source-module';\n";
  mkdirSync(probeDirectory, { recursive: true });
  writeFileSync(probe, probeSource);
  try {
    rmSync(path.join(root, "dist"), { recursive: true, force: true });
    const run = spawnSync(process.execPath, [path.join("scripts", "build.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `build failed: ${run.stderr}`);

    const html = readFileSync(path.join(root, "dist", "index.html"), "utf8");
    assert.match(html, /href="\.\/src\/ui\.css"/);
    assert.match(html, /src="\.\/src\/main\.js"/);

    for (const relative of sourceFiles(path.join(root, "src"))) {
      const source = path.join(root, "src", relative);
      const built = path.join(root, "dist", "src", relative);
      assert.ok(existsSync(built), `dist/src/${relative} is missing after build`);
      assert.equal(readFileSync(built, "utf8"), readFileSync(source, "utf8"));
    }
    assert.equal(
      readFileSync(
        path.join(root, "dist", "src", "__build-contract-probe__", "future", "nested", path.basename(probe)),
        "utf8",
      ),
      probeSource,
    );
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
});
