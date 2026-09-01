import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { contentCatalog } from "../src/content/catalog.js";
import {
  CONTENT_CATEGORIES,
  contentEntries,
  summarizeContent,
} from "../src/content/registry.js";

const modulesRoot = new URL("../src/content/modules/", import.meta.url);
const moduleFiles = (() => {
  try {
    return readdirSync(modulesRoot).filter((file) => file.endsWith(".js"));
  } catch {
    return [];
  }
})();
const baselineOnly = contentCatalog.length === 0 && moduleFiles.length === 0;

function effectiveLines(source) {
  let inBlock = false;
  let count = 0;
  for (const raw of source.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    count += 1;
  }
  return count;
}

test("greenfield baseline waits for the content package", { skip: !baselineOnly }, () => {
  assert.deepEqual(contentCatalog, []);
  assert.deepEqual(contentEntries, []);
});

test("content catalog and production registry are complete", { skip: baselineOnly }, () => {
  assert.equal(contentCatalog.length, 126);
  assert.equal(contentEntries.length, 126);
  assert.equal(moduleFiles.length, 126);
  assert.equal(new Set(contentEntries.map((entry) => entry.id)).size, 126);
  assert.deepEqual(summarizeContent(), {
    tower: 24,
    enemy: 24,
    wave: 18,
    ammo: 18,
    skill: 18,
    effect: 12,
    level: 12,
  });
  assert.deepEqual(new Set(contentEntries.map((entry) => entry.category)), new Set(CONTENT_CATEGORIES));
});

test("every production module exposes useful deterministic behavior", { skip: baselineOnly }, async () => {
  let aggregate = 0;
  for (const file of moduleFiles) {
    const source = readFileSync(new URL(file, modulesRoot), "utf8");
    const lines = effectiveLines(source);
    aggregate += lines;
    assert.ok(lines >= 165 && lines <= 180, `${file} has ${lines} effective lines`);
    const module = await import(new URL(file, modulesRoot));
    for (const name of ["entry", "evaluate", "scale", "schedule", "serialize", "validate"]) {
      assert.ok(name in module, `${file} is missing ${name}`);
    }
    assert.equal(module.validate().valid, true);
    assert.equal(module.evaluate({ threat: 2 }).id, module.entry.id);
    assert.equal(module.scale(1.5).id, module.entry.id);
    assert.equal(module.schedule(100).events.length, 4);
    assert.equal(JSON.parse(module.serialize()).entry.id, module.entry.id);
    assert.equal(module.entry.progression.length, 126);
  }
  assert.ok(aggregate >= 20_790, `production modules have ${aggregate} effective lines`);
});
