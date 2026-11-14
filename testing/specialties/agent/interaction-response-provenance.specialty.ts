import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PermissionOutcome } from "@genehub/proto";
import { defineSpecialty, registerControlledAgent, readControlledAgentJournal, type CaseContext } from "../../framework/public.ts";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

defineSpecialty({
  id: "specialty.agent.interaction-response-provenance",
  title: "Structured answers retain the authenticated responder across history and retries",
  oracle: "an actual other-Session CLI answer stays Agent-attributed, an authenticated user choice stays user-attributed even when retried by that Agent, both survive restart, and explicit legacy metadata absence is never backfilled from answer wording",
  catches: ["Agent answer presented as Human acceptance", "last question erases earlier typed decisions", "retry changes original actor/time", "old continuation invents verified provenance", "conflicting answer changes history"],
  tags: ["core", "agent", "session", "durable-interaction", "interaction-response-provenance"],
  llm: { default: "none" }, expectedDurationMs: 30_000, timeoutMs: 120_000,
  resources: { environments: 1, cpu: 1, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "script-agent", "real-cli", "workbench-client", "filesystem"],
  productInterfaces: ["genet session respond", "session.respondPermission", "session.narrative", "session.get"],
}, async t => {
  const questionAgent = registerControlledAgent(t.env, { id: "receipt-question", profile: "native-question", questionCount: 2 });
  const commandAgent = registerControlledAgent(t.env, { id: "receipt-command", profile: "cli-command" });
  const opened: Opened[] = [];
  let current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
  const create = async (agentId: string) => {
    await t.flows.branches.waitForAgent(current.client, agentId, t.flows.branches.agentReady, { timeoutMs: 30_000, what: "ready for native interaction provenance" });
    const reply = await current.client.call({ type: "session.create", payload: {
      workspaceId: current.workspaceId, agentId, modelId: null, modeId: null, cwd: null, title: null,
    } });
    if (reply?.type !== "session") throw new Error("could not create real native Session");
    return reply.data.id;
  };
  const state = async (sessionId: string) => {
    const reply = await current.client.call({ type: "session.get", payload: { sessionId } });
    if (reply?.type !== "snapshot") throw new Error("missing native Session snapshot");
    return reply.data;
  };
  const narrative = async (sessionId: string) => {
    const reply = await current.client.call({ type: "session.narrative", payload: { sessionId, itemId: null, throughRoundId: null, cursor: null, limit: 100 } });
    if (reply?.type !== "sessionNarrative") throw new Error("missing native narrative");
    return reply.data.items.filter(item => item.type === "userMessage");
  };
  const restart = async () => {
    current.client.close(); current.daemon.stop();
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
  };
  let phase = "creating native Sessions";
  try {
    const targetId = await create(questionAgent.agentId), agentId = await create(commandAgent.agentId);
    const agentRespond = async (requestId: string, option: string) => {
      const id = randomBytes(8).toString("hex");
      await t.flows.main.sendPrompt(current.client, agentId, JSON.stringify({ requestId: id,
        argv: [current.daemon.genet, "session", "respond", targetId, "--request", requestId, "--choose", option] }));
      let result: { requestId: string; code: number } | undefined;
      await t.tools.waitUntil(async () => {
        const snapshot = await state(agentId);
        for (const item of snapshot.items) {
          if (item.type !== "assistantMessage" || !item.text.startsWith("{")) continue;
          const reply = JSON.parse(item.text) as typeof result;
          if (reply?.requestId === id) result = reply;
        }
        return result !== undefined && snapshot.summary.status === "idle";
      }, 20_000);
      return result!.code;
    };
    phase = "other Session Agent answers first question";
    await t.flows.main.sendPrompt(current.client, targetId, "Ask two separate questions.");
    await t.tools.waitUntil(async () => (await state(targetId)).pendingPermissions.length === 1, 15_000);
    const first = (await state(targetId)).pendingPermissions[0]!;
    t.assertions.assert(await agentRespond(first.id, "b") === 0, "other Session could not answer a native question");
    await t.tools.waitUntil(async () => (await state(targetId)).pendingPermissions.some(item => item.id !== first.id), 15_000);
    const second = (await state(targetId)).pendingPermissions[0]!;
    phase = "user answers second question";
    // CLI --choose preserves the original typed Selected wire outcome;
    // browser structured/freeform Answered is independently covered there.
    const outcome: PermissionOutcome = { outcome: "selected", optionId: "a" };
    await current.client.call({ type: "session.respondPermission", payload: { sessionId: targetId, requestId: second.id, outcome } });
    await t.tools.waitUntil(async () => (await state(targetId)).summary.status === "idle", 15_000);
    const decisions = (await narrative(targetId)).filter(item => item.interactionResponse);
    const a = decisions.find(item => item.interactionResponse?.requestId === first.id);
    const b = decisions.find(item => item.interactionResponse?.requestId === second.id);
    t.assertions.assert(decisions.length === 2 && a?.interactionResponse?.kind === "question"
      && a.interactionResponse.responder.source === "agent" && a.interactionResponse.responder.origin.sessionId === agentId
      && a.origin?.sessionId === agentId && a.interactionResponse.outcome.outcome === "selected"
      && a.interactionResponse.outcome.optionId === "b", "Agent answer lost its exact native choice or origin");
    t.assertions.assert(b?.interactionResponse?.kind === "question" && b.interactionResponse.responder.source === "user"
      && !b.origin && JSON.stringify(b.interactionResponse.outcome) === JSON.stringify(outcome)
      && b.interactionResponse.decidedAtMs > 0, "user answer is missing native typed evidence");
    const prompts = readControlledAgentJournal(questionAgent).filter(entry => entry.event === "continuation-received");
    const agentHeader = prompts[0]?.responseHeader as string[] | undefined;
    const userHeader = prompts[1]?.responseHeader as string[] | undefined;
    t.assertions.assert(agentHeader?.[0].startsWith("Another Agent Session answered")
      && agentHeader[1]?.includes(agentId) && userHeader?.[0].startsWith("The user answered"),
      "resumed Agent received a false Human attribution or lost the actual Agent origin");
    const original = JSON.stringify(decisions);
    phase = "cross-actor identical retry and conflict";
    t.assertions.assert(await agentRespond(second.id, "a") === 0, "identical decision retry was not acknowledged");
    t.assertions.assert(JSON.stringify((await narrative(targetId)).filter(item => item.interactionResponse)) === original,
      "Agent retry changed the original user actor, decision time or item count");
    t.assertions.assert(await agentRespond(second.id, "b") !== 0, "conflicting decision was accepted");
    t.assertions.assert(JSON.stringify((await narrative(targetId)).filter(item => item.interactionResponse)) === original,
      "conflicting answer rewrote prior evidence");
    phase = "restart preserves all prior typed answers";
    await restart();
    t.assertions.assert(JSON.stringify((await narrative(targetId)).filter(item => item.interactionResponse)) === original,
      "restart lost or changed a previous typed answer");
    current.client.close(); current.daemon.stop();
    phase = "explicit legacy optional evidence migration";
    const home = path.join(current.workspaceRoot, ".genethub", "sessions", targetId);
    let removed = 0;
    const chat = path.join(home, "chat.jsonl");
    const legacy = readFileSync(chat, "utf8").split("\n").map(line => {
      if (!line.trim()) return line;
      const row = JSON.parse(line);
      if (row.item?.id === b!.id && row.item.interactionResponse) {
        delete row.item.interactionResponse; removed += 1; return JSON.stringify(row);
      }
      return line;
    }).join("\n");
    t.assertions.assert(removed === 1, "legacy fixture did not remove exactly one optional receipt");
    writeFileSync(chat, legacy);
    const metaPath = path.join(home, "meta.json"), meta = JSON.parse(readFileSync(metaPath, "utf8"));
    t.assertions.assert(meta.humanContinuation.request.id === second.id, "fixture targeted the wrong durable continuation");
    delete meta.humanContinuation.responder; writeFileSync(metaPath, JSON.stringify(meta));
    phase = "legacy decision retry must remain unclassified";
    current = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env }); opened.push(current);
    await current.client.call({ type: "session.respondPermission", payload: { sessionId: targetId, requestId: second.id, outcome } });
    const restored = await narrative(targetId);
    t.assertions.assert(restored.filter(item => item.interactionResponse).length === 1
      && restored.some(item => item.id === b!.id && !item.interactionResponse)
      && restored.find(item => item.id === a!.id)?.interactionResponse?.responder.source === "agent",
      "legacy text or an old continuation was promoted to verified user acceptance");
    t.note("Real Agent CLI and authenticated user choices retain exact independent receipts; cross-actor retry, conflict, restart and explicit legacy unknown verified. These isolated fixture choices are not real user acceptance of Team deliverables.");
  } catch (error) {
    throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const workspace of opened) workspace.client.close();
    current.daemon.stop();
    for (const workspace of opened) await workspace.mock.stop();
  }
});
