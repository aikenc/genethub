import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.missing-credentials",
    title: "A task with no credentials says so instead of failing silently",
    oracle: "turnFailed code is missingCredentials",
    catches: ["silent hang", "generic internal error"],
    tags: ["core", "session", "parity"],
    llm: { default: "none" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "Do something.");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnFailed"), 45_000);
      const failed = events.find((item) => item.type === "turnFailed");
      const error = (failed?.raw as { event?: { error?: { code?: string; message?: string } } })?.event?.error;
      t.assertions.assert(error?.code === "missingCredentials", `got ${error?.code}`);
      t.assertions.assert(Boolean(error?.message?.trim()), "credentials error has no message");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
