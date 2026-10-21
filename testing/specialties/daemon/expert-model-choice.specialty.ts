import { defineSpecialty, openTeam } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.expert-model-choice",
  title: "template model selection uses real routes and preserves the current owner of a shared model",
  oracle: "real team spawn inherits a requested model, explicit model overrides it, invalid tier/media creates nothing; choosing a shared model keeps the current allowed Agent and skips disallowed competing owners",
  catches: ["unexpected Agent migration", "removed catalog model wins", "template silently chooses another model"],
  tags: ["core", "expert", "session-model", "merge-remediation"], llm: { default: "none" },
  expectedDurationMs: 25000, timeoutMs: 150000, surfaces: ["daemon", "genet-cli", "tools/team.py"],
}, async t => {
  const r = await openTeam(t);
  try {
    const configured = await r.client.call({ type: "session.create", payload: {
      workspaceId: r.project.id, agentId: "ctl-normal", modelId: "fixture", modeId: "keep-mode",
      fast: false, runtimeValues: { opaque: "keep-value" }, title: "Keep runtime choices", cwd: null,
    } });
    if (configured?.type !== "session") throw new Error("configured session was not created");
    await r.client.call({ type: "session.setModel", payload: { sessionId: configured.data.id, modelId: "fixture-alt" } });
    const kept = (await r.snapshot(configured.data.id)).summary;
    t.assertions.assert(kept.agentId === "ctl-normal" && kept.modeId === "keep-mode" && kept.fast === false && kept.runtimeValues?.opaque === "keep-value",
      "choosing a shared model discarded the current Agent's runtime choices");
    await r.client.call({ type: "session.setModel", payload: { sessionId: r.front, modelId: "fixture-alt" } });
    let current = (await r.snapshot(r.front)).summary;
    t.assertions.assert(current.agentId === "ctl-normal" && current.modelId === "fixture-alt", "shared model moved away from current owner");
    const profiles = ["ctl-accept-then-silent", "ctl-exit-without-terminal", "ctl-native-question"]
      .map(agentId => ({ agentId, modelId: agentId === "ctl-exit-without-terminal" ? "fixture" : "fixture-alt", tags: ["Pro"], cost: "low" as const }));
    await r.client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
      runtimes: {}, selectedTags: ["Pro"], disabledAgentIds: [], modelProfiles: [...profiles,
        { agentId: "ctl-normal", modelId: "fixture-alt", tags: ["Pro"], cost: "low" }], tagGroups: [],
    } } });
    // The current Agent is disallowed for fixture, but the first valid alternate is allowed.
    await r.client.call({ type: "session.setModel", payload: { sessionId: r.front, modelId: "fixture" } });
    current = (await r.snapshot(r.front)).summary;
    t.assertions.assert(current.modelId === "fixture" && current.agentId !== "ctl-normal", "no legal alternate owner selected");
    const spawned = r.ok(["spawn", "--kind", "research", "--desc", "explicit model", "--model", "fixture-alt", "research"], { TEAM_AGENT: "ctl-normal" });
    const id = /s_[0-9a-f]+/.exec(spawned)?.[0];
    t.assertions.assert(id && (await r.snapshot(id)).summary.modelId === "fixture-alt", "explicit template model ignored");
    for (const args of [["--tier", "Mini"], ["--tier", "Pro", "--model", "fixture"], ["--model", "fixture-alt", "--media", "image"]]) {
      const result = r.command(["spawn", "--kind", "research", "--desc", "invalid route", ...args, "research"]);
      t.assertions.assert(result.code !== 0 && result.err.includes("下一步"), `invalid template route was not actionable: ${result.err}`);
    }
  } finally { await r.dispose(); }
});
