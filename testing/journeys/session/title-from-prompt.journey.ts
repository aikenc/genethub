import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.title-from-prompt",
    title: "A session title comes from the first thing the user says",
    oracle: "titleChanged event and session.get title match the prompt",
    catches: ["daemon invented placeholder title"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok", delayMs: 1_500 });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const before = await opened.client.call({ type: "session.get", payload: { sessionId } });
      const beforeTitle =
        before?.type === "session"
          ? before.data.title
          : before?.type === "snapshot"
            ? before.data.summary.title
            : undefined;
      t.assertions.assert(!beforeTitle, `untitled session already named ${beforeTitle}`);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Fix the login redirect");
      await t.tools.waitUntil(() => events.some((item) => item.type === "titleChanged"), 20_000);
      await opened.client.call({ type: "session.interrupt", payload: { sessionId } });
      const after = await opened.client.call({ type: "session.get", payload: { sessionId } });
      const title =
        after?.type === "session"
          ? after.data.title
          : after?.type === "snapshot"
            ? after.data.summary.title
            : undefined;
      t.assertions.assert(title === "Fix the login redirect", `got ${title}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
