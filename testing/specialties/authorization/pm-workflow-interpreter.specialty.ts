import { readFileSync, writeFileSync } from "node:fs";

import { defineSpecialty, type CaseContext } from "../../framework/public.ts";

const MODEL = "deepseek/deepseek-v4-flash";

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;

function terminalCount(events: Array<{ type?: string }>): number {
  return events.filter((event) =>
    ["turnCompleted", "turnFailed", "turnCanceled"].includes(event.type ?? ""),
  ).length;
}

function completedCount(events: Array<{ type?: string }>): number {
  return events.filter((event) => event.type === "turnCompleted").length;
}

async function createPm(t: CaseContext): Promise<{
  opened: Opened;
  pmId: string;
  events: Array<{ type?: string; raw: unknown }>;
}> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  await t.flows.main.configureMockProvider(opened.client, opened.mock);
  const created = await opened.client.call({
    type: "pm.session.create",
    payload: {
      workspaceId: opened.workspaceId,
      modelId: MODEL,
      modeId: null,
      effortId: "medium",
      title: "Workflow interpreter fixture",
    },
  });
  t.assertions.assert(created?.type === "session", `pm.session.create returned ${created?.type}`);
  if (created?.type !== "session") throw new Error("PM Session creation failed");
  return {
    opened,
    pmId: created.data.id,
    events: await t.flows.main.attachEventLog(opened.client, created.data.id),
  };
}

async function runPmCommand(
  t: CaseContext,
  opened: Opened,
  pmId: string,
  events: Array<{ type?: string; raw: unknown }>,
  command: string,
): Promise<void> {
  const terminalsBefore = terminalCount(events);
  const completionsBefore = completedCount(events);
  opened.mock.script(
    { tool: { name: "bash", arguments: { command } } },
    { text: "The requested project-control operation completed." },
  );
  await t.flows.main.sendPrompt(opened.client, pmId, "Execute the prepared project-control operation exactly once.");
  await t.tools.waitUntil(() => terminalCount(events) === terminalsBefore + 1, 30_000);
  t.assertions.assert(
    completedCount(events) === completionsBefore + 1,
    `PM command did not complete: ${JSON.stringify(events.slice(-12))}`,
  );
}

function workflowPath(workspace: string): string {
  return `${workspace}/spaces/pm/skills/project-workflow/dcg/feature.yaml`;
}

const meta = (
  id: string,
  title: string,
  oracle: string,
  catches: string[],
) => ({
  id,
  title,
  oracle,
  catches,
  tags: ["core", "pm-agent-mvp", "workflow", "parity"],
  llm: { default: "mock" as const },
  resources: { environments: 1, cpu: 2, memoryMb: 1024, io: 1, browser: 0, pool: "standard" as const },
  expectedDurationMs: 45_000,
  timeoutMs: 180_000,
  surfaces: ["daemon", "agent", "workbench-client"],
  productInterfaces: ["genet-cli", "@genehub/workbench/client"],
});

