import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.missing-session-not-found",
    title: "A request for a session that does not exist is answered with notFound",
    oracle: "session.get of a fake id is notFound rather than hanging",
    catches: ["unknown session waits forever"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.assertions.expectProtocolCode(
        () => opened.client.call({ type: "session.get", payload: { sessionId: "does-not-exist" } }),
        "notFound",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
