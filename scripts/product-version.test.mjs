import test from "node:test";

import {
  compareProductVersions,
  nextLiveVersion,
  parseProductVersion,
} from "./product-version.mjs";

const CASES = [
  // Stable line: the third digit is the Live Release counter.
  { current: "0.1.0", next: "0.1.1" },
  { current: "0.1.9", next: "0.1.10" },
  // Beta/dev lines: a Live Release advances the channel counter instead.
  { current: "0.2.0-beta.1", next: "0.2.0-beta.2" },
  { current: "0.0.0-dev.4", next: "0.0.0-dev.5" },
];

for (const { current, next } of CASES) {
  test(`${current} live-releases to ${next}`, () => {
    if (nextLiveVersion(current) !== next) throw new Error("wrong live bump");
    if (compareProductVersions(current, next) !== -1) throw new Error("bump must move forward");
    if (compareProductVersions(next, current) !== 1) throw new Error("order must be antisymmetric");
  });
}

test("an App Release supersedes every prerelease of the same base", () => {
  if (compareProductVersions("0.2.0-beta.9", "0.2.0") !== -1) throw new Error("release must win");
  if (compareProductVersions("0.2.0", "0.3.0-beta.1") !== -1) throw new Error("base triple must win");
});

test("ordering is numeric, not lexicographic", () => {
  if (compareProductVersions("0.1.9", "0.1.10") !== -1) throw new Error("9 < 10");
  if (compareProductVersions("0.2.0-beta.2", "0.2.0-beta.10") !== -1) throw new Error("beta.2 < beta.10");
});

test("non-canonical versions are rejected", () => {
  for (const raw of ["", "1.2", "1.2.3.4", "01.2.3", "1.2.03", "1.2.3-beta", "1.2.3-beta.0", "1.2.3-Beta.1", "v1.2.3", "1.2.3 "]) {
    let accepted = false;
    try {
      parseProductVersion(raw);
      accepted = true;
    } catch {
      // expected
    }
    if (accepted) throw new Error(`accepted ${JSON.stringify(raw)}`);
  }
});
