import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineJourney, locateGenet } from "../../framework/public.ts";

async function regularFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(root, ...relative.split("/").filter(Boolean)), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await regularFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

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
      const sourceSkills = path.join(t.openRoot, "apps", "daemon", "builtin-skills");
      const installedSkills = path.join(t.env.data, "builtin-skills");
      const sourceFiles = await regularFiles(sourceSkills);
      for (const relative of sourceFiles) {
        const source = await readFile(path.join(sourceSkills, ...relative.split("/")));
        const installed = await readFile(path.join(installedSkills, ...relative.split("/")));
        t.assertions.assert(
          source.equals(installed),
          `built-in Skill resource was not embedded and materialized exactly: ${relative}`,
        );
      }
      const expectedEntrypoints = sourceFiles
        .filter((relative) => relative.split("/").length === 2 && relative.endsWith("/SKILL.md"))
        .sort();
      const expectedCommonEntrypoints = expectedEntrypoints.filter(
        (relative) => !relative.startsWith("genehub-pm-"),
      );
      const entrypoints = (await readFile(path.join(installedSkills, ".entrypoints"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      t.assertions.assert(
        JSON.stringify(entrypoints) === JSON.stringify(expectedCommonEntrypoints),
        "the common built-in Skill entrypoint manifest drifted from its source profile",
      );
      const projectManagerEntrypoints = (
        await readFile(path.join(installedSkills, ".entrypoints-project-manager"), "utf8")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      t.assertions.assert(
        JSON.stringify(projectManagerEntrypoints) === JSON.stringify(expectedEntrypoints),
        "the project-manager Skill entrypoint manifest drifted from the source tree",
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
      t.assertions.assert(!body.includes("genehub-pm-project-control"), "PM-only Skills leaked into a normal session");
      t.assertions.assert(!body.includes("project_manager_availability"), "PM-only availability policy leaked into a normal session");
      const cli = locateGenet(t.openRoot);
      t.assertions.assert(body.includes(`<genehub_cli>${cli}</genehub_cli>`), "the exact front-door CLI path is missing");
      for (const name of ["read", "write", "edit", "bash"]) {
        t.assertions.assert(body.includes(name), `${name} is missing from tool definitions`);
      }
      t.assertions.assert(
        body.includes('"name":"genehub"'),
        "the exact-argv GeneHub control tool is missing from the model tool definitions",
      );

      opened.mock.script({ text: "pm ok" });
      const createdPm = await opened.client.call({
        type: "pm.session.create",
        payload: {
          workspaceId: opened.workspaceId,
          modelId: "deepseek/deepseek-v4-flash",
          modeId: null,
          effortId: "medium",
          title: "Prompt profile probe",
        },
      });
      t.assertions.assert(createdPm?.type === "session", `pm.session.create returned ${createdPm?.type}`);
      if (createdPm?.type !== "session") return;
      const pmEvents = await t.flows.main.attachEventLog(opened.client, createdPm.data.id);
      await t.flows.main.sendPrompt(opened.client, createdPm.data.id, "inspect the PM system context");
      await t.tools.waitUntil(() => pmEvents.some((item) => item.type === "turnCompleted"), 45_000);
      const pmBody = JSON.stringify(opened.mock.requests.at(-1));
      for (const name of [
        "genehub-pm-project-control",
        "genehub-pm-agent-space-orchestration",
        "genehub-pm-quality-governance",
      ]) {
        const marker = `<name>${name}</name>`;
        t.assertions.assert(
          pmBody.split(marker).length - 1 === 1,
          `${name} must appear exactly once in the PM product catalog`,
        );
      }
      for (const policy of [
        "project_manager_availability",
        "必须随时可响应用户指导",
        "禁止套用 timeout",
        "daemon Supervisor 负责",
      ]) {
        t.assertions.assert(pmBody.includes(policy), `PM system context omitted ${policy}`);
      }
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