defineSpecialty(
  meta(
    "specialty.authorization.pm-workflow-rejects-autonomous-cycle",
    "A project-authored Workflow cannot hide an unbounded autonomous cycle",
    "after the standard PM Space exists, the PM public project-control CLI reloads the user-edited Workflow catalog and rejects a closed system-only cycle before a Run can select it",
    [
      "Workflow validation exists only in a Rust source-near unit test",
      "an autonomous back edge can spin until the interpreter transition cap",
      "a terminal side branch makes a separate closed loop look safe",
    ],
  ),
  async (t) => {
    const { opened, pmId, events } = await createPm(t);
    try {
      writeFileSync(
        workflowPath(t.env.workspace),
        `schema: genehub-pm-dcg.v1
id: feature
kind: sessionWorkflow
version: 91
entry: choose
nodes:
  - { id: choose, kind: activity, executor: { actor: system } }
  - { id: delivered, kind: terminal, outcome: delivered }
  - { id: spin-a, kind: activity, executor: { actor: system } }
  - { id: spin-b, kind: activity, executor: { actor: system } }
edges:
  - { id: finish, from: choose, to: delivered, when: route.finish }
  - { id: enter-loop, from: choose, to: spin-a, when: route.loop }
  - { id: spin-forward, from: spin-a, to: spin-b, when: spin.forward }
  - { id: spin-again, from: spin-b, to: spin-a, when: spin.again, maxTraversals: 2 }
`,
      );
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        'if "$GENEHUB_CLI" pm project init > pm-invalid-workflow.log 2>&1; then exit 81; fi',
      );
      const diagnostic = readFileSync(`${t.env.workspace}/spaces/pm/pm-invalid-workflow.log`, "utf8");
      t.assertions.assert(
        diagnostic.includes("closed autonomous cycle") && diagnostic.includes("spin-a") && diagnostic.includes("spin-b"),
        `invalid Workflow was not rejected with bounded diagnostics: ${diagnostic}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);

defineSpecialty(
  meta(
    "specialty.authorization.pm-workflow-quorum-joins-late-sibling",
    "The public Workflow interpreter completes one forked quorum cohort without losing its late sibling",
    "a PM Session selects a project-authored system Workflow through the user request surface; one supervisor observation drives the persisted fork, quorum join and late sibling to a single terminal outcome visible in project status",
    [
      "fork/join fields parse but are ignored at runtime",
      "the first quorum marks the Run complete while a sibling is still active",
      "a late sibling creates a second join instance or leaves the Run stuck",
      "selected Run budget differs from the declared ten-minute envelope",
    ],
  ),
  async (t) => {
    const { opened, pmId, events } = await createPm(t);
    try {
      writeFileSync(
        workflowPath(t.env.workspace),
        `schema: genehub-pm-dcg.v1
id: feature
kind: sessionWorkflow
version: 92
entry: split
executionBudget:
  wallClockMs: 600000
  maxWorkSessions: 16
  maxConcurrentWorkSessions: 4
  maxLlmRequests: 128
nodes:
  - { id: split, kind: activity, executor: { actor: system }, fork: allEligible }
  - { id: left, kind: activity, executor: { actor: system } }
  - { id: middle, kind: activity, executor: { actor: system } }
  - { id: right, kind: activity, executor: { actor: system } }
  - { id: merge, kind: join, activation: { quorum: 2 } }
  - { id: delivered, kind: terminal, outcome: delivered }
edges:
  - { id: split-left, from: split, to: left, when: system.waiting }
  - { id: split-middle, from: split, to: middle, when: system.waiting }
  - { id: split-right, from: split, to: right, when: system.waiting }
  - { id: left-done, from: left, to: merge, when: system.waiting }
  - { id: middle-done, from: middle, to: merge, when: system.waiting }
  - { id: right-done, from: right, to: merge, when: system.waiting }
  - { id: merged, from: merge, to: delivered, when: join.ready }
`,
      );
      await runPmCommand(t, opened, pmId, events, '"$GENEHUB_CLI" pm project init');

      const selected = await opened.client.call({
        type: "pm.workflow.select",
        payload: { workspaceId: opened.workspaceId, sessionId: pmId, graphId: "feature" },
      });
      t.assertions.assert(selected?.type === "projectStatus", `workflow select returned ${selected?.type}`);
      await runPmCommand(
        t,
        opened,
        pmId,
        events,
        '"$GENEHUB_CLI" pm project observe --digest "fixture:quorum-join"',
      );

      const projected = await opened.client.call({
        type: "pm.project.status",
        payload: { workspaceId: opened.workspaceId },
      });
      t.assertions.assert(projected?.type === "projectStatus", `project status returned ${projected?.type}`);
      if (projected?.type !== "projectStatus") return;
      const run = projected.data.workflowRuns.find((item) => item.controllerSessionId === pmId);
      const instances = run?.nodeInstances ?? [];
      t.assertions.assert(
        run?.status === "completed" && run.outcome === "delivered" && run.activeNodes.length === 0,
        `forked Workflow did not reach one terminal outcome: ${JSON.stringify(run)}`,
      );
      t.assertions.assert(
        run?.graphVersion === 92 && run.budget?.wallClockMs === 600_000 && run.budget.maxConcurrentWorkSessions === 4,
        `selected Workflow did not pin its version and execution envelope: ${JSON.stringify(run?.budget)}`,
      );
      for (const nodeId of ["split", "left", "middle", "right", "merge", "delivered"]) {
        t.assertions.assert(
          instances.some((instance) => instance.nodeId === nodeId),
          `persisted Workflow omitted ${nodeId}: ${JSON.stringify(instances)}`,
        );
      }
      t.assertions.assert(
        instances.filter((instance) => instance.nodeId === "merge").length === 1 &&
          instances.filter((instance) => ["left", "middle", "right"].includes(instance.nodeId)).every(
            (instance) => instance.status === "completed",
          ),
        `quorum completion duplicated the join or stranded a sibling: ${JSON.stringify(instances)}`,
      );
    } finally {
      opened.client.close();
      opened.daemon.stop();
      await opened.mock.stop();
    }
  },
);
