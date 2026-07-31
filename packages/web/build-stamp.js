import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

/**
 * What to stamp into a build so the page can say which one it is.
 *
 * Shared by every host that bundles the workbench — this repository's own Vite
 * config and the cloud console's, in a different checkout — because there is
 * more than one of them and a stamp that only one applies is a stamp you cannot
 * trust when it is missing.
 *
 * It exists because of a real hour lost: a phone was showing behaviour from a
 * build three releases old, the settings page said "daemon 0.1.21" (a different
 * program, on a different machine), and nothing anywhere said what the *page*
 * was. The deployment had simply not been rebuilt. With this, that is one look.
 */

/** The workbench checkout: this file is in it. */
const root = fileURLToPath(new URL(".", import.meta.url));

function describe() {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: root,
      encoding: "utf8",
      // A build from a tarball has no git, and that is not a build failure.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * `v0.1.21-2-g3f2a1c9 · 2026-07-31 13:40Z`.
 *
 * Both halves earn their place. The tag says which source, and answers "does
 * this page have the fix". The time says which *deploy*, and answers the
 * question the tag cannot when nothing was tagged: has the thing I just built
 * actually reached the server.
 *
 * Minutes, not seconds: this is a string people read off a screen and quote
 * back, and the last two digits would never once have mattered.
 *
 * The `Z` is not decoration. Build machines are rarely in the reader's
 * timezone, and an unmarked UTC time eight hours behind the wall clock reads
 * as a build that has not happened yet — the opposite of what it is for.
 */
export function buildStamp() {
  const version = describe();
  const built = `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
  return version ? `${version} · ${built}` : built;
}

/** Spread into a Vite config's `define`. */
export function buildDefines() {
  return { __WORKBENCH_BUILD__: JSON.stringify(buildStamp()) };
}
