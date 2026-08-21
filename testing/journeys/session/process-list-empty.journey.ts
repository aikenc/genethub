import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.process-list-empty",
    title: "An agent that left nothing running answers an empty process list",
    oracle: "process.list is empty and process.kill of pid 1 is notFound",
    catches: ["killing foreign pids", "invented process table"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 15_000,
    timeoutMs: 45_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const listed = await opened.client.call({ type: "process.list" });
      t.assertions.assert(listed?.type === "processes" && listed.data.length === 0, "process.list was not empty");
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "process.kill", payload: { sessionId, pid: 1 } }),
        "notFound",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
