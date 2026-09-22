import { writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";

import { defineSpecialty } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.runtime-route-failover",
  title: "A failed Workflow model falls through without replacing its Worker",
  oracle:
    "A 429 from the cheapest tag match excludes that exact route, migrates the same managed Session to the next live cost match, and completes the same node",
  catches: [
    "runtime model failure retries the same exhausted route",
    "failover opens a second Worker Session or replays the Workflow",
    "a higher-cost matching model is ignored",
    "route migration loses the managed completion contract",
  ],
  tags: ["core", "workflow", "workflow-recovery", "tag-routing"],
  llm: { default: "mock" },
  expectedDurationMs: 30_000,
  timeoutMs: 120_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["session.send", "session.get", "workflow.history", "settings.agentPreferences"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await opened.client.call({
      type: "settings.setAgentPreferences",
      payload: {
        preferences: {
          runtimes: {},
          selectedTags: ["图片理解"],
          modelProfiles: [
            {
              agentId: "genet",
              modelId: "deepseek/deepseek-v4-flash",
              tags: ["图片理解"],
              cost: "low",
            },
            {
              agentId: "genet",
              modelId: "deepseek/deepseek-v4-pro",
              tags: ["图片理解"],
              cost: "high",
            },
          ],
        },
      },
    });

    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "RUNTIME_ROUTE_FAILOVER_WORKER: complete this exact node.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v3",
      id: "worker",
      tags: ["图片理解"],
      userInteraction: "readOnly",
      prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/runtime-failover.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1",
      id: "runtime-failover",
      version: 1,
      entry: "work",
      nodes: [
        {
          id: "work",
          uses: "agent.session",
          with: { role: "worker", workspace: ".", writeLease: { ttlSeconds: 3600 } },
          completion: { all: [{ key: "done", verify: "value.nonEmpty" }] },
          on: { completed: ["publish"] },
        },
        { id: "publish", uses: "result.publish" },
      ],
    }));

    let dispatched = false;
    let flashWorkerRequests = 0;
    let backupWorkerRequests = 0;
    let backupSubmitted = false;
    const beforeFailover = path.join(opened.workspaceRoot, "runtime-before-failover.txt");
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const respond = (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("RUNTIME_ROUTE_FAILOVER_WORKER")) {
        const model = (request as { model?: unknown }).model;
        if (model === "deepseek-v4-flash") {
          flashWorkerRequests += 1;
          if (flashWorkerRequests === 1) {
            return {
              tool: {
                name: "bash",
                arguments: { command: `printf preserved > ${shellQuote(beforeFailover)}` },
              },
            };
          }
          return { status: 429 };
        }
        if (model === "deepseek-v4-pro") {
          backupWorkerRequests += 1;
          if (!backupSubmitted) {
            backupSubmitted = true;
            return {
              tool: {
                name: "bash",
                arguments: {
                  command: `test "$(cat ${shellQuote(beforeFailover)})" = preserved && "$GENEHUB_CLI" workflow complete --evidence done=rerouted`,
                },
              },
            };
          }
          return { text: "The migrated Worker submitted the original node." };
        }
        throw new Error(`Worker request omitted the selected model (${String(model)}): ${body.slice(0, 1000)}`);
      }
      if (!dispatched) {
        dispatched = true;
        return {
          tool: {
            name: "bash",
            arguments: {
              command: '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow runtime-failover --task runtime-failover --no-wait --message "验证运行时模型失效自动切换"',
            },
          },
        };
      }
      return { text: "Workflow status is tracked by the daemon." };
    };
    opened.mock.script(...Array.from({ length: 40 }, () => ({ respond })));

    const rootSession = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, rootSession, "Run the failover Workflow.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({
        type: "workflow.history",
        payload: { workspaceId: opened.workspaceId, limit: 10 },
      });
      if (reply?.type !== "workflowRuns") throw new Error("workflow history unavailable");
      return reply.data;
    };

    let originalWorkerId: string | undefined;
    await t.tools.waitUntil(async () => {
      const run = (await history())[0];
      originalWorkerId = run?.nodes.find(node => node.uses === "agent.session")?.sessionId;
      return flashWorkerRequests > 1 && !!originalWorkerId;
    }, 40_000);

    let completed: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const runs = await history();
      t.assertions.assert(runs.length === 1, "failover opened another Workflow Run");
      completed = runs[0];
      return completed?.status === "completed";
    }, 70_000);
    const worker = completed!.nodes.find(node => node.uses === "agent.session");
    t.assertions.assert(worker?.sessionId === originalWorkerId, "failover replaced the managed Worker Session");
    t.assertions.assert(worker?.status === "completed", `same node did not complete: ${JSON.stringify(worker)}`);
    t.assertions.assert(flashWorkerRequests >= 1, "cheapest route was not exercised");
    t.assertions.assert(backupWorkerRequests >= 1, "next matching model was not exercised");
    t.assertions.fileEquals(opened.workspaceRoot, "runtime-before-failover.txt", "preserved");

    const snapshotReply = await opened.client.call({ type: "session.get", payload: { sessionId: originalWorkerId! } });
    t.assertions.assert(snapshotReply?.type === "snapshot", "migrated Worker Session is unreadable");
    const snapshot = snapshotReply!.data as SessionSnapshot;
    t.assertions.assert(
      snapshot.summary.agentId === "genet" && snapshot.summary.modelId === "deepseek/deepseek-v4-pro",
      `Worker did not retain the replacement route: ${snapshot.summary.agentId}/${snapshot.summary.modelId}`,
    );
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
});
