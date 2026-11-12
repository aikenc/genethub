import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-running-template-version-portable",
  title: "A standard source-free Team artifact retains the actual builtin package identity",
  oracle: "The real shipped Builder creates a portable Team. An independent Node digest records source builtin bytes, including a plain-text Skill reference; removing the case-owned source leaves the public quality facts identity exact and known, without a fabricated release label. Changing that packaged reference fails the actual artifact integrity verifier.",
  catches: ["portable output omits root builtin Skills", "runtime identity depends on original source directory", "non-Markdown Skill reference dropped", "installed platform label invented for a portable artifact", "packaged Skill mutation escapes receipt integrity"],
  tags: ["core", "team-quality", "team-classes"], llm: { default: "none" },
  productInterfaces: ["spacebuilder.py build", "spacebuilder.py verify --artifacts-only", "tools/run.py quality facts", "filesystem"],
  surfaces: ["daemon", "team-template", "spacebuilder", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 15000, timeoutMs: 90000,
}, async t => {
  const reference = "skills/genet_builtin/team-core/references/portable-version-fixture.txt";
  const r = await openTeam(t, "portable-template-version", [], { portable: true, configureSource(root) {
    writeFileSync(join(root, reference), "Case-owned builtin Skill reference; retain exact runtime bytes.\n");
  } });
  try {
    const files = [join(r.source, "tools/run.py")];
    const walk = (base: string) => {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.name === "__pycache__" || /\.py[co]$/.test(entry.name)) continue;
        const path = join(base, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path);
      }
    };
    walk(join(r.source, "tools/genet_builtin")); walk(join(r.source, "skills/genet_builtin"));
    const hash = createHash("sha256");
    for (const path of files.sort()) hash.update(relative(r.source, path).replaceAll("\\", "/") + "\0").update(readFileSync(path)).update("\0");
    const expected = "sha256:" + hash.digest("hex");
    rmSync(r.source, { recursive: true });
    const first = JSON.parse(r.ok(["quality", "facts"])).versions.teamTemplate;
    t.assertions.assert(first.id === expected && first.status === "content-only" && first.releaseVersion === null
      && existsSync(join(r.root, reference)), "source-free portable artifact lost its actual builtin identity: " + JSON.stringify(first));
    const verify = () => spawnSync(process.env.GENEHUB_PYTHON!, [r.builder, "verify", r.root, "--artifacts-only", "--format", "json"],
      { env: r.env, encoding: "utf8", timeout: 30000 });
    const intact = verify(); t.assertions.assert(intact.status === 0, intact.stdout + intact.stderr);
    const target = join(r.root, reference); writeFileSync(target, readFileSync(target, "utf8") + "Changed after packaging.\n");
    const changed = verify();
    t.assertions.assert(changed.status !== 0 && (changed.stdout + changed.stderr).includes("SB017"),
      "changed packaged builtin Skill escaped actual artifact integrity checks");
  } finally { await r.dispose(); }
});

