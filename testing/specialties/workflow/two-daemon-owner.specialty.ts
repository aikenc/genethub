import { writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";

import { connectProductClient, createLease, daemonEndpoint, defineSpecialty, releaseLease, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.two-daemon-owner",
  title: "Two daemon channels share one project request and one writer",
  oracle: "A second daemon sees the same project Run, cannot mutate while the first holds its request lock, then takes ownership after the first stops and changes the same request budget",
  catches: ["channel-local workspace ids hide shared Runs", "two daemons write one request", "takeover loses the request or creates a duplicate Run"],
  tags: ["core", "workflow", "storage", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 35_000, timeoutMs: 100_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "filesystem"],
  productInterfaces: ["workflow.history", "workflow.cancel", "workflow.budget", "workspace.open"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const secondLease = createLease("genehub-workflow-second-channel-");
  const secondEnv = { ...opened.daemon.env, ...secondLease.env };
  let secondClient: Awaited<ReturnType<typeof connectProductClient>> | undefined;
  let secondStarted = false;
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/worker.md"), "SECOND_CHANNEL_WORKER: wait for an available Max route.\n");
    writeFileSync(path.join(source, "roles/worker.yaml"), JSON.stringify({
      schema: "genehub.workflow.role.v3", id: "worker", tags: ["Max"],
      userInteraction: "readOnly", prompt: "prompts/worker.md",
    }));
    writeFileSync(path.join(source, "flows/second-channel.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v1", id: "second-channel", version: 1, entry: "work",
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker", workspace: "." },
        completion: { all: [{ key: "result", verify: "value.nonEmpty" }] }, on: { completed: ["publish"] } },
        { id: "publish", uses: "result.publish" }],
    }));
    await opened.client.call({ type: "settings.setAgentPreferences", payload: { preferences: {
      runtimes: {}, selectedTags: ["Max"], modelProfiles: [{ agentId: "genet",
        modelId: "deepseek/deepseek-v4-flash", tags: ["Flush"], cost: "low" }],
    } } });
    let dispatched = false;
    opened.mock.script(...Array.from({ length: 12 }, () => ({ respond: () => {
      if (dispatched) return { text: "Waiting for the route." };
      dispatched = true;
      return { tool: { name: "bash", arguments: { command:
        '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow second-channel --task shared-request --message "deliver when available" --no-wait',
      } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Start the shared request.");
    let original: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      original = reply?.type === "workflowRuns" ? reply.data.find(run => run.taskId === "shared-request") : undefined;
      return original?.status === "blocked" && original.reason?.includes("RouteUnavailable");
    }, 30_000);

    const started = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], secondEnv);
    t.assertions.assert(started.code === 0, `second daemon failed: ${started.stderr || started.stdout}`);
    secondStarted = true;
    const secondHandle = { genet: opened.daemon.genet, env: secondEnv, stop() {} };
    secondClient = await connectProductClient(daemonEndpoint(secondHandle));
    const openedAgain = await secondClient.call({ type: "workspace.open", payload: { root: opened.workspaceRoot } });
    if (openedAgain?.type !== "workspace") throw new Error("second channel could not open the project");
    const secondWorkspaceId = openedAgain.data.id;
    t.assertions.assert(secondWorkspaceId !== opened.workspaceId, "fixture did not create independent channel identities");
    const history = async () => {
      const reply = await secondClient!.call({ type: "workflow.history", payload: { workspaceId: secondWorkspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("second channel history missing");
      return reply.data;
    };
    const shared = (await history()).find(run => run.id === original!.id);
    t.assertions.assert(shared?.workspaceId === secondWorkspaceId, "second channel did not project the shared Run to its local project id");
    let denial = "";
    try {
      await secondClient.call({ type: "workflow.cancel", payload: {
        workspaceId: secondWorkspaceId, runId: original!.id, expectedRevision: shared!.revision,
      } });
    } catch (error) {
      denial = String(error);
    }
    const beforeTakeover = (await history()).find(run => run.id === original!.id);
    t.assertions.assert(/writer|持锁|归属|owner|接管|另一个 daemon/i.test(denial)
      && beforeTakeover?.status === "blocked",
      `second channel changed a request still owned by the first daemon: denial=${denial}; status=${beforeTakeover?.status}`);

    opened.client.close();
    opened.daemon.stop();
    await t.tools.waitUntil(async () => {
      try {
        const reply = await secondClient!.call({ type: "workflow.budget", payload: {
          workspaceId: secondWorkspaceId, runId: original!.id, expectedRevision: 0,
          maxRuns: 4,
        } });
        return reply?.type === "workflowRun" && reply.data.requestBudget.maxRuns === 4;
      } catch { return false; }
    }, 30_000);
    const after = await history();
    t.assertions.assert(after.length === 1 && after[0]!.id === original!.id
      && after[0]!.requestBudget.revision === 1 && after[0]!.requestBudget.maxRuns === 4,
    "takeover lost the original request or repeated the budget mutation");
  } finally {
    secondClient?.close();
    if (secondStarted) await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], secondEnv);
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
    releaseLease(secondLease);
  }
});
