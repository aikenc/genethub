import { readFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot } from "@genehub/proto";
import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.session.input-receipt-window",
  title: "Retired input receipts remain deduplicated by durable original chat identity",
  oracle: "After 300 handled original inputs, the delivery ledger stays bounded; retrying the oldest unchanged message emits no duplicate delivery event or model call, while changed content is refused",
  catches: ["receipt eviction replays completed Human work", "receipt history grows without a bound", "expired identity accepts changed content"],
  tags: ["core", "session", "pm-input"], llm: { default: "mock" },
  expectedDurationMs: 45000, timeoutMs: 120000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "workbench-client", "filesystem"],
  productInterfaces: ["session.send", "session.get"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script(...Array.from({ length: 100 }, () => ({ text: "已处理本批消息。" })));
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const events = await t.flows.main.attachEventLog(opened.client, sessionId);
    const send = (index: number, text = `独立消息 ${index}`) => opened.client.call({
      type: "session.send", payload: { sessionId, messageId: `receipt_${index}`, text,
        attachments: [], continuesRound: null },
    });
    const snapshot = async (): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("missing Session snapshot");
      return reply.data;
    };
    const settled = () => t.tools.waitUntil(async () => {
      const current = await snapshot();
      if (current.summary.inputSummary?.error) throw new Error(current.summary.inputSummary.error);
      return current.summary.status === "idle" && current.summary.inputSummary?.pendingMessageIds.length === 0;
    }, 30000);
    for (let first = 0; first < 300; first += 20) {
      for (let index = first; index < Math.min(first + 20, 300); index++) {
        const ack = await send(index);
        t.assertions.assert(ack?.type === "ack", "an original input was not durably accepted");
      }
      await settled();
    }
    const metaPath = path.join(opened.workspaceRoot, ".genethub", "sessions", sessionId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { inbox: { entries: Array<{ messageId: string }> } };
    t.assertions.assert(meta.inbox.entries.length <= 256, "handled delivery receipts exceeded their bounded window");
    t.assertions.assert(!meta.inbox.entries.some(entry => entry.messageId === "receipt_0"), "fixture did not exercise an expired receipt");
    const oldEvents = () => events.filter(event => {
      const inner = t.flows.main.sessionEventOf(event);
      return inner?.type === "item" && (inner.item as { id?: string } | undefined)?.id === "receipt_0";
    }).length;
    const before = oldEvents();
    const calls = opened.mock.requests.length;
    const duplicate = await send(0);
    t.assertions.assert(duplicate?.type === "ack", "unchanged durable original was not recognized");
    // The next completed input is a public dispatch barrier, not a timing sleep.
    await send(300);
    await settled();
    t.assertions.assert(oldEvents() === before, "expired receipt caused another delivery of an already handled original");
    t.assertions.assert(opened.mock.requests.length === calls + 1, "retry started an extra model call");
    let refused = false;
    try { await send(0, "用旧 ID 偷换的新目标"); }
    catch (error) { refused = String(error).includes("messageId"); }
    t.assertions.assert(refused, "expired message identity accepted changed content");
    t.note(`accepted=301 boundedReceipts=${meta.inbox.entries.length}; oldest unchanged identity deduplicated; changed content refused`);
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
