import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.recovery-human-wait",
  title: "An offline recovery decision remains answerable beyond thirty minutes",
  oracle: "After restart with an old pending question, the same recovery Worker remains waiting, does not spend LLM rounds, and a late Human answer completes its report once",
  catches: ["Human wait becomes a PM timeout", "restart loses the pending question", "late answer launches another review", "waiting consumes LLM rounds"],
  tags: ["core", "workflow", "workflow-recovery", "session-attention"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.activate", "workflow.history", "session.get", "session.respondPermission"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, `CLI failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "workflow.md"), "---\ndescription: asynchronous recovery decision\nrecovery: flows/recovery.yaml\n---\n");
    for (const [role, marker] of [["worker", "ASYNC_BUSINESS"], ["reviewer", "ASYNC_REVIEWER"]]) {
      writeFileSync(path.join(source, `roles/${role}.yaml`), JSON.stringify({
        schema: "genehub.workflow.role.v3", id: role, tags: ["Flash"], userInteraction: role === "reviewer" ? "normal" : "readOnly", prompt: `prompts/${role}.md`,
      }));
      writeFileSync(path.join(source, `prompts/${role}.md`), `${marker}: follow the assigned task.\n`);
    }
    for (const [name, role] of [["business", "worker"], ["recovery", "reviewer"]]) {
      writeFileSync(path.join(source, `flows/${name}.yaml`), JSON.stringify({
        schema: "genehub.workflow.definition.v2", id: name, version: 2,
        nodes: [{ id: "work", uses: "agent.session", with: { role }, completion: { all: [{ key: "report", verify: "value.nonEmpty" }] } }, { id: "publish", uses: "result.publish" }],
        structure: { body: { id: "delivery", type: "sequence", steps: [
          { id: "inspect", type: "task", activity: "work" }, { id: "done", type: "task", activity: "publish" },
        ] } },
      }));
    }
    await cli(["workflow", "activate", "--revision", "0"]);
    let dispatched = false, failed = false, asked = false, submitted = false;
    opened.mock.script(...Array.from({ length: 50 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("ASYNC_BUSINESS")) {
        if (failed) return { text: "The original failure is recorded." };
        failed = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome blocked --reason "needs review" --evidence report=failed' } } };
      }
      if (body.includes("ASYNC_REVIEWER")) {
        if (!asked) {
          asked = true;
          return { tool: { name: "request_user_input", arguments: { title: "复查决定", summary: "共 1 个待回答问题。", description: "请确认复查后的下一步；答复后继续原任务。", questions: [{ id: "review", header: "复查", question: "Confirm the reviewed next step when you return.", options: [
            { label: "continue", description: "Publish the diagnostic report" }, { label: "stop", description: "Keep this decision pending" },
          ] }] } } };
        }
        if (!submitted) {
          submitted = true;
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence report=reviewed-after-wait' } } };
        }
        return { text: "The report is saved." };
      }
      if (!dispatched) {
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow business --task async-wait --message "deliver" --no-wait' } } };
      }
      return { text: "The user goal remains open." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Start the asynchronous decision case.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("history unavailable");
      return reply.data;
    };
    const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
      if (reply?.type !== "snapshot") throw new Error("recovery Session unavailable");
      return reply.data;
    };
    let recovery: WorkflowRunStatus | undefined, reviewer = "", question = "";
    await t.tools.waitUntil(async () => {
      recovery = (await history()).find(run => run.handles.length > 0);
      reviewer = recovery?.nodes.find(node => node.sessionId)?.sessionId ?? "";
      if (!reviewer) return false;
      question = (await snapshot(reviewer)).pendingPermissions[0]?.id ?? "";
      return Boolean(question);
    }, 45_000);
    const session = await snapshot(reviewer);
    const spaces = await opened.client.call({ type: "workspace.list" });
    if (spaces?.type !== "workspaces") throw new Error("workspace listing unavailable");
    const root = spaces.data.find(space => space.id === session.summary.workspaceId)?.root;
    t.assertions.assert(Boolean(root), "recovery workspace has no durable root");
    opened.client.close();
    await cli(["daemon", "stop"]);
    const metaPath = path.join(root!, ".genethub/sessions", reviewer, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.updatedAtMs = Date.now() - 48 * 60 * 60 * 1000;
    writeFileSync(metaPath, JSON.stringify(meta));
    await cli(["daemon", "start"]);
    opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    await t.tools.waitUntil(async () => (await snapshot(reviewer)).pendingPermissions.some(item => item.id === question), 20_000);
    await t.tools.waitUntil(async () => (await history()).find(run => run.id === recovery!.id)?.supervision?.waiting === true, 15_000);
    const beforeRequests = opened.mock.requests.filter(request => JSON.stringify(request).includes("ASYNC_REVIEWER")).length;
    // Two real patrol periods must see the pending question, rather than merely
    // inspecting the snapshot immediately after restart.
    await new Promise(resolve => setTimeout(resolve, 11_000));
    const after = (await history()).find(run => run.id === recovery!.id)!;
    const pending = await snapshot(reviewer);
    t.assertions.assert(after.status === "running" && !after.reason && pending.pendingPermissions.some(item => item.id === question),
      "elapsed Human wait failed the recovery or replaced its question");
    t.assertions.assert(after.supervision?.waiting === true && opened.mock.requests.filter(request => JSON.stringify(request).includes("ASYNC_REVIEWER")).length === beforeRequests,
      "whole recovery wait consumed LLM rounds");
    const answer = await opened.client.call({ type: "session.respondPermission", payload: {
      sessionId: reviewer, requestId: question, outcome: { outcome: "answered", answers: pending.pendingPermissions.find(item => item.id === question)!.questions!.map(item => ({ questionId: item.id, selectedOptionIds: [item.options[0]!.id] })) },
    } });
    t.assertions.assert(answer?.type === "ack", "late Human answer was rejected");
    await t.tools.waitUntil(async () => (await history()).find(run => run.id === recovery!.id)?.status === "completed", 30_000);
    const runs = await history();
    t.assertions.assert(runs.length === 2 && runs.filter(run => run.handles.length > 0).length === 1 && submitted,
      "late answer repeated diagnosis instead of finishing the original report");
  } finally {
    opened.client.close(); opened.daemon.stop(); await opened.mock.stop();
  }
});
