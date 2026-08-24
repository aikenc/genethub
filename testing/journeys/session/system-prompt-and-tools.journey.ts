import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.system-prompt-and-tools",
    title: "The agent hands the model a system prompt and tool definitions",
    oracle: "the mock LLM request has a system message, the user text, and read/write/edit/bash tools",
    catches: ["empty tools", "user text dropped"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "a distinctive user request");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      t.assertions.assert(opened.mock.requests.length >= 1, "the model was not called");
      const body = JSON.stringify(opened.mock.requests[0]);
      t.assertions.assert(body.includes("system") || body.includes("developer"), "no system prompt");
      t.assertions.assert(body.includes("a distinctive user request"), "the user's words must reach the model verbatim");
      for (const name of ["read", "write", "edit", "bash"]) {
        t.assertions.assert(body.includes(name), `${name} is missing from tool definitions`);
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
