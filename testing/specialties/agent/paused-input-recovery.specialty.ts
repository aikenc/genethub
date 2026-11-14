import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineSpecialty, hideHostAgentClis, seedScriptAgentRuntime, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
defineSpecialty({
  id: "specialty.agent.paused-input-recovery",
  title: "An interrupted vendor success envelope cannot consume a paused input on restart",
  oracle: "native Stop preserves the same accepted input and pause across reload, the original message remains exactly once, canceled canonical execution beats a conflicting vendor summary, and no input is automatically retried",
  catches: ["restart marks canceled input handled from adapter success", "paused input disappears", "implicit resume or duplicate provider request", "actual completed input replayed"],
  tags: ["core", "agent", "session", "codebuddy", "input-recovery"], llm: { default: "none" },
  expectedDurationMs: 30_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "script-agent", "workbench-client", "filesystem"],
  productInterfaces: ["session.send", "session.interrupt", "session.inspect", "session.rounds", "agent.reload", "CodeBuddy stream-json"],
}, async t => {
  hideHostAgentClis(t.env); seedScriptAgentRuntime(t.env);
  const bin = path.join(t.env.data, "agents/state/codebuddy/npm/bin"); mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "cbc");
  copyFileSync(fileURLToPath(new URL("../../fixtures/codebuddy-continuation.cjs", import.meta.url)), executable);
  chmodSync(executable, 0o700);
  const journal = path.join(t.env.root, "cbc-paused-recovery.ndjson"), config = path.join(t.env.root, "cbc-paused-recovery.json");
  writeFileSync(config, JSON.stringify({ journal, silent: false, interruptSuccess: true }));
  t.env.env.GENEHUB_CBC_CONTINUATION = config;
  const opened: Opened[] = [];
  let current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
  const entries = () => existsSync(journal) ? readFileSync(journal,"utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x) as { event: string }) : [];
  const snapshot = async (id: string) => {
    const v = await current.client.call({ type: "session.get", payload: { sessionId: id } });
    if (v?.type !== "snapshot") throw new Error("missing native snapshot"); return v.data;
  };
  const rounds = async (id: string) => {
    const v = await current.client.call({ type: "session.rounds", payload: { sessionId: id, throughRoundId: null, cursor: null, limit: 100 } });
    if (v?.type !== "sessionRounds") throw new Error("missing canonical native rounds"); return v.data.rounds;
  };
  let phase = "initial completed input";
  try {
    await t.flows.branches.waitForAgent(current.client,"codebuddy",t.flows.branches.agentReady,{ timeoutMs: 30_000 });
    const made = await current.client.call({ type: "session.create", payload: { workspaceId: current.workspaceId, agentId: "codebuddy", modelId: "hy4std", modeId: "bypassPermissions", title: null, cwd: null } });
    if (made?.type !== "session") throw new Error("native Session creation failed"); const id=made.data.id;
    await t.flows.main.sendPrompt(current.client,id,"Complete this independent first request",null,"completed-once");
    await t.tools.waitUntil(async () => (await rounds(id)).some(x => x.outcome === "completed"),15_000);
    await current.client.call({ type: "agent.reload", payload: { agentId: "codebuddy" } });
    await t.flows.branches.waitForAgent(current.client,"codebuddy",t.flows.branches.agentReady);
    phase = "Stop while the real external continuation is preparing";
    await t.flows.main.sendPrompt(current.client,id,"Keep this original accepted request",null,"paused-original");
    await t.tools.waitUntil(() => entries().filter(x=>x.event==="user").length===2,15_000);
    await current.client.call({ type: "session.interrupt", payload: { sessionId: id } });
    await t.tools.waitUntil(async () => {
      const s=await snapshot(id);
      return s.summary.status==="idle" && s.summary.inputSummary?.paused===true
        && s.items.filter(x=>x.type==="turnSummary").length===2;
    },20_000);
    const before = await snapshot(id);
    t.assertions.assert(before.summary.inputSummary?.pendingMessageIds.includes("paused-original"),"Stop lost its accepted original input before reload");
    t.assertions.assert(before.items.filter(x=>x.type==="turnSummary" && x.stats.outcome==="completed").length===2,"interrupted request did not produce the conflicting vendor success envelope");
    const messages = before.items.filter(x=>x.type==="userMessage");
    phase = "native restart must not consume a canceled input";
    current.client.close(); current.daemon.stop();
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
    const after=await snapshot(id);
    t.assertions.assert(after.summary.inputSummary?.paused===true
      && after.summary.inputSummary.pendingMessageIds.includes("paused-original"),"restart consumed the canceled paused original input");
    t.assertions.assert(!after.summary.inputSummary?.pendingMessageIds.includes("completed-once"),"restart revived genuinely completed input");
    t.assertions.assert(JSON.stringify(after.items.filter(x=>x.type==="userMessage"))===JSON.stringify(messages),"reload changed or duplicated original accepted messages");
    const canceled=(await rounds(id)).find(x=>x.userItemId==="paused-original");
    t.assertions.assert(canceled?.outcome==="canceled","interrupted native execution was promoted to completed");
    const inspected=await current.client.call({ type:"session.inspect",payload:{sessionId:id,throughRoundId:null} });
    t.assertions.assert(inspected?.type==="sessionInspection" && inspected.data.retainedInputs?.some(x=>x.messageId==="paused-original" && x.state!=="handled"),"native receipt lost the pending delivery obligation");
    t.assertions.assert(entries().filter(x=>x.event==="user").length===2,"restart implicitly resumed paused input");
    phase = "compatibility with the old wrongly handled canceled receipt";
    current.client.close(); current.daemon.stop();
    // Explicit persisted-format compatibility fixture: actual native Stop and
    // canceled round above, with only the receipt state produced by old
    // recovery restored. No runtime function or execution outcome is mocked.
    const metaFile=path.join(current.workspaceRoot,".genethub/sessions",id,"meta.json");
    const meta=JSON.parse(readFileSync(metaFile,"utf8"));
    const receipt=meta.inbox.entries.find((x:{messageId:string})=>x.messageId==="paused-original");
    t.assertions.assert(receipt?.state==="sent" && meta.inbox.paused===true,"legacy fixture did not target the native retained input");
    receipt.state="handled";writeFileSync(metaFile,JSON.stringify(meta));
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
    const recovered=await snapshot(id);
    t.assertions.assert(recovered.summary.inputSummary?.paused===true
      && recovered.summary.inputSummary.pendingMessageIds.includes("paused-original")
      && !recovered.summary.inputSummary.pendingMessageIds.includes("completed-once"),"old canceled receipt was not repaired conservatively under pause");
    t.assertions.assert(JSON.stringify(recovered.items.filter(x=>x.type==="userMessage"))===JSON.stringify(messages)
      && entries().filter(x=>x.event==="user").length===2,"legacy repair replayed work or rewrote an original message");
    t.note("Native Stop, conflicting vendor summary and same-SID restart preserve paused input and immutable original messages; actual completed input stays complete. External protocol fixture mirrors the recorded Mac incident, without claiming a real provider acceptance test.");
  } catch(error) { throw new Error(`${phase}: ${error instanceof Error?error.message:String(error)}`); }
  finally { for(const w of opened)w.client.close();current.daemon.stop();for(const w of opened)await w.mock.stop(); }
});
