import { defineSpecialty, qualificationReasons, selectForGate } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.contracts.qualification",
    title: "Qualification and gate selection preserve release evidence boundaries",
    oracle:
      "policy rejects identity drift and keeps real-LLM canaries plus platform E2E out of local merge gates",
    catches: [
      "dirty release",
      "rebuilt artifact still qualified",
      "skipped required case",
      "paid provider selected by a local merge gate",
      "platform E2E selected on a local merge gate",
    ],
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

    const base = {
      id: "journey.example",
      title: "example",
      kind: "journey" as const,
      oracle: "example",
      catches: ["example"],
      tags: ["session"],
      runner: "node" as const,
      llm: { default: "none" as const },
      resources: {
        environments: 1,
        cpu: 1,
        memoryMb: 256,
        io: 1,
        browser: 0,
        pool: "standard" as const,
      },
      expectedDurationMs: 100,
      timeoutMs: 1_000,
      surfaces: ["daemon"],
      file: "example.journey.ts",
    };
    const realMerge = selectForGate(
      { ...base, llm: { default: "real" }, resources: { ...base.resources, pool: "real-llm" } },
      "merge",
    );
    t.assertions.assert(!realMerge.include, "a real-LLM canary entered the local merge gate");
    t.assertions.assert(
      selectForGate(
        { ...base, llm: { default: "real" }, resources: { ...base.resources, pool: "real-llm" } },
        "beta",
      ).include,
      "the Beta gate lost its real-LLM canary",
    );
    const platformE2e = { ...base, id: "e2e.example", kind: "e2e" as const, file: "example.e2e.ts" };
    t.assertions.assert(!selectForGate(platformE2e, "merge").include, "platform E2E entered the merge gate");
    t.assertions.assert(selectForGate(platformE2e, "stable").include, "Stable lost its platform E2E matrix");
  },
);
