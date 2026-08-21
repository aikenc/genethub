import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.history-survives-restart",
    title: "History survives a daemon restart and the conversation continues",
    oracle: "session.get still has items after genet daemon stop/start on the same data dir",
    catches: ["history only in memory"],
    tags: ["core", "session", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 40_000,
    timeoutMs: 120_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["genet-cli", "@genehub/web/client"],
  },
  async (t) => {
    const first = await t.flows.main.completeVerifiableTask({
      openRoot: t.openRoot,
      lease: t.env,
      task: t.data.tasks.writeFile("result.txt", "DONE"),
    });
    const sessionId = first.sessionId;
    first.client.close();
    first.daemon.stop();
    await first.mock.stop();
    const second = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const listed = await second.client.call({ type: "workspace.list" });
      t.assertions.assert(
        listed?.type === "workspaces" && listed.data.some((item) => item.id === first.workspaceId),
        "workspace id changed across restart",
      );
      const got = await second.client.call({ type: "session.get", payload: { sessionId } });
      t.assertions.assert(
        got?.type === "snapshot" || got?.type === "session",
        `session.get returned ${got?.type}`,
      );
    } finally {
      second.client.close();
      second.daemon.stop();
      await second.mock.stop();
    }
  },
);
