import { defineSpecialty, qualificationReasons } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.qualification",
    title: "Qualification rejects SHA drift, artifact rebuild, required-not-run, and unstable",
    oracle: "policy reasons fire for identity mismatch without executing product code",
    catches: ["dirty release", "rebuilt artifact still qualified", "skipped required case"],
    tags: ["core", "contract"],
    expectedDurationMs: 400,
    timeoutMs: 10_000,
    surfaces: ["testctl"],
  },
  async (t) => {
    const dirtyRelease = qualificationReasons({
      gate: "dev",
      dirty: true,
      artifactHash: "abc",
      blocked: 0,
      failed: 0,
      unstable: 0,
      interrupted: 0,
    });
    t.assertions.assert(
      dirtyRelease.includes("dirty worktree cannot qualify a release gate"),
      "dirty release was accepted",
    );
    const sha = qualificationReasons({
      gate: "change",
      dirty: false,
      artifactHash: "abc",
      blocked: 0,
      failed: 0,
      unstable: 0,
      interrupted: 0,
      openSha: "aaa",
      requiredOpenSha: "bbb",
    });
    t.assertions.assert(sha.includes("open SHA does not match required identity"), "SHA drift accepted");
    const rebuild = qualificationReasons({
      gate: "change",
      dirty: false,
      artifactHash: "new",
      blocked: 0,
      failed: 0,
      unstable: 0,
      interrupted: 0,
      requiredArtifactHash: "old",
    });
    t.assertions.assert(
      rebuild.some((reason) => reason.includes("rebuild")),
      "artifact rebuild accepted",
    );
    const missing = qualificationReasons({
      gate: "change",
      dirty: false,
      artifactHash: "abc",
      blocked: 0,
      failed: 0,
      unstable: 0,
      interrupted: 0,
      requiredNotExecuted: ["journey.session.tool-write"],
    });
    t.assertions.assert(
      missing.some((reason) => reason.includes("journey.session.tool-write")),
      "required skip accepted",
    );
    const unstable = qualificationReasons({
      gate: "change",
      dirty: false,
      artifactHash: "abc",
      blocked: 0,
      failed: 0,
      unstable: 1,
      interrupted: 0,
    });
    t.assertions.assert(unstable.includes("run marked unstable"), "unstable run qualified");
  },
);
