import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.session-input-delivery",
  title: "Public inspection separates queued inputs from the acknowledged handoff of every batched message",
  oracle: "Two real system notices stay queued under Human pause without delivery times, then both are handed to one real Agent turn; retry keeps the first times and historical inspection omits current receipts.",
  catches: ["queue admission mistaken for read-in", "only a batch's anchor records delivery", "retry rewrites the first handoff", "current input state leaks into a historical boundary"],
  tags: ["core", "session", "input-delivery"], llm: { default: "none" },
  productInterfaces: ["session.create", "session.interrupt", "session.send", "session.inspect", "session.rounds", "genet-cli"],
  surfaces: ["daemon", "filesystem", "workbench-client"],
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0 },
  expectedDurationMs: 12000, timeoutMs: 120000,
}, async t => {
  const r = await openTeam(t, "input-delivery-fixture");
  try {
    const sid = r.front;
    const inspect = async (throughRoundId: string | null = null) => {
      const reply = await r.client.call({ type: "session.inspect", payload: { sessionId: sid, throughRoundId } });
      if (reply?.type !== "sessionInspection") throw new Error("public inspection unavailable");
      return reply.data;
    };
    await r.client.call({ type: "session.interrupt", payload: { sessionId: sid } });
    await t.tools.waitUntil(async () => Boolean((await r.snapshot(sid)).summary.inputSummary?.paused), 10000);
    const ids: [string,string] = ["fixture.batch.first", "fixture.batch.second"];
    const send = async (id: string) => {
      const result = await runGenetAsync(r.daemon.genet, ["session", "send", sid, "A bounded system observation", "--system", "--message-id", id, "--no-wait"], r.env);
      t.assertions.assert(result.code === 0, "public system admission failed: " + result.stderr);
    };
    for (const id of ids) await send(id);
    const queued = await inspect();
    t.assertions.assert(queued.summary.inputSummary?.paused === true, "system input lifted Human pause");
    for (const id of ids) {
      const receipt = queued.retainedInputs?.find(x => x.messageId === id);
      t.assertions.assert(receipt?.state === "queued" && receipt.source === "system" && receipt.deliveredAtMs === undefined && receipt.turnId === undefined, "queued input claimed an Agent handoff");
    }
    await r.client.call({ type: "session.send", payload: { sessionId: sid, messageId: "fixture.person.resume", text: "Continue the bounded check", attachments: [], artifactPreviewBaseUrl: null, continuesRound: null } });
    await t.tools.waitUntil(async () => {
      const value = await inspect();
      return ids.every(id => typeof value.retainedInputs?.find(x => x.messageId === id)?.deliveredAtMs === "number")
        && value.summary.status === "idle" && !value.summary.inputSummary?.pendingMessageIds.length;
    }, 30000);
    const delivered = await inspect();
    const receipts = ids.map(id => {
      const receipt=delivered.retainedInputs?.find(x => x.messageId===id);
      if(!receipt)throw new Error("actual delivered receipt missing: "+id);
      return receipt;
    });
    const [first,second]=receipts;
    if(!first || !second)throw new Error("actual batch did not retain two receipts");
    t.assertions.assert(first.turnId === second.turnId && Boolean(first.turnId), "fixture did not exercise two inputs in one native turn");
    for (const receipt of receipts) {
      t.assertions.assert(receipt.deliveredAtMs! >= receipt.receivedAtMs && receipt.deliveredAtMs! <= Date.now(), "native handoff has an invalid temporal bound");
      t.assertions.assert(!("digest" in receipt) && !("text" in receipt), "inspection leaked an input body or admission digest");
    }
    const rounds = await r.client.call({ type: "session.rounds", payload: { sessionId: sid, throughRoundId: null, cursor: null, limit: 100 } });
    t.assertions.assert(rounds?.type === "sessionRounds" && rounds.data.rounds.filter(x => ids.includes(x.userItemId ?? "")).length === 1, "fixture did not prove the round anchor alone misses one delivered input");
    await send(ids[0]);
    const replayed = await inspect();
    t.assertions.assert(replayed.retainedInputs?.length === delivered.retainedInputs?.length
      && replayed.retainedInputs?.find(x => x.messageId === ids[0])?.deliveredAtMs === first.deliveredAtMs, "input retry changed its first handoff or duplicated a receipt");
    t.assertions.assert(Boolean(delivered.latestRoundId) && !("retainedInputs" in await inspect(delivered.latestRoundId!)), "historical inspection included current receipts");
  } finally { await r.dispose(); }
});
