import type { SessionSnapshot } from "@genehub/proto";
import { defineSpecialty } from "../../framework/public.ts";

for (const count of [13, 1003]) defineSpecialty({
  id: count === 13 ? "specialty.agent.history-window" : "specialty.agent.history-window-thousand-rounds",
  title: "Recent-round snapshot preserves older history and content identity",
  oracle: "Completed user prompts remain reachable exactly once across a ten-round subscription and stable older-page cursor, including a new turn inserted between reads; rename does not create content",
  catches: ["frontend-only pagination", "cursor shifts when a new round arrives", "summary identity follows rename", "long messages lose their full content", "content preview disappears after restart"],
  tags: ["core", "history-window"], llm: { default: "mock" },
  expectedDurationMs: count === 13 ? 15000 : 180000, timeoutMs: count === 13 ? 180000 : 600000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 2, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "workbench-client"],
  productInterfaces: ["subscribe", "session.get", "session.narrative", "session.rename"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({openRoot: t.openRoot, lease: t.env});
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    opened.mock.script(...Array.from({length: count + 1}, (_, i) => ({text: `Answer ${i}`})));
    const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const log = await t.flows.main.attachEventLog(opened.client, sessionId);
    const longPrompt = "Message with large body " + "history-body ".repeat(3000);
    for (let i=0; i<count; i++) {
      await t.flows.main.sendPrompt(opened.client, sessionId, i===count-1 ? longPrompt : `Independent request ${i}`);
      await t.tools.waitUntil(() => log.filter(e => e.type === "turnCompleted").length === i+1, 45000);
    }
    const reader = await t.flows.main.openSecondClient(opened, "window-reader");
    try {
      const begun = performance.now();
      const result = await reader.subscribe(sessionId, {onEvent() {}, onResync() {}}, {recentRounds: 10, expandLastRound: false});
      const openMs = performance.now()-begun;
      const window = result.snapshot as SessionSnapshot;
      t.assertions.assert(window.historyWindowed === true && window.rounds?.length === 10, "subscribe did not window to ten business rounds");
      t.assertions.assert(window.items.filter(i => i.type === "userMessage").length === 10, "window omitted or added a user request");
      t.assertions.assert(Boolean(window.historyBefore), "earlier history is unreachable");
      const excerpt = window.historyExcerptIds?.[0];
      t.assertions.assert(Boolean(excerpt), "large message was transferred without an excerpt marker");
      const exact = await reader.call({type: "session.narrative", payload:{sessionId, itemId:excerpt!, throughRoundId:null, cursor:null, limit:null}});
      t.assertions.assert(exact?.type === "sessionNarrative" && exact.data.items.some(i => i.type === "userMessage" && i.text === longPrompt), "exact message lookup lost content");
      const full = await reader.call({type: "session.get",payload:{sessionId}});
      t.assertions.assert(full?.type === "snapshot" && full.data.items.filter(i => i.type === "userMessage").length === count, "legacy full snapshot was changed");
      const preview = window.summary.messagePreview;
      await reader.call({type:"session.rename",payload:{sessionId,title:"Renamed without new content"}});
      const renamed = await reader.call({type:"session.get",payload:{sessionId,recentRounds:10}});
      t.assertions.assert(renamed?.type === "snapshot" && JSON.stringify(renamed.data.summary.messagePreview) === JSON.stringify(preview), "rename changed the content cursor");
      await t.flows.main.sendPrompt(opened.client,sessionId,"Request arriving while reading history");
      await t.tools.waitUntil(() => log.filter(e => e.type === "turnCompleted").length === count+1,45000);
      const earlier = await reader.call({type:"session.get",payload:{sessionId,recentRounds:10,beforeItemId:window.historyBefore!}});
      t.assertions.assert(earlier?.type === "snapshot", "history page reply missing");
      if(earlier?.type !== "snapshot") return;
      const allItems = [...earlier.data.items, ...window.items];
      let cursor = earlier.data.historyBefore;
      while (cursor) {
        const older = await reader.call({type:"session.get",payload:{sessionId,recentRounds:10,beforeItemId:cursor}});
        t.assertions.assert(older?.type === "snapshot", "older history response missing");
        if (older?.type !== "snapshot") break;
        allItems.unshift(...older.data.items); cursor = older.data.historyBefore;
      }
      const users=allItems.filter(i=>i.type === "userMessage");
      t.assertions.assert(users.length===count && new Set(users.map(i=>i.id)).size===count, "concurrent append shifted the older page");
      opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
      const cold = await t.flows.main.openWorkspace({openRoot:t.openRoot,lease:t.env});
      try {
        const coldStart=performance.now();
        const restored=await cold.client.subscribe(sessionId,{onEvent(){},onResync(){}},{recentRounds:10,expandLastRound:false});
        const coldMs=performance.now()-coldStart;
        const snapshot=restored.snapshot as SessionSnapshot;
        t.assertions.assert(snapshot.rounds?.length===10 && snapshot.items.some(item=>item.type==="userMessage" && item.text==="Request arriving while reading history"), "cold open lost the latest window");
        t.assertions.assert(Boolean(snapshot.summary.messagePreview) && snapshot.items.some(item=>item.id===snapshot.summary.messagePreview?.itemId), "durable message preview was lost on restart");
        t.note(`snapshotBytes=${Buffer.byteLength(JSON.stringify(window))}; warmOpenMs=${Math.round(openMs)}; coldOpenMs=${Math.round(coldMs)}; userRequests=${count}; uniqueRequests=${users.length}`);
      } finally { cold.client.close(); cold.daemon.stop(); await cold.mock.stop(); }

    } finally { reader.close(); }
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
