import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.concurrency.slow-model-unrelated-reads",
    title: "A slow model turn does not stall unrelated daemon reads",
    oracle: "workspace.list from a second client returns in under 500ms while a delayed mock turn is in flight",
    catches: ["resident guest turn holds the whole daemon"],
    tags: ["core", "concurrency", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    const reader = await t.flows.main.openSecondClient(opened, "canary-read");
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "A deliberately slow model reply.", delayMs: 2_000 });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Wait for the model.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnStarted"), 20_000);
      const started = Date.now();
      const listed = await reader.call({ type: "workspace.list" });
      const elapsed = Date.now() - started;
      t.assertions.assert(listed?.type === "workspaces", `workspace.list returned ${listed?.type}`);
      t.assertions.assert(elapsed < 500, `unrelated read during slow model took ${elapsed}ms`);
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
    } finally {
      reader.close();
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
