import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.model-rate-limited",
    title: "Model failures surface as actionable errors",
    oracle: "HTTP 429 from the mock LLM becomes turnFailed rateLimited",
    catches: ["hang on 429", "generic internal"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ status: 429 });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Go.");
      await t.tools.waitUntil(
        () => events.some((item) => item.type === "turnFailed" || item.type === "turnCompleted"),
        45_000,
      );
      const failed = events.find((item) => item.type === "turnFailed");
      const error = (failed?.raw as { event?: { error?: { code?: string } } })?.event?.error;
      t.assertions.assert(error?.code === "rateLimited", `got ${error?.code ?? events.map((item) => item.type).join(",")}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
