import { defineJourney } from "../../framework/public.ts";

defineJourney({
  id: "journey.session.automatic-capsule",
  title: "A full provider context automatically becomes a durable daemon capsule",
  oracle: "A second real agent turn reaches the same endpoint with historical capsule and current prompt, without a summarizer request",
  catches: ["agent ignores configured context window", "capsule loses closed history", "automatic compaction drops current input", "capsule introduces an extra LLM round"],
  tags: ["core", "session", "product-journey", "refactor-capsule"],
  llm: { default: "mock" }, expectedDurationMs: 25000, timeoutMs: 90000,
  surfaces: ["daemon", "agent", "workbench-client"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client", "daemon-protocol"],
}, async t => {
  const o = await t.flows.main.openWorkspace({openRoot:t.openRoot, lease:t.env});
  try {
    await t.flows.main.configureMockProvider(o.client, o.mock);
    const sessionId = await t.flows.main.createBuiltinSession(o.client, o.workspaceId);
    const events = await t.flows.main.attachEventLog(o.client, sessionId);
    o.mock.script({text:"CLOSED_HISTORY_MARKER", usage:{inputTokens:500000}}, {text:"CURRENT_ANSWER_MARKER"});
    await t.flows.main.sendPrompt(o.client, sessionId, "Keep CLOSED_REQUEST_MARKER in history");
    await t.tools.waitUntil(() => events.some(e => JSON.stringify(e).includes("turnCompleted")), 30000);
    events.length = 0;
    await t.flows.main.sendPrompt(o.client, sessionId, "Answer CURRENT_REQUEST_MARKER after making room");
    await t.tools.waitUntil(() => events.some(e => JSON.stringify(e).includes("turnCompleted")), 30000);
    t.assertions.assert(o.mock.requests.length === 2, "automatic capsule made a summarizer request or lost a turn");
    const request = JSON.stringify(o.mock.requests[1]);
    t.assertions.assert(request.includes("CLOSED_HISTORY_MARKER") && request.includes("CURRENT_REQUEST_MARKER"), "capsule lost closed history or current input");
    t.assertions.assert(JSON.stringify(events).includes("compaction"), "no automatic compaction reached the client timeline");
  } finally { o.client.close(); o.daemon.stop(); await o.mock.stop(); }
});
