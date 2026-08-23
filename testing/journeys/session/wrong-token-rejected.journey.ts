import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.wrong-token-rejected",
    title: "A connection without the token is rejected outright",
    oracle: "canonical Client without loopback proof or device credential never becomes ready",
    catches: ["anonymous peer is treated as local user"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const outcome = await t.flows.main.connectWithoutAdmission(opened.daemon);
      t.assertions.assert(outcome === "closed", "an unauthenticated Client became ready");
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
