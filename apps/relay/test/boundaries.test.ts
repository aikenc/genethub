import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const REMOTE_AUTHORITY = /(?:remote-authority|remote-fabric-authority)\.ts$/;

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

function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** Resolves a relative import to a path under `src`, or null if it is a package. */
function resolveLocal(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return path.relative(SRC, path.resolve(path.dirname(file), specifier));
}

/**
 * The relay's claim is that it cannot read what it carries and cannot decide
 * who may connect. Both are only worth something if something fails when they
 * stop being true (`docs/architecture.md` §6.5).
 */
describe("what the relay is allowed to know", () => {
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

  it("keeps every contract method in a shape that survives being a network call", () => {
    const source = readFileSync(path.join(SRC, "contract/index.ts"), "utf8");
    const body = source.slice(source.indexOf("interface ChannelAuthority"));
    // `onRevoked` is deliberately excluded: it registers a callback rather than
    // making a call, so it has no return value to cross a boundary.
    const calls = [...body.matchAll(/^ {2}(\w+)\([^)]*\):\s*([^;]+);/gm)].filter(
      ([, name]) => name !== "onRevoked",
    );
    assert.deepEqual(
      calls.map(([, name]) => name),
      ["authorizeDaemon", "inspectClient", "authorizeClient", "reportPresence"],
      "a new contract method needs a deliberate decision, not a silent one",
    );

    for (const [, name, returns] of calls) {
      assert.match(
        returns!.trim(),
        /^Promise</,
        `${name} must be async: it is always a network call now`,
      );
    }
  });

  it("keeps the Fabric authority equally small and network-safe", () => {
    const source = readFileSync(path.join(SRC, "contract/fabric.ts"), "utf8");
    const body = source.slice(source.indexOf("interface FabricAuthority"));
    const calls = [...body.matchAll(/^ {2}(\w+)\([^)]*\):\s*([^;]+);/gm)].filter(
      ([, name]) => name !== "onFabricRevoked",
    );
    assert.deepEqual(
      calls.map(([, name]) => name),
      ["authorizeEndpoint", "authorizeRoute", "reportEndpointPresence"],
      "the Fabric relay may only admit endpoints/routes and report opaque presence",
    );
    for (const [, name, returns] of calls) {
      assert.match(returns!.trim(), /^Promise</, `${name} must remain a network call`);
    }
  });

  it("keeps Fabric contracts free of product and identity vocabulary", () => {
    const contract = ["fabric.ts", "fabric-wire.ts"]
      .map((name) => codeOf(path.join(SRC, "contract", name)))
      .join("\n");
    assert.doesNotMatch(
      contract,
      /\b(?:user|account|machine|nodeId|workspace|session|agent|command|argv|path)\b/i,
      "opaque endpoint and route handles are the relay's entire routing vocabulary",
    );
  });

  it("has no database, and no way to grow one by accident", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(SRC, "../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(manifest.dependencies ?? {});
    const storage = dependencies.filter((name) =>
      /sqlite|postgres|mysql|redis|mongo|prisma|drizzle|knex/i.test(name),
    );
    assert.deepEqual(
      storage,
      [],
      "a relay that stores anything is a relay someone has to trust",
    );
  });

  it("never looks inside a payload", () => {
    // The forwarder may read the seventeen-byte header and nothing else. A
    // JSON.parse anywhere in here would mean it had started to understand the
    // traffic, which is the thing users are being asked to believe it cannot do.
    const dataPath = filesUnder(path.join(SRC, "forward")).filter(
      // The authority client speaks JSON to the control plane, which is a
      // different conversation entirely: it never sees a payload.
      (file) => !REMOTE_AUTHORITY.test(file),
    );
    for (const file of dataPath) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /JSON\.parse|JSON\.stringify|parseEnvelope|decodeEnvelope|genehub[_-]proto/i,
        `${path.relative(SRC, file)} must not interpret what it carries`,
      );
    }
  });

  it("limits JSON to remote authority traffic, never the Fabric DATA path", () => {
    const forward = filesUnder(path.join(SRC, "forward"));
    const jsonUsers = forward
      .filter((file) => /JSON\.parse|JSON\.stringify/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));

    assert.ok(jsonUsers.length > 0, "the authority HTTP/SSE adapter is expected to speak JSON");
    assert.ok(
      jsonUsers.every((file) => REMOTE_AUTHORITY.test(file)),
      `only remote authority adapters may use JSON, saw ${jsonUsers.join(", ")}`,
    );
  });
});
