import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.command-output-bounded",
    title: "A command's output stays behind the access layer",
    oracle: "a bash seq 1 200000 turn completes without putting 200000 lines on the event stream",
    catches: ["full command transcript fanout"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 40_000,
    timeoutMs: 120_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: "seq 1 200000" } } },
        { text: "Done." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Print a lot.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 90_000);
      const blob = JSON.stringify(events);
      t.assertions.assert(blob.includes("bash") || blob.includes("seq"), "the command ran but left no card");
      t.assertions.assert(
        blob.length < 200_000 && !blob.includes("\n100000\n"),
        `the access layer streamed too much of seq (${blob.length} bytes)`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
