import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { defineJourney } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.cwd-stays-inside",
    title: "A session starts where it was told to and cannot be told to leave",
    oracle: "relative write lands in services/api, not the workspace root",
    catches: ["cwd ignored", "escape via cwd"],
    tags: ["core", "session", "filesystem", "parity"],
    llm: { default: "mock" },
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    expectedDurationMs: 30_000,
    timeoutMs: 90_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    mkdirSync(path.join(t.env.workspace, "services/api"), { recursive: true });
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script(
        { tool: { name: "write", arguments: { path: "result.txt", content: "DONE" } } },
        { text: "Created." },
      );
      const sessionId = await t.flows.main.createBuiltinSession(
        opened.client,
        opened.workspaceId,
        "services/api",
      );
      await t.flows.main.sendPrompt(
        opened.client,
        sessionId,
        'Write exactly "DONE" to result.txt and stop.',
      );
      await t.tools.waitUntil(() => {
        try {
          t.assertions.fileEquals(opened.workspaceRoot, "services/api/result.txt", "DONE");
          return true;
        } catch {
          return false;
        }
      }, 45_000);
      t.assertions.assert(
        !existsSync(path.join(opened.workspaceRoot, "result.txt")),
        "write escaped to the workspace root",
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
