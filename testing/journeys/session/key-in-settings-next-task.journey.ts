import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.key-in-settings-next-task",
    title: "A key entered in settings makes the very next task work",
    oracle: "settings.setProvider then a write task lands result.txt without restarting the daemon",
    catches: ["key only takes effect after relaunch"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const before = await opened.client.call({ type: "settings.get" });
      t.assertions.assert(before?.type === "settings", `settings.get returned ${before?.type}`);
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const saved = await opened.client.call({ type: "settings.get" });
      t.assertions.assert(saved?.type === "settings", "settings disappeared after setProvider");
      const serialized = JSON.stringify(saved);
      t.assertions.assert(!serialized.includes("sk-test"), "the stored key was echoed back to the client");
      opened.mock.script(
        { tool: { name: "write", arguments: { path: "result.txt", content: "DONE" } } },
        { text: "Created." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(opened.client, sessionId, 'Write exactly "DONE" to result.txt and stop.');
      await t.tools.waitUntil(() => {
        try {
          t.assertions.fileEquals(opened.workspaceRoot, "result.txt", "DONE");
          return true;
        } catch {
          return false;
        }
      }, 45_000);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
