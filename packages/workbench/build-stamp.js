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

function describe(cwd) {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      // A build from a tarball has no git, and that is not a build failure.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * `v0.1.21-3-g6dfa1d8 · cloud 2769b70 · 2026-07-31 06:12Z`.
 *
 * Three parts, each answering a question the others cannot.
 *
 * The workbench's `git describe` says which open-source source this is, and
 * that repository's version *is* its tag (`scripts/version.sh` explains why
 * nothing in the tree holds a number).
 *
 * `host` names the checkout doing the bundling, when it is a different one. A
 * page can be built from two repositories at once — the cloud console is the
 * workbench plus the pages that only exist when there are accounts — and with
 * only the first part, a change touching nothing but cloud code produces a
 * byte-identical stamp. That repository is deployed continuously and has no
 * tags on purpose: there is one running copy and nobody picks a version of it,
 * so the commit is the version and a tag would only be a second number to keep
 * in sync.
 *
 * The time says which *deploy*, and is the only part that always moves. It
 * answers the question neither sha can when a build is never redeployed: has
 * the thing I just built actually reached the server.
 *
 * Minutes, not seconds: this is a string people read off a screen and quote
 * back, and the last two digits would never once have mattered.
 *
 * The `Z` is not decoration. Build machines are rarely in the reader's
 * timezone, and an unmarked UTC time eight hours behind the wall clock reads
 * as a build that has not happened yet — the opposite of what it is for.
 *
 * @param host `{ name, root }` for the bundling checkout, when it is not this
 *   one. The name is the caller's to choose: a module shared between hosts must
 *   not be the place that knows what any one of them is called.
 */
export function buildStamp(host) {
  const mine = describe(root);
  const theirs = host ? describe(host.root) : "";
  const built = `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
  return [
    mine,
    // Omitted when it would repeat: bundling from inside this checkout makes
    // both describes the same string, and printing it twice reads as two
    // things that happen to agree rather than one thing said once.
    theirs && theirs !== mine ? `${host.name} ${theirs}` : "",
    built,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Spread into a Vite config's `define`. */
export function buildDefines(host) {
  return { __WORKBENCH_BUILD__: JSON.stringify(buildStamp(host)) };
}