defineSpecialty({
  id: "specialty.daemon.team-running-template-version",
  title: "A quality card identifies actual builtin runtime content independently of installed platform version",
  oracle: "Actual Team quality facts and card carry the SHA256 of real executing builtin files, Skills and launcher. A labelled restored adoption receipt may label only its exact bytes. A real local code or Skill edit invalidates that label while the installed daemon version and scoring basis stay unchanged; stale baseline information never proves adoption.",
  catches: ["installed daemon version mistaken for Team adoption", "platform branch mistaken for executing code", "modified builtin code retains old adopted label", "Skill changes omitted from actual version", "version metadata resets scoring basis"],
  tags: ["core", "team-quality"], llm: { default: "none" },
  productInterfaces: ["tools/run.py quality facts", "tools/run.py quality card", "filesystem"],
  surfaces: ["daemon", "team-template", "filesystem"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 }, expectedDurationMs: 12000, timeoutMs: 90000,
}, async t => {
  const r = await openTeam(t, "running-template-version", [{ id: "ctl-cli-command", profile: "cli-command" }]);
  try {
    const config = join(r.root, ".genethub/open.env");
    writeFileSync(config, readFileSync(config, "utf8") + "\nTEAM_AGENT=ctl-cli-command\nTEAM_BOARD_PORT=0\n");
    const front = await r.create("ctl-cli-command");
    await r.send(front, JSON.stringify({ requestId: "version.goal", cwd: r.root,
      argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), "task", "start", "--space", "leader", "--desc", "version evidence", "--request-id", "version.goal", "Observe the actual running template"] }));
    await t.tools.waitUntil(async () => {
      const s = (await r.snapshot(front)).summary;
      return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 20000);
    const reply = (await r.snapshot(front)).items.findLast(x => x.type === "assistantMessage" && x.text.includes('"version.goal"'));
    if (reply?.type !== "assistantMessage") throw Error("native version Task receipt missing");
    const result = JSON.parse(reply.text);
    t.assertions.assert(result.code === 0, result.err + result.out);
    const owner = JSON.parse(result.out).owner.sessionId as string;
    await t.tools.waitUntil(async () => (await r.snapshot(owner)).summary.status === "idle", 20000);
    const contentId = () => {
      const files = [join(r.root, "tools/run.py")];
      const walk = (base: string) => {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (entry.name === "__pycache__" || /\.py[co]$/.test(entry.name)) continue;
          const path = join(base, entry.name);
          if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path);
        }
      };
      walk(join(r.root, "tools/genet_builtin")); walk(join(r.root, "skills/genet_builtin"));
      const hash = createHash("sha256");
      for (const path of files.sort()) hash.update(relative(r.root, path).replaceAll("\\", "/") + "\0").update(readFileSync(path)).update("\0");
      return "sha256:" + hash.digest("hex");
    };
    const facts = () => JSON.parse(r.ok(["quality", "facts"]));
    const card = (value: any) => {
      const file = join(t.env.root, "external-version-facts.json"); writeFileSync(file, JSON.stringify(value));
      return JSON.parse(r.ok(["quality", "card", "--snapshot", file]));
    };
    const first = facts(), version = first.versions.teamTemplate;
    t.assertions.assert(version.schema === "team-running-template-version/1" && version.id === contentId()
      && version.releaseVersion === null && version.status === "content-only" && first.versions.platformAtCapture.length > 0,
      "actual native quality capture used installed/baseline version instead of running package bytes");
    const firstCard = card(first);
    t.assertions.assert(JSON.stringify(firstCard.versions.teamTemplate) === JSON.stringify(version),
      "public card lost its sole actual Team adoption field");
    // Explicit restored persistent receipt consumer fixture. This tests binding,
    // not execution of the programmatic upgrader (a separate product phase).
    const receipt = r.state("template-adoption.json");
    writeFileSync(receipt, JSON.stringify({ schema: "team-template-adoption/1", templateId: version.id,
      releaseVersion: "0.0.1-dev.42", verifiedAtMs: Date.now() - 1,
      fixture: "case-owned restored receipt; not a real upgrade or live Team adoption claim" }));
    const adopted = facts();
    t.assertions.assert(adopted.versions.teamTemplate.releaseVersion === "0.0.1-dev.42"
      && adopted.versions.teamTemplate.status === "verified-adoption", "matching restored receipt was not bound to actual bytes");
    const receiptBytes = readFileSync(receipt);
    const tool = join(r.root, "tools/genet_builtin/quality_events.py");
    writeFileSync(tool, readFileSync(tool, "utf8") + "\n# case-owned harmless local maintenance patch\n");
    const patched = facts();
    t.assertions.assert(patched.versions.teamTemplate.id === contentId() && patched.versions.teamTemplate.id !== version.id
      && patched.versions.teamTemplate.releaseVersion === null && patched.versions.teamTemplate.status === "unverified-receipt"
      && readFileSync(receipt).equals(receiptBytes), "local code change retained a stale release label or rewrote the original receipt");
    const skill = join(r.root, "skills/genet_builtin/team-reflect/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8") + "\nCase-owned local Skill clarification.\n");
    const clarified = facts();
    t.assertions.assert(clarified.versions.teamTemplate.id === contentId()
      && clarified.versions.teamTemplate.id !== patched.versions.teamTemplate.id
      && JSON.stringify(clarified.versions.platformAtCapture) === JSON.stringify(first.versions.platformAtCapture)
      && card(clarified).measurementVersion === firstCard.measurementVersion,
      "Skill change was omitted, platform identity changed, or metadata reset the measurement basis");
    const legacy = structuredClone(first); delete legacy.versions.teamTemplate;
    t.assertions.assert(!card(legacy).versions.teamTemplate, "legacy frozen facts acquired an invented adopted version");
    t.note("Real daemon capture and independent Node content digest; restored receipt reader fixture only, programmatic adoption remains a separate phase. No live Team or official card mutation.");
  } finally { await r.dispose(); }
});
