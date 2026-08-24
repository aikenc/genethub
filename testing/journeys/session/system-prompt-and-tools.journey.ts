import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineJourney, locateGenet } from "../../framework/public.ts";

defineJourney(
  {
    id: "journey.session.system-prompt-and-tools",
    title: "The agent hands the model a system prompt and tool definitions",
    oracle: "the mock LLM request has one GeneHub built-in Skill catalog, the bound CLI, the user text, and tool definitions",
    catches: ["empty tools", "user text dropped", "project Skill leaked into product catalog", "channel CLI guessed or duplicated"],
    tags: ["core", "session", "parity", "builtin-skills"],
    llm: { default: "mock" },
    expectedDurationMs: 25_000,
    timeoutMs: 75_000,
    surfaces: ["daemon", "agent", "workbench-client"],
    productInterfaces: ["@genehub/workbench/client"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const projectSkill = path.join(opened.workspaceRoot, ".genethub", "skills", "must-not-leak");
      await mkdir(projectSkill, { recursive: true });
      await writeFile(
        path.join(projectSkill, "SKILL.md"),
        "---\nname: must-not-leak\ndescription: Workspace data, not a GeneHub built-in\n---\n",
      );
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      opened.mock.script({ text: "ok" });
      const sessionId = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      const events = await t.flows.main.attachEventLog(opened.client, sessionId);
      await t.flows.main.sendPrompt(opened.client, sessionId, "a distinctive user request");
      await t.tools.waitUntil(() => events.some((item) => item.type === "turnCompleted"), 45_000);
      t.assertions.assert(opened.mock.requests.length >= 1, "the model was not called");
      const body = JSON.stringify(opened.mock.requests[0]);
      t.assertions.assert(body.includes("system") || body.includes("developer"), "no system prompt");
      t.assertions.assert(body.includes("a distinctive user request"), "the user's words must reach the model verbatim");
      for (const name of ["genehub-session-history", "genehub-speech-runtime"]) {
        const marker = `<name>${name}</name>`;
        t.assertions.assert(
          body.split(marker).length - 1 === 1,
          `${name} must appear in exactly one product catalog`,
        );
      }
      t.assertions.assert(!body.includes("must-not-leak"), "workspace .genethub/skills leaked into the product catalog");
      const cli = locateGenet(t.openRoot);
      t.assertions.assert(body.includes(`<genehub_cli>${cli}</genehub_cli>`), "the exact front-door CLI path is missing");
      for (const name of ["read", "write", "edit", "bash"]) {
        t.assertions.assert(body.includes(name), `${name} is missing from tool definitions`);
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
