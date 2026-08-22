import { mkdirSync } from "node:fs";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty(
  {
    id: "specialty.concurrency.parallel-sessions",
    title: "Two sessions in two workspaces complete without mixing turns",
    oracle: "two in-flight genet turns each complete with exactly one turnStarted on their own subscribe",
    catches: ["shared session state mixing two workspaces"],
    tags: ["core", "concurrency", "parity"],
    llm: { default: "mock" },
    expectedDurationMs: 30_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "workbench-client"],
    productInterfaces: ["@genehub/web/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "one", delayMs: 200 }, { text: "two", delayMs: 200 });
      const secondRoot = `${t.env.workspace}-b`;
      mkdirSync(secondRoot, { recursive: true });
      const extra = await opened.client.call({ type: "workspace.open", payload: { root: secondRoot } });
      t.assertions.assert(extra?.type === "workspace", `workspace.open returned ${extra?.type}`);
      const secondId = extra?.type === "workspace" ? extra.data.id : "";
      const first = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const second = await t.flows.main.createBuiltinSession(opened.client, secondId);
      const firstEvents = await t.flows.main.attachEventLog(opened.client, first);
      const secondEvents = await t.flows.main.attachEventLog(opened.client, second);
      await t.flows.main.sendPrompt(opened.client, first, "Say something.");
      await t.flows.main.sendPrompt(opened.client, second, "Say something.");
      await t.tools.waitUntil(
        () =>
          firstEvents.some((item) => item.type === "turnCompleted") &&
          secondEvents.some((item) => item.type === "turnCompleted"),
        45_000,
      );
      t.assertions.assert(
        firstEvents.filter((item) => item.type === "turnStarted").length === 1,
        `first session saw extra turns: ${JSON.stringify(firstEvents.map((item) => item.type))}`,
      );
      t.assertions.assert(
        secondEvents.filter((item) => item.type === "turnStarted").length === 1,
        `second session saw extra turns: ${JSON.stringify(secondEvents.map((item) => item.type))}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
