import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.log-readable",
    title: "The log can be read from whatever device saw the error",
    oracle: "log.tail returns daemon.log text written on disk",
    catches: ["log only on the host filesystem"],
    tags: ["core", "session", "parity"],
    expectedDurationMs: 20_000,
    timeoutMs: 60_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const logFile = path.join(t.env.data, "logs", "daemon.log");
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, "WARN claude: Invalid API key\n");
      const reply = await opened.client.call({ type: "log.tail", payload: { name: null } });
      t.assertions.assert(reply?.type === "log", `log.tail returned ${reply?.type}`);
      t.assertions.assert(
        reply?.type === "log" && reply.data.text.includes("Invalid API key"),
        `the log is missing what it was opened for: ${reply?.type === "log" ? reply.data.text.slice(-400) : reply?.type}`,
      );
      t.assertions.assert(reply?.type === "log" && reply.data.name === "daemon.log", "served a different log");
      t.assertions.assert(
        reply?.type === "log" && reply.data.files.some((file) => file.name === "daemon.log"),
        "the listing does not mention the file it just served",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
