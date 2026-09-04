import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineSpecialty } from "../../framework/public.ts";

interface Attempt {
  status: number;
  text: string;
}

defineSpecialty(
  {
    id: "specialty.contracts.run-preflight",
    title: "A run refuses up front instead of discovering at the end that it could not be honest",
    oracle:
      "`testctl run` decides before the first case whether this machine can answer the plan: a PipeSpace name where a path belongs, a plan holding a Cloud-backed case without --cloud, and a runtime artifact that does not exist each end the run with exit 2, a message naming the value it got and the fix, and no run directory left behind",
    catches: [
      "a space name is accepted as a path and the run dies later on a missing runs/ directory",
      "a Cloud-backed case is planned without --cloud and only reports blocked after the whole gate has run",
      "a missing product build is discovered case by case instead of once",
      "a refusal still creates a run directory, so the space collects evidence of runs that never happened",
      "the refusal says what is wrong without saying what to do about it",
    ],
    tags: ["core", "contracts", "testctl"],
    llm: { default: "none" },
    expectedDurationMs: 8_000,
    timeoutMs: 90_000,
    resources: { environments: 1, cpu: 1, memoryMb: 256, io: 1, browser: 0, pool: "standard" },
    surfaces: ["testctl"],
    productInterfaces: ["testctl run"],
  },
  async (t) => {
    // `runsIgnored` asks git, so a usable space has to be a repository that
    // ignores its own evidence. Building one is the cheapest way to test the
    // checks that come after the space check.
    const space = path.join(t.env.root, "space");
    mkdirSync(space, { recursive: true });
    writeFileSync(path.join(space, ".gitignore"), "runs/\n");
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "space"]]) {
      spawnSync("git", ["-C", space, ...args], { encoding: "utf8" });
    }

    const testing = path.join(t.openRoot, "testing");
    const run = (args: string[], env: Record<string, string> = {}): Attempt => {
      const result = spawnSync("npm", ["--prefix", testing, "run", "testctl", "--", "run", ...args], {
        cwd: t.openRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { status: result.status ?? -1, text: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
    };

    const named = run(["--gate", "change", "--space", "dev-agent"]);
    t.assertions.assert(named.status === 2, `a space name was not refused: ${named.text}`);
    t.assertions.assert(
      named.text.includes("dev-agent") && named.text.includes("absolute path"),
      `the refusal did not name the value it got and the shape it wanted: ${named.text}`,
    );

    // `--tags hub` narrows the plan to the one case that boots the Cloud
    // control plane, so this asserts the requirement is read from the case's
    // own declaration rather than from the gate.
    const withoutCloud = run(["--gate", "change", "--tags", "hub", "--topic", "preflight", "--space", space]);
    t.assertions.assert(withoutCloud.status === 2, `a Cloud-backed plan ran without --cloud: ${withoutCloud.text}`);
    t.assertions.assert(
      withoutCloud.text.includes("--cloud") && withoutCloud.text.includes("journey.connectivity.desktop-startup-signs-in"),
      `the refusal did not name the case that needs Cloud: ${withoutCloud.text}`,
    );

    const brokenBuild = run(
      ["--gate", "change", "--tags", "hub", "--topic", "preflight", "--space", space, "--cloud", t.openRoot, "--no-build"],
      { GENEHUB_LOCAL_COMPONENT: path.join(t.env.root, "absent", "genehub_guest.wasm") },
    );
    t.assertions.assert(brokenBuild.status === 2, `an absent daemon component ran anyway: ${brokenBuild.text}`);
    t.assertions.assert(
      brokenBuild.text.includes("genehub_guest.wasm") && brokenBuild.text.includes("cargo build"),
      `the refusal did not say how to produce the artifact: ${brokenBuild.text}`,
    );

    const runs = path.join(space, "runs");
    const left = existsSync(runs) ? readdirSync(runs) : [];
    t.assertions.assert(
      left.length === 0,
      `a refused run still left evidence in ${runs}: ${left.join(", ")}`,
    );

    t.note(`refusals exited 2 with no run directory under ${runs}`);
  },
);
