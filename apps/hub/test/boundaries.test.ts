import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
}

/** Resolves a relative import to a path under `src`, or null if it is a package. */
function resolveLocal(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return path.relative(SRC, path.resolve(path.dirname(file), specifier));
}

/**
 * "We could split these later" is worth nothing unless something fails when it
 * stops being true (`docs/architecture.md` §6.5).
 */
describe("the boundary between the two roles", () => {
  it("keeps the forwarding layer from importing the control plane", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(path.join(SRC, "forward"))) {
      for (const specifier of importsOf(file)) {
        const local = resolveLocal(file, specifier);
        if (local?.startsWith("control")) {
          offenders.push(`${path.relative(SRC, file)} -> ${local}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "the forwarding layer may only reach the control plane through contract/",
    );
  });

  it("keeps the forwarding layer to contract and shared", () => {
    const allowed = new Set(["contract", "forward", "shared"]);
    const offenders: string[] = [];
    for (const file of filesUnder(path.join(SRC, "forward"))) {
      for (const specifier of importsOf(file)) {
        const local = resolveLocal(file, specifier);
        if (!local) continue;
        const top = local.split(path.sep)[0]!;
        if (!allowed.has(top)) offenders.push(`${path.relative(SRC, file)} -> ${local}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("keeps the contract free of dependencies on either side", () => {
    for (const file of filesUnder(path.join(SRC, "contract"))) {
      for (const specifier of importsOf(file)) {
        assert.equal(
          resolveLocal(file, specifier),
          null,
          `${path.relative(SRC, file)} must not import anything local`,
        );
      }
    }
  });

  it("keeps every contract method in a shape that survives becoming a network call", () => {
    const source = readFileSync(path.join(SRC, "contract/index.ts"), "utf8");
    const body = source.slice(source.indexOf("interface ChannelAuthority"));
    // `onRevoked` is deliberately excluded: it registers a callback rather than
    // making a call, so it has no return value to cross a boundary.
    const calls = [...body.matchAll(/^ {2}(\w+)\([^)]*\):\s*([^;]+);/gm)].filter(
      ([, name]) => name !== "onRevoked",
    );
    assert.deepEqual(
      calls.map(([, name]) => name),
      ["authorizeDaemon", "authorizeClient", "reportPresence"],
      "a new contract method needs a deliberate decision, not a silent one",
    );

    for (const [, name, returns] of calls) {
      assert.match(
        returns!.trim(),
        /^Promise</,
        `${name} must be async: a synchronous method cannot cross a process boundary`,
      );
    }
  });
});
