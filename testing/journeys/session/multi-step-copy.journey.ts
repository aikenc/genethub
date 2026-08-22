import { writeFileSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.multi-step-copy",
    title: "A multi-step task feeds tool results back until it finishes",
    oracle: "copy.txt matches source.txt after a read then a write",
    catches: ["one-shot write without read"],
    tags: ["core", "session", "filesystem", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    writeFileSync(path.join(t.env.workspace, "source.txt"), "the-secret-value");
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        { tool: { name: "read", arguments: { path: "source.txt" } } },
        { tool: { name: "write", arguments: { path: "copy.txt", content: "the-secret-value" } } },
        { text: "Copied." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        "Read source.txt and write its exact contents into copy.txt.",
      );
      await t.tools.waitUntil(() => {
        try {
          t.assertions.fileEquals(opened.workspaceRoot, "copy.txt", "the-secret-value");
          return true;
        } catch {
          return false;
        }
      }, 45_000);
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
