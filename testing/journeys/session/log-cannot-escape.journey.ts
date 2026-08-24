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
        try {
          await opened.client.call({ type: "log.tail", payload: { name } });
          t.assertions.assert(false, `${name} was served`);
        } catch (error) {
          t.assertions.assert(error instanceof Error, `${name} did not fail`);
        }
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
