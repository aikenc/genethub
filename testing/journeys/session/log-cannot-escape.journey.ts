import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.log-cannot-escape",
    title: "A log request cannot reach outside the log directory",
    oracle: "log.tail of ../ paths fails",
    catches: ["log path traversal"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 15_000,
    timeoutMs: 45_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      for (const name of ["../config.json", "../../.ssh/id_rsa"]) {
        // The helper throws outside its catch if a request succeeds; neither
        // our assertion nor a transport disconnect may count as a refusal.
        await t.assertions.expectProtocolCode(
          () => opened.client.call({ type: "log.tail", payload: { name } }),
          "internal",
        );
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
