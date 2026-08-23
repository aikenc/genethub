import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import sources from "./sources.json";
import { agentAssets } from ".";

const root = dirname(fileURLToPath(import.meta.url));

describe("the bundled Agent asset library", () => {
  it("contains every manifest file at its reviewed checksum", () => {
    for (const asset of sources.assets) {
      for (const [file, expected] of Object.entries(asset.files)) {
        expect(file).not.toMatch(/[/\\]|\.\./);
        const bytes = readFileSync(resolve(root, file));
        expect(createHash("sha256").update(bytes).digest("hex"), `${asset.id}/${file}`).toBe(
          expected,
        );
      }
    }
  });

  it("keeps active SVG content passive and self-contained", () => {
    for (const asset of sources.assets) {
      for (const file of Object.keys(asset.files).filter((name) => name.endsWith(".svg"))) {
        const svg = readFileSync(resolve(root, file), "utf8");
        expect(svg, file).not.toMatch(
          /<script|<foreignObject|\son[a-z]+\s*=|<!DOCTYPE|<!ENTITY|(?:href|src)\s*=\s*["'](?:https?:|\/\/|javascript:|data:)|url\s*\(\s*["']?(?:https?:|\/\/|javascript:|data:)|@import/i,
        );
      }
    }
  });

  it("only exposes build-bundled URLs to runtime code", () => {
    const sourceIds = sources.assets.map((asset) => asset.id);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(Object.keys(agentAssets).sort()).toEqual(sourceIds.sort());
    for (const asset of sources.assets) {
      expect(asset.license.trim()).not.toBe("");
      expect(asset.redistributionNote.trim()).not.toBe("");
    }
    for (const variants of Object.values(agentAssets)) {
      for (const url of [variants.default, "light" in variants ? variants.light : undefined, "dark" in variants ? variants.dark : undefined]) {
        if (url) expect(url).not.toMatch(/^https?:/);
      }
    }
  });
});
