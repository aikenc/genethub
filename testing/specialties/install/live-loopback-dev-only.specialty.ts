// The Live publisher accepts a plain-http loopback origin only when it is told to, and the
// command line tells it to for the dev channel alone. A development slot publishes to its
// own Control on 127.0.0.1; beta and stable publish to https origins and must keep refusing
// anything else. This case holds the one line that decides it, because nothing else would
// notice it widening.

import { readFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.install.live-loopback-dev-only",
    title: "plain-http loopback publishing is enabled for the dev channel and no other",
    oracle:
      "scripts/publish-component.mjs mentions allowHttpLoopback exactly once, as `channel === \"dev\"`, so beta and stable publishing stay https-only",
    catches: [
      "plain-http publishing enabled for beta or stable",
      "the dev slot's Live publish failing because the loopback exception was removed",
    ],
    tags: ["core", "install"],
    llm: { default: "none" },
    expectedDurationMs: 300,
    timeoutMs: 10_000,
    surfaces: ["publish"],
  },
  async (t) => {
    const source = readFileSync(path.join(t.openRoot, "scripts", "publish-component.mjs"), "utf8");
    const uses = [...source.matchAll(/allowHttpLoopback[^\n]*/g)].map((match) => match[0].trim());
    t.assertions.assert(
      uses.length === 1 && /allowHttpLoopback:\s*channel === "dev",/.test(uses[0]!),
      `allowHttpLoopback must appear once, tied to the dev channel; found: ${JSON.stringify(uses)}`,
    );
  },
);
