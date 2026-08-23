import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Client, PROTOCOL_VERSION } from "./client";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { exports?: Record<string, string> };

describe("canonical client export", () => {
  it("is advertised as a package subpath that does not load the UI entry", () => {
    expect(pkg.exports?.["./client"]).toBe("./src/client.ts");
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "client.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']\.\/(App|boot|index)["']/);
    expect(source).toContain("./protocol/client");
  });

  it("exposes the same Client class the workbench uses", () => {
    expect(typeof Client).toBe("function");
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
