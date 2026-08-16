#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const MAX_MANIFEST_BYTES = 256 * 1024;

export function validateBetaPromotion({ app, logic, identity, openSha, officialRelease }) {
  if (!/^\d+\.\d+\.\d+$/.test(officialRelease ?? "")) {
    throw new Error("Official release must be plain SemVer");
  }
  if (!/^[0-9a-f]{40}$/.test(openSha ?? "")) {
    throw new Error("Open source identity must be a full commit SHA");
  }
  object(app, "Beta App manifest");
  object(logic, "Beta logic manifest");
  object(identity, "signed Official logic identity");

  if (app.schema !== "genehub.app-manifest.v1" || app.channel !== "beta") {
    throw new Error("App manifest is not Beta v1");
  }
  const betaRelease = /^(\d+\.\d+\.\d+)-beta\.([1-9]\d*)$/.exec(app.release ?? "");
  if (!betaRelease || betaRelease[1] !== officialRelease) {
    throw new Error(`current Beta App does not promote to ${officialRelease}`);
  }
  if (app.source?.openSha !== openSha) {
    throw new Error("Beta App was not built from the Official Open commit");
  }

  if (identity.moduleId !== "genehub:daemon/logic" || identity.channel !== "official") {
    throw new Error("prepared logic is not an Official GeneHub component");
  }
  positive(identity.platformAbi, "Official platform ABI");
  positive(identity.protocolVersion, "Official protocol version");
  positive(identity.componentSize, "Official component size");
  digest(identity.componentSha256, "Official component digest");
  if (app.platformAbi !== identity.platformAbi) {
    throw new Error("Beta App and Official Platform ABI differ");
  }
  if (
    app.bundledLogic?.channel !== "beta" ||
    !Number.isSafeInteger(app.bundledLogic.logicRevision) ||
    app.bundledLogic.logicRevision <= 0 ||
    app.bundledLogic.platformAbi !== app.platformAbi ||
    app.bundledLogic.protocolVersion !== identity.protocolVersion ||
    !/^[0-9a-f]{64}$/.test(app.bundledLogic.componentSha256 ?? "") ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(app.bundledLogic.keyId ?? "")
  ) {
    throw new Error("Beta App does not declare a matching bundled Logic dependency");
  }

  if (logic.schema !== "genehub.logic-manifest.v1" || logic.channel !== "beta") {
    throw new Error("logic manifest is not Beta v1");
  }
  positive(logic.logicRevision, "Beta logic revision");
  if (logic.activation?.enabled !== true) {
    throw new Error("Beta logic candidate is not active");
  }
  if (logic.source?.openSha !== openSha) {
    throw new Error("Beta logic was not built from the Official Open commit");
  }
  if (
    logic.platformAbi !== identity.platformAbi ||
    logic.protocolVersion !== identity.protocolVersion ||
    logic.artifact?.sha256 !== identity.componentSha256 ||
    logic.artifact?.size !== identity.componentSize
  ) {
    throw new Error("Official Wasm component is not the current Beta-proven component");
  }

  return {
    promotedFromBeta: `${app.release}/logic-r${logic.logicRevision}`,
    betaRelease: app.release,
    betaLogicRevision: logic.logicRevision,
  };
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.has("help")) {
    process.stdout.write(
      "Usage: node scripts/beta-promotion.mjs --app URL --logic URL --identity FILE --open-sha SHA --release X.Y.Z\n",
    );
    return;
  }
  const [app, logic, identity] = await Promise.all([
    fetchManifest(required(args, "app"), "Beta App"),
    fetchManifest(required(args, "logic"), "Beta logic"),
    readIdentity(required(args, "identity")),
  ]);
  const result = validateBetaPromotion({
    app,
    logic,
    identity,
    openSha: required(args, "open-sha"),
    officialRelease: required(args, "release"),
  });
  process.stdout.write(`${result.promotedFromBeta}\n`);
}

async function fetchManifest(rawUrl, label) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} manifest URL must be plain HTTPS`);
  }
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${label} manifest returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} manifest has an invalid size`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`${label} manifest is not JSON`);
  }
}

async function readIdentity(path) {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("logic identity has an invalid size");
  }
  return JSON.parse(bytes);
}

function parse(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (raw === "--help") {
      result.set("help", true);
      continue;
    }
    if (!raw?.startsWith("--")) throw new Error(`unexpected argument ${raw ?? ""}`);
    const name = raw.slice(2);
    if (result.has(name)) throw new Error(`duplicate argument --${name}`);
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    result.set(name, value);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name);
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function digest(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${label} is invalid`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
