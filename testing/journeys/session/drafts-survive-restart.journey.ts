import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.drafts-survive-restart",
    title: "Unsent session drafts survive restart and stay bounded",
    oracle: "session.drafts restores the ordered payload after restart and session.list reports its count",
    catches: ["drafts only in browser state", "session list count drift", "unbounded draft accumulation"],
    tags: ["core", "session"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const first = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const sessionId = await t.flows.main.createBuiltinSession(first.client, first.workspaceId);
    const drafts = [
      { id: "draft-1", text: "继续完善第一段", attachments: [] },
      { id: "draft-2", text: "补充验收说明", attachments: [] },
    ];
    try {
      const saved = await first.client.call({
        type: "session.drafts.replace",
        payload: { sessionId, drafts },
      });
      t.assertions.assert(saved?.type === "sessionDrafts" && saved.data.length === 2, "draft replace did not return two drafts");
      const listed = await first.client.call({
        type: "session.list",
        payload: { workspaceId: first.workspaceId, includeArchived: false },
      });
      t.assertions.assert(
        listed?.type === "sessions" && listed.data.find((item) => item.id === sessionId)?.draftCount === 2,
        "session list did not project the draft count",
      );
    } finally {
      first.client.close();
      first.daemon.stop();
      await first.mock.stop();
    }

    const second = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const restored = await second.client.call({ type: "session.drafts", payload: { sessionId } });
      t.assertions.assert(
        restored?.type === "sessionDrafts" && restored.data.map((item) => item.text).join("|") === "继续完善第一段|补充验收说明",
        "draft order or payload changed across restart",
      );
      let refused = false;
      try {
        await second.client.call({
          type: "session.drafts.replace",
          payload: {
            sessionId,
            drafts: Array.from({ length: 6 }, (_, index) => ({ id: `draft-${index}`, text: `${index}`, attachments: [] })),
          },
        });
      } catch {
        refused = true;
      }
      t.assertions.assert(refused, "daemon accepted more than five drafts");
    } finally {
      second.client.close();
      second.daemon.stop();
      await second.mock.stop();
    }
  },
);
