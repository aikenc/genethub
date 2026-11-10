import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.team-role-model-routing", title: "Task Owners and supports honor target role Agent/model defaults without rerouting saved sessions",
  oracle: "Native Session agentId/modelId match role configuration for default reflect/research, explicit model wins, replay keeps original SID/model after config changes, and ordinary work inherits root defaults.",
  catches: ["reflect task uses work model", "local role Agent ignored", "saved task reselected after config change", "explicit model ignored", "research support uses work route"],
  tags: ["core", "team-model-routing"], llm: { default: "none" }, expectedDurationMs: 18000, timeoutMs: 180000,
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  surfaces: ["team-template", "daemon", "genet-cli"], productInterfaces: ["tools/run.py", "session.create", "session.get"],
}, async t => {
  const r = await openTeam(t, "role-model-routing", [{ id: "ctl-cli-command", profile: "cli-command" }], {
    portable: true, configureSource: source => cpSync(join(t.openRoot, "apps/daemon/builtin-skills/genehub/references/team-template/tools/genet_builtin"), join(source, "tools/genet_builtin"), { recursive: true }),
  });
  try {
    const config = (role: string, text: string) => {
      const file = join(r.root, ...(role ? ["spaces", role] : []), ".genethub/open.env");
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
    };
    config("", "TEAM_AGENT=ctl-normal\nTEAM_MODEL_WORK=fixture\nTEAM_MODEL_RESEARCH=fixture\nTEAM_BOARD_PORT=0\nTEAM_WAKE_GAP=999999\n");
    config("team-reflect", "TEAM_AGENT=ctl-cli-command\nTEAM_MODEL_REFLECT=fixture-alt\n");
    config("research", "TEAM_AGENT=ctl-normal\nTEAM_MODEL_RESEARCH=fixture-alt\n");
    const idle = (sid: string) => t.tools.waitUntil(async () => {
      const s = (await r.snapshot(sid)).summary; return s.status === "idle" && !s.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const caller = await r.create("ctl-cli-command");
    const cli = async (sid: string, args: string[]) => {
      await r.send(sid, JSON.stringify({ argv: [process.env.GENEHUB_PYTHON!, join(r.root, "tools/run.py"), ...args], cwd: r.root })); await idle(sid);
      const reply = (await r.snapshot(sid)).items.filter(i => i.type === "assistantMessage").at(-1);
      if (reply?.type !== "assistantMessage") throw Error("native caller returned no outcome");
      const result = JSON.parse(reply.text); t.assertions.assert(result.code === 0, result.out + result.err);
      return JSON.parse(result.out.trim().split("\n").at(-1));
    };
    const begin = ["task", "start", "--space", "team-reflect", "--desc", "bounded process review", "--request-id", "role.reflect.A", "Review without changing business files"];
    const first = await cli(caller, begin), owner = first.owner.sessionId; await idle(owner);
    const actual = (await r.snapshot(owner)).summary;
    t.assertions.assert(actual.agentId === "ctl-cli-command" && actual.modelId === "fixture-alt", `target role ignored: ${actual.agentId}/${actual.modelId}`);
    const support = await cli(owner, ["task", "support", first.taskId, "--space", "research", "--desc", "bounded research", "--request-id", "support.research", "Read-only bounded support"]);
    const supported = (await r.snapshot(support.collaborator)).summary;
    t.assertions.assert(supported.agentId === "ctl-normal" && supported.modelId === "fixture-alt", "research support did not use its target role model key");
    config("team-reflect", "TEAM_AGENT=ctl-cli-command\nTEAM_MODEL_REFLECT=fixture\n");
    const replay = await cli(caller, begin), kept = (await r.snapshot(replay.owner.sessionId)).summary;
    t.assertions.assert(replay.owner.sessionId === owner && kept.modelId === "fixture-alt", "replay reselected or changed a previously created Owner");
    config("team-reflect", "TEAM_AGENT=ctl-cli-command\nTEAM_MODEL_REFLECT=fixture-alt\n");
    const explicit = await cli(caller, ["task", "start", "--space", "team-reflect", "--desc", "explicit review", "--request-id", "role.reflect.B", "--model", "fixture", "Review with explicit model"]);
    const overridden = (await r.snapshot(explicit.owner.sessionId)).summary;
    t.assertions.assert(overridden.agentId === "ctl-cli-command" && overridden.modelId === "fixture", "explicit model did not override role default");
    const work = await cli(caller, ["task", "start", "--space", "leader", "--desc", "ordinary work", "--request-id", "role.work", "Read-only ordinary work"]);
    const inherited = (await r.snapshot(work.owner.sessionId)).summary;
    t.assertions.assert(inherited.agentId === "ctl-normal" && inherited.modelId === "fixture", "ordinary work lost root defaults");
    const spawn = r.ok(["spawn", "--kind", "research", "--desc", "ordinary research spawn", "Read-only research"]);
    const spawned = /s_[0-9a-f]+/.exec(spawn)?.[0]; t.assertions.assert(!!spawned, spawn);
    const legacy = (await r.snapshot(spawned!)).summary;
    t.assertions.assert(legacy.agentId === "ctl-normal" && legacy.modelId === "fixture-alt", "ordinary spawn ignored target research model");
  } finally { await r.dispose(); }
});
