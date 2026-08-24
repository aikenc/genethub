#!/usr/bin/env node
// Canonical Product Version helpers shared by the release workflow.
//
// Shape: `epoch.generation.live` with an optional `-tag.N` prerelease. The
// third digit advances on a Live Release; the middle digit advances (and the
// third resets to zero) on an App Release. The host crate keeps the same
// rules in apps/host/src/version.rs; keep the two in lockstep.

const CANONICAL = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;

export function parseProductVersion(raw) {
  if (typeof raw !== "string") throw new Error("version must be a string");
  const match = CANONICAL.exec(raw);
  if (!match) throw new Error(`not a canonical Product Version: ${raw}`);
  const [, epoch, generation, live, tag, number] = match;
  for (const part of [epoch, generation, live, number]) {
    if (part !== undefined && part.length > 1 && part.startsWith("0")) {
      throw new Error(`not a canonical Product Version: ${raw}`);
    }
  }
  if (tag !== undefined && Number(number) === 0) {
    throw new Error(`not a canonical Product Version: ${raw}`);
  }
  return {
    epoch: Number(epoch),
    generation: Number(generation),
    live: Number(live),
    tag: tag ?? null,
    number: tag === undefined ? null : Number(number),
  };
}

export function formatProductVersion(version) {
  const base = `${version.epoch}.${version.generation}.${version.live}`;
  return version.tag === null ? base : `${base}-${version.tag}.${version.number}`;
}

/** Total order inside one channel: numeric triple, then prerelease < release. */
export function compareProductVersions(left, right) {
  const a = parseProductVersion(left);
  const b = parseProductVersion(right);
  for (const key of ["epoch", "generation", "live"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.tag === b.tag) {
    if (a.tag === null) return 0;
    if (a.number === b.number) return 0;
    return a.number < b.number ? -1 : 1;
  }
  if (a.tag === null) return 1;
  if (b.tag === null) return -1;
  return a.tag < b.tag ? -1 : 1;
}

/** The version a Live Release on top of `current` carries. */
export function nextLiveVersion(current) {
  const parsed = parseProductVersion(current);
  if (parsed.tag === null) {
    return formatProductVersion({ ...parsed, live: parsed.live + 1 });
  }
  return formatProductVersion({ ...parsed, number: parsed.number + 1 });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "compare" && rest.length === 2) {
    process.stdout.write(`${compareProductVersions(rest[0], rest[1])}\n`);
  } else if (command === "next-live" && rest.length === 1) {
    process.stdout.write(`${nextLiveVersion(rest[0])}\n`);
  } else if (command === "check" && rest.length === 1) {
    parseProductVersion(rest[0]);
  } else {
    process.stderr.write("usage: product-version.mjs compare <a> <b> | next-live <v> | check <v>\n");
    process.exitCode = 64;
  }
}
