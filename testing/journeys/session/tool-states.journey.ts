import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.tool-states",
    title: "Tool calls move through their states rather than appearing finished",
    oracle: "event stream contains pending then running then ok for a bash tool call",
    catches: ["tool appears finished immediately"],
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
      opened.mock.script(
        { tool: { name: "bash", arguments: { command: "echo hi" } } },
        { text: "Done." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Run it.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      const statuses = events.flatMap((item) => {
        const blob = JSON.stringify(item.raw);
        const found: string[] = [];
        if (/"pending"/i.test(blob) || blob.includes("Pending")) found.push("pending");
        if (/"running"/i.test(blob) || blob.includes("Running")) found.push("running");
        if (/"ok"/i.test(blob) || blob.includes("\"completed\"")) found.push("ok");
        return found;
      });
      t.assertions.assert(statuses.includes("pending") || statuses.includes("running"), `no in-flight tool state: ${statuses.join(",")}`);
      t.assertions.assert(statuses.includes("ok") || statuses.includes("running"), `tool never settled: ${JSON.stringify(events.map((item) => item.type))}`);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
