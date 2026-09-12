// Canonical Product Version rules for the publisher: `epoch.generation.live`
// with an optional `-tag.N` prerelease. The three digits and the channel
// suffix are two independent dimensions:
//
// - A Live Release advances the third digit. On a prerelease line the first
//   Live after an App candidate (live == 0) moves `X.Y.0-beta.N` to
//   `X.Y.1-beta.1`; further Lives on the same target increment the candidate
//   counter (`X.Y.1-beta.1` → `X.Y.1-beta.2`), because `-beta.N` numbers the
//   candidates of one target version (docs/version-management.md §3.2).
// - An App Release advances the second digit and zeroes the third. The
//   App requires explicit user authorization and a native replacement review.
// - Promoting beta to stable strips the suffix. Once stable ships the target
//   beta was preparing, beta's next Live must move past it — a beta that is
//   behind stable serves its testers an update older than what users run.
// - Dev follows the same App/Live arithmetic (`X.Y.Z-dev.N`), based on the
//   generation its slot is building; only a slot that predates any product
//   line counts from `0.0.0-dev.N`. Dev versions never compare across slots
//   or channels, so no stable check applies.
//
// The host crate pins the same grammar in packages/frontdoor/src/version.rs —
// keep the runtime parsers in lockstep. This is the only JS arithmetic implementation.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;

export function parseProductVersion(raw) {
  if (typeof raw !== "string") throw new Error("release version must be a string");
  const match = CANONICAL.exec(raw);
  const parts = match?.slice(1) ?? [];
  const [, , , tag, number] = parts;
  const leadingZero = parts.some(
    (part, index) => index !== 3 && part !== undefined && part.length > 1 && part.startsWith("0"),
  );
  if (!match || leadingZero || (tag !== undefined && Number(number) === 0)) {
    throw new Error(`not a canonical Product Version: ${raw}`);
  }
  const [epoch, generation, live] = parts;
  if ([epoch, generation, live, number].some((p) => p !== undefined && !Number.isSafeInteger(Number(p)))) {
    throw new Error("Product Version exceeds the safe integer range");
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
    if (a.tag === null || a.number === b.number) return 0;
    return a.number < b.number ? -1 : 1;
  }
  if (a.tag === null) return 1;
  if (b.tag === null) return -1;
  return a.tag < b.tag ? -1 : 1;
}

/**
 * The version a Live Release on top of `current` carries.
 *
 * `stableLatest` is the stable channel's current version when the publisher
 * knows it (beta publishes pass it; stable and dev publishes never need it).
 * It exists so a beta Live never targets a version stable already shipped.
 */
export function nextLiveVersion(current, stableLatest) {
  const parsed = parseProductVersion(current);
  if (parsed.tag === null) {
    return formatProductVersion({ ...parsed, live: parsed.live + 1 });
  }
  // Beta and dev share the same Live arithmetic: the first Live after an App
  // candidate (live == 0) opens the next Live target, further Lives on the
  // same target increment the candidate counter.
  // Only beta is ordered against stable; dev slots never compare across
  // channels, so a dev Live just keeps counting candidates.
  if (parsed.tag === "beta" && stableLatest !== undefined && stableLatest !== null) {
    const stable = parseProductVersion(stableLatest);
    if (stable.tag !== null) throw new Error("stable baseline must be a stable Product Version");
    if (stable.epoch > parsed.epoch || (stable.epoch === parsed.epoch && stable.generation > parsed.generation)) {
      throw new Error(
        `beta ${current} is an App generation behind stable ${stableLatest}: ship an App beta first, Live cannot cross a generation`,
      );
    }
    if (stable.epoch === parsed.epoch && stable.generation === parsed.generation && stable.live >= parsed.live) {
      // Stable already shipped the target this beta line was preparing.
      return formatProductVersion({ ...parsed, live: stable.live + 1, number: 1 });
    }
  }
  if (parsed.live === 0) {
    return formatProductVersion({ ...parsed, live: 1, number: 1 });
  }
  return formatProductVersion({ ...parsed, number: parsed.number + 1 });
}

/**
 * The version an App Release on top of `current` carries: the classifier
 * decided the change set touches the native layer. A re-issued candidate for
 * the same App target (current is already a `X.Y.0` prerelease) increments
 * the candidate counter; anything else opens the next generation.
 */
export function nextAppVersion(current) {
  const parsed = parseProductVersion(current);
  if (parsed.tag !== null && parsed.live === 0) {
    return formatProductVersion({ ...parsed, number: parsed.number + 1 });
  }
  return formatProductVersion({
    epoch: parsed.epoch,
    generation: parsed.generation + 1,
    live: 0,
    tag: parsed.tag,
    number: parsed.tag === null ? null : 1,
  });
}

/** Validate an explicit product identity before any build or publish writes. */
export function versionForChannel(version, channel) {
  const parsed = parseProductVersion(version);
  if (!["stable", "beta", "dev", "local"].includes(channel)) throw new Error("invalid release channel");
  if (channel === "local") {
    if (version !== "0.0.0") throw new Error("local builds must be unreleased 0.0.0");
  } else if (parsed.tag !== (channel === "stable" ? null : channel)) {
    throw new Error(`Product Version ${version} does not belong to channel ${channel}`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check-channel" && args.length === 2) versionForChannel(args[0], args[1]);
  else if (command === "compare" && args.length === 2) console.log(compareProductVersions(...args));
  else if (command === "next-live" && args.length >= 1) console.log(nextLiveVersion(...args));
  else if (command === "next-app" && args.length === 1) console.log(nextAppVersion(args[0]));
  else if (command === "check" && args.length === 1) parseProductVersion(args[0]);
  else throw new Error("usage: product-version.mjs check-channel VERSION CHANNEL | next-live VERSION [STABLE] | next-app VERSION | compare A B | check VERSION");
}
