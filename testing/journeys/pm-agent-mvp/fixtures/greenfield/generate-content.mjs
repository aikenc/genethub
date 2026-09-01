import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { contentCatalog } from "../src/content/catalog.js";

const CONTENT_DIR = new URL("../src/content/modules/", import.meta.url);
const REGISTRY = new URL("../src/content/registry.js", import.meta.url);
const CATEGORIES = Object.freeze([
  "tower",
  "enemy",
  "wave",
  "ammo",
  "skill",
  "effect",
  "level",
]);
const EXPECTED_COUNTS = Object.freeze({
  tower: 24,
  enemy: 24,
  wave: 18,
  ammo: 18,
  skill: 18,
  effect: 12,
  level: 12,
});

function fail(message) {
  throw new Error(`content catalog: ${message}`);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function integer(value, field, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function validateCatalog() {
  if (!Array.isArray(contentCatalog) || contentCatalog.length !== 126) {
    fail(`expected 126 entries, received ${contentCatalog?.length ?? "non-array"}`);
  }
  const ids = new Set();
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const [index, item] of contentCatalog.entries()) {
    if (!item || typeof item !== "object") fail(`entry ${index} must be an object`);
    if (!CATEGORIES.includes(item.category)) fail(`entry ${index} has invalid category`);
    if (typeof item.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(item.id)) {
      fail(`entry ${index} has invalid id`);
    }
    if (ids.has(item.id)) fail(`duplicate id ${item.id}`);
    ids.add(item.id);
    for (const field of ["name", "role", "element"]) {
      if (typeof item[field] !== "string" || item[field].trim().length < 3) {
        fail(`${item.id}.${field} must be a meaningful string`);
      }
    }
    integer(item.basePower, `${item.id}.basePower`, 1);
    integer(item.baseCost, `${item.id}.baseCost`, 0);
    integer(item.cadenceMs, `${item.id}.cadenceMs`, 50);
    if (!Array.isArray(item.tags) || item.tags.length < 2) {
      fail(`${item.id}.tags must contain at least two values`);
    }
    if (item.tags.some((tag) => typeof tag !== "string" || tag.trim().length < 2)) {
      fail(`${item.id}.tags contains an invalid value`);
    }
    counts[item.category] += 1;
  }
  for (const category of CATEGORIES) {
    if (counts[category] !== EXPECTED_COUNTS[category]) {
      fail(`${category} count ${counts[category]} != ${EXPECTED_COUNTS[category]}`);
    }
  }
}

function progressionLine(item, stage, ordinal) {
  const power = item.basePower + stage * (2 + (ordinal % 5));
  const cost = item.baseCost + stage * (3 + (ordinal % 7));
  const cooldownMs = Math.max(50, item.cadenceMs - stage * (1 + (ordinal % 3)));
  const unlock = `${item.element}-${item.role}-${String(stage).padStart(3, "0")}`;
  return `  Object.freeze({ stage: ${stage}, power: ${power}, cost: ${cost}, cooldownMs: ${cooldownMs}, unlock: ${JSON.stringify(unlock)} }),`;
}

function renderModule(item, ordinal) {
  const lines = [
    "const progression = Object.freeze([",
    ...Array.from({ length: 126 }, (_, index) =>
      progressionLine(item, index + 1, ordinal),
    ),
    "]);",
    "export const entry = Object.freeze({",
    `  id: ${JSON.stringify(item.id)},`,
    `  category: ${JSON.stringify(item.category)},`,
    `  name: ${JSON.stringify(item.name)},`,
    `  role: ${JSON.stringify(item.role)},`,
    `  element: ${JSON.stringify(item.element)},`,
    `  basePower: ${item.basePower},`,
    `  baseCost: ${item.baseCost},`,
    `  cadenceMs: ${item.cadenceMs},`,
    `  tags: Object.freeze(${JSON.stringify(item.tags)}),`,
    "  progression,",
    "});",
    "export function evaluate(context = {}) {",
    "  const threat = Math.max(1, Number(context.threat) || 1);",
    "  const pressure = Math.max(0, Number(context.pressure) || 0);",
    "  return Object.freeze({",
    "    id: entry.id,",
    "    power: Math.round(entry.basePower * threat + pressure),",
    "    cadenceMs: Math.max(50, entry.cadenceMs - pressure),",
    "    role: entry.role,",
    "  });",
    "}",
    "export function scale(factor = 1) {",
    "  const normalized = Math.min(4, Math.max(0.5, Number(factor) || 1));",
    "  return Object.freeze({",
    "    id: entry.id,",
    "    factor: normalized,",
    "    power: Math.round(entry.basePower * normalized),",
    "    cost: Math.round(entry.baseCost * normalized),",
    "  });",
    "}",
    "export function schedule(startAt = 0) {",
    "  const start = Number(startAt) || 0;",
    "  const events = Array.from({ length: 4 }, (_, index) => Object.freeze({",
    "    at: start + index * entry.cadenceMs,",
    "    phase: index % 2 === 0 ? \"opening\" : \"crescendo\",",
    "  }));",
    "  return Object.freeze({ id: entry.id, events: Object.freeze(events) });",
    "}",
    "export function serialize() {",
    "  return JSON.stringify({ format: \"greenfield-content/3\", entry });",
    "}",
    "export function validate(candidate = entry) {",
    "  const valid = Boolean(candidate)",
    "    && candidate.id === entry.id",
    "    && candidate.category === entry.category",
    "    && Number.isFinite(candidate.basePower)",
    "    && Number.isFinite(candidate.cadenceMs);",
    "  return Object.freeze({ id: entry.id, valid });",
    "}",
    "",
  ];
  const effective = lines.filter((line) => line.trim() && !line.trim().startsWith("//"));
  if (effective.length < 165 || effective.length > 180) {
    fail(`${item.id} renders ${effective.length} effective lines`);
  }
  return lines.join("\n");
}

validateCatalog();
rmSync(CONTENT_DIR, { recursive: true, force: true });
mkdirSync(CONTENT_DIR, { recursive: true });

const imports = [];
const aliases = [];
for (const [index, item] of contentCatalog.entries()) {
  const alias = `entry${String(index + 1).padStart(3, "0")}`;
  const filename = `${item.category}-${String(index + 1).padStart(3, "0")}-${slug(item.id)}.js`;
  writeFileSync(new URL(filename, CONTENT_DIR), renderModule(item, index), "utf8");
  imports.push(`import { entry as ${alias} } from './modules/${filename}';`);
  aliases.push(alias);
}

const registry = [
  ...imports,
  "",
  `export const CONTENT_CATEGORIES = Object.freeze(${JSON.stringify(CATEGORIES)});`,
  "const categorySet = new Set(CONTENT_CATEGORIES);",
  `export const contentEntries = Object.freeze([${aliases.join(", ")}]);`,
  "export function summarizeContent(entries = contentEntries) {",
  "  const counts = {};",
  "  for (const entry of entries) {",
  "    const category = typeof entry?.category === 'string' && categorySet.has(entry.category) ? entry.category : 'unknown';",
  "    counts[category] = (counts[category] ?? 0) + 1;",
  "  }",
  "  return counts;",
  "}",
  "",
].join("\n");
writeFileSync(REGISTRY, registry, "utf8");
