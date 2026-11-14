import { defineSpecialty, openTeam, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.daemon.session-active-input-summary",
  title: "Input already handed to an active Agent is not shown as waiting delivery; pause retains retry obligations",
  oracle: "A real native acknowledged input stays sent in durable inspection while absent from pending delivery IDs; a real system input queued behind that round remains pending. Interrupt preserves both originals and exposes the sent retry until recovery, without dropping or rewriting any receipt.",
  catches: ["acknowledged active input still shown undelivered", "queued notice hidden with active inputs", "summary fix discards original retry", "system input clears pause"],
  tags: ["core", "session", "input-delivery"], llm: { default: "none" },
  productInterfaces: ["session.create", "session.get", "session.inspect", "session.send", "session.interrupt", "genet-cli"],
  surfaces: ["daemon", "workbench-client"], requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  requirements: [{ kind: "python", env: "GENEHUB_PYTHON", minVersion: [3, 7], modules: [] }],
  resources: { environments: 1, cpu: 1, memoryMb: 512, io: 1, browser: 0 }, expectedDurationMs: 10000, timeoutMs: 60000,
}, async t => {
  const r=await openTeam(t,"active-input-summary");
  try {
    const sid=await r.create("ctl-accept-then-silent"),active="human.already-read",queued="notice.not-yet-read";
    const inspect=async()=>{const reply=await r.client.call({type:"session.inspect",payload:{sessionId:sid,throughRoundId:null}});if(reply?.type!=="sessionInspection")throw Error("actual input inspection unavailable");return reply.data;};
    await r.client.call({type:"session.send",payload:{sessionId:sid,messageId:active,text:"Keep working on this bounded native check.",attachments:[],artifactPreviewBaseUrl:null,continuesRound:null}});
    await t.tools.waitUntil(async()=>{const v=await inspect();return v.summary.status==="running"&&typeof v.retainedInputs?.find(x=>x.messageId===active)?.deliveredAtMs==="number";},15000);
    const delivered=(await inspect()).retainedInputs?.find(x=>x.messageId===active);
    t.assertions.assert(!(await r.snapshot(sid)).summary.inputSummary?.pendingMessageIds.includes(active),"already handed-off active input is still displayed as pending delivery");
    const notice=await runGenetAsync(r.daemon.genet,["session","send",sid,"Wait until the current work finishes","--system","--message-id",queued,"--no-wait"],r.env);
    t.assertions.assert(notice.code===0,"system input admission failed: "+notice.stderr);
    const waiting=await inspect();
    t.assertions.assert(waiting.summary.inputSummary?.pendingMessageIds.includes(queued)&&!waiting.summary.inputSummary.pendingMessageIds.includes(active)
      &&waiting.retainedInputs?.find(x=>x.messageId===active)?.state==="sent"&&waiting.retainedInputs.find(x=>x.messageId===queued)?.state==="queued","summary hid real queued work or changed the delivery ledger");
    await r.client.call({type:"session.interrupt",payload:{sessionId:sid}});
    await t.tools.waitUntil(async()=>(await r.snapshot(sid)).summary.inputSummary?.paused===true,10000);
    const paused=await inspect(),retry=paused.retainedInputs?.find(x=>x.messageId===active);
    t.assertions.assert(paused.summary.inputSummary?.pendingMessageIds.includes(active)&&paused.summary.inputSummary.pendingMessageIds.includes(queued)
      &&retry?.state==="sent"&&retry.deliveredAtMs===delivered?.deliveredAtMs&&retry.source==="user"
      &&paused.retainedInputs?.find(x=>x.messageId===queued)?.source==="system","pause discarded a retry, changed its first handoff or lost queued source attribution");
  } finally { await r.dispose(); }
});
