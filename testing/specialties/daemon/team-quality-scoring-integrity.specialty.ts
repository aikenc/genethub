import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-quality-scoring-integrity",
  title: "A changed private scorer invalidates new cards against the actual native embedded package",
  oracle: "A real native daemon supplies the scoring reference independently of the Team copy. Inert byte edits to four case-owned scoring files must invalidate diagnostic cards; missing native reference stays unknown, and unversioned legacy snapshots retain their original semantics.",
  catches: ["private scorer changes counted as pristine", "local template override supplies its own reference", "missing native manifest treated as a match", "new R7 silently rewrites legacy facts"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["genet context", "tools/run.py quality facts", "tools/run.py quality card"],
  surfaces: ["daemon", "team-template", "filesystem"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, browser: 0 }, expectedDurationMs: 20000, timeoutMs: 180000,
}, async t => {
  const r = await openTeam(t, "scoring-integrity");
  try {
    const context = await runGenetAsync(r.daemon.genet, ["context"], r.env);
    t.assertions.assert(context.code === 0, context.stderr);
    const manifest = JSON.parse(context.stdout).data.teamScoringManifest;
    t.assertions.assert(manifest?.basis === "native-embedded-team-scoring/1"
      && manifest.files?.["quality_attribution.py"] && manifest.files?.["quality_score.py"],
      "native context has no independent embedded scoring reference");
    const front = await r.create();
    await r.send(front, "An isolated native input establishes the real Team front; no user acceptance or official score is claimed.");
    await t.tools.waitUntil(async () => (await r.snapshot(front)).summary.status === "idle", 30000);
    // A configured template override must not become the reference for itself.
    const facts = () => JSON.parse(r.ok(["quality", "facts"], { TEAM_TEMPLATE: r.root }));
    const clean = facts();
    t.assertions.assert(clean.scoringIntegrity?.state === "matched" && clean.scoringIntegrityBasis === "native-embedded-team-scoring/1",
      "untouched Team bytes do not match their actual platform package");
    const file = join(t.env.root, "diagnostic-facts.json");
    const card = (value: any) => {
      writeFileSync(file, JSON.stringify(value));
      return JSON.parse(r.ok(["quality", "card", "--snapshot", file]));
    };
    const cleanCard = card(clean);
    t.assertions.assert(cleanCard.redLines.R7.triggered === false && cleanCard.cardValidity === "valid",
      "pristine reference was not reflected in the public card");
    const alerts = (samples: any[]) => {
      writeFileSync(file, JSON.stringify({ schema: "team-quality-alert-samples/1", samples }));
      return JSON.parse(r.ok(["quality", "alerts", "--snapshot", file]));
    };
    let lastChanged: any;
    for (const name of ["quality.py", "quality_score.py", "task_hours.py", "quality_attribution.py"]) {
      const path = join(r.root, "tools/genet_builtin", name), original = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([original, Buffer.from("\n# Isolated diagnostic byte mutation, no altered scoring behavior.\n")]));
        const changed = facts(), scored = card(changed);
        lastChanged = structuredClone(changed);
        t.assertions.assert(changed.scoringIntegrity.state === "mismatched"
          && changed.scoringIntegrity.files.some((x: any) => x.name === name && x.state === "mismatched")
          && scored.redLines.R7.triggered === true && scored.formal === false && scored.score === null
          && scored.cardValidity === "invalid",
          `${name} changed but its card remained valid`);
        if (name === "quality.py") {
          const again = facts(), replay = alerts([changed, again]);
          const incidents = Object.values(replay.state.incidents) as any[];
          t.assertions.assert(again.capturedAtMs > changed.capturedAtMs
            && incidents.filter(x => x.rule === "R7").length === 1
            && replay.steps[1].new.length === 0,
            "unchanged scoring mismatch generated a new R7 incident on the next native capture");
        }
        // Incomplete evidence cannot erase an independently observed mismatch.
        changed.scoringIntegrity.files.push({ name: "unavailable.py", state: "unknown" });
        t.assertions.assert(card(changed).redLines.R7.triggered === true, "missing evidence hid a known byte mismatch");
      } finally { writeFileSync(path, original); }
    }
    const restored = alerts([lastChanged, facts()]);
    t.assertions.assert((Object.values(restored.state.incidents) as any[])
      .filter(x => x.rule === "R7").every(x => x.status === "closed"),
      "restored native matching evidence failed to close its scoring-copy incident");
    const missing = structuredClone(clean);
    missing.scoringIntegrity = { state: "unknown", reason: "native-reference-unavailable", files: [] };
    t.assertions.assert(card(missing).redLines.R7.triggered === null && !card(missing).formal,
      "unavailable native reference manufactured a valid card");
    const legacy = structuredClone(clean); delete legacy.scoringIntegrityBasis; delete legacy.scoringIntegrity;
    const old = r.ok(["quality", "card", "--snapshot", (writeFileSync(file, JSON.stringify(legacy)), file)]);
    t.assertions.assert(!JSON.parse(old).redLines.R7 && old === r.ok(["quality", "card", "--snapshot", file]),
      "legacy facts acquired a new integrity judgment or lost byte reproducibility");
    t.note("Real native manifest and independent private file mutations; diagnostic fixtures only, no live Team writes or real user acceptance.");
  } finally { await r.dispose(); }
});
