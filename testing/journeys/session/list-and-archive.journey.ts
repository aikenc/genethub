import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.list-and-archive",
    title: "Sessions list per workspace and can be archived",
    oracle: "session.list drops an archived session unless includeArchived is true",
    catches: ["global session list", "archive is a local flag"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const first = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions" && listed.data.length === 2, "expected two live sessions");
      await opened.client.call({
        type: "session.archive",
        payload: { sessionId: first, archived: true },
      });
      const live = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: false },
      });
      t.assertions.assert(live?.type === "sessions" && live.data.length === 1, "archived session still listed");
      t.assertions.assert(
        live?.type === "sessions" && !live.data.some((item) => item.id === first),
        "archived session still visible",
      );
      const all = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: opened.workspaceId, includeArchived: true },
      });
      t.assertions.assert(all?.type === "sessions" && all.data.length === 2, "includeArchived lost a session");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
