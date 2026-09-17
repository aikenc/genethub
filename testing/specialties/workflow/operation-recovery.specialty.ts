import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

defineSpecialty({
  id: "specialty.workflow.operation-recovery.restart",
  title: "A lost Worker continues its original Session in the pinned Run",
  oracle: "A real daemon restart keeps the unfinished Worker Session; explicit recovery continues that Session without replaying the accepted predecessor or opening a second Run",
  catches: ["restart fences a resumable Worker", "recovery opens a second Worker identity", "accepted predecessor is replayed", "stale Run revision silently resumes"],
  tags: ["core", "workflow", "structured-workflow", "workflow-recovery"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client"],
  productInterfaces: ["genet workflow", "workflow.get", "workflow.check", "workflow.recover", "session.send"],
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
    const help = await cli(["schema", "workflow.recover"]);
    t.assertions.assert(help.includes("unfinished") && help.includes("revision"), "agent-facing recovery schema omitted its safety boundary");
    await cli(["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"]);
    const source = path.join(opened.workspaceRoot, ".genethub/workflow");
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "RECOVERY_WORKER: execute this operation and submit its own result.\n");
    writeFileSync(path.join(source, "workflows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker" }, completion: { all: [{ key: "done", verify: "value.nonEmpty" }] } }],
      structure: { body: { id: "delivery", type: "sequence", steps: [
        { id: "accepted-first", type: "task", activity: "work" },
        { id: "lost-second", type: "task", activity: "work" },
      ] } },
    }));
    const trace = path.join(opened.workspaceRoot, "recovery-trace.txt");
    let launched = false;
    const seen = new Set<string>();
    let retryReady = false;
    let retrySubmitted = false;
    opened.mock.script(...Array.from({ length: 30 }, () => ({ respond: (request: unknown) => {
      const text = JSON.stringify(request);
      if (text.includes("RECOVERY_WORKER")) {
        const operation = text.match(/当前节点：(operation-\d+)/)?.[1];
        if (!operation) throw new Error("worker prompt omitted operation identity");
        if (seen.has(operation) && (!retryReady || retrySubmitted)) return { text: "Waiting for the Run's next control decision." };
        const finish = '"$GENEHUB_CLI" workflow complete --evidence done=checked';
        const retry = seen.has(operation);
        seen.add(operation);
        if (retry) retrySubmitted = true;
        const command = !retry && seen.size === 2
          ? `printf '%s\n' ${operation} >> '${trace}'; sleep 18; ${finish}`
          : `printf '%s\n' ${operation} >> '${trace}'; ${finish}`;
        return { tool: { name: "bash", arguments: { command } } };
      }
      if (!launched) {
        launched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task recovery-case --no-wait --message "完成两步只读核对"' } } };
      }
      return { text: "I will inspect the Run facts before acting." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Execute the two-operation Workflow.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("workflow history unavailable");
      return reply.data;
    };
    let before: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      before = (await history())[0];
      return !!before && before.nodes.some(n => n.status === "completed")
        && before.nodes.some(n => n.status === "running")
        && existsSync(trace) && readFileSync(trace, "utf8").trim().split("\n").length === 2;
    }, 45_000);
    const firstId = before!.nodes.find(n => n.status === "completed")!.sessionId;
    const interruptedId = before!.nodes.find(n => n.status === "running")!.sessionId;
    opened.client.close();
    await cli(["daemon", "stop"]);
    await cli(["daemon", "start"]);
    opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    let recoverable: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      recoverable = (await history())[0];
      return recoverable?.status === "recoverable";
    }, 45_000);
    t.assertions.assert(recoverable!.nodes.find(n => n.sessionId === firstId)?.status === "completed", "accepted predecessor changed during restart");
    t.assertions.assert(recoverable!.nodes.find(n => n.sessionId === interruptedId)?.status === "interrupted", "unfinished Worker was not marked for continuation");
    const check = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId: recoverable!.id } });
    t.assertions.assert(check?.type === "workflowCheck" && check.data.findings.some(f => f.code === "recoverableOperation" && f.detail.includes("仍保留")), "PM did not receive a same-session recovery finding");
    const stale = await runGenetAsync(opened.daemon.genet, ["workflow", "recover", "--run", recoverable!.id, "--revision", String(recoverable!.revision - 1)], opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(stale.code !== 0, "stale recovery revision was accepted");
    retryReady = true;
    await cli(["workflow", "recover", "--run", recoverable!.id, "--revision", String(recoverable!.revision)]);
    let completed: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const runs = await history();
      t.assertions.assert(runs.length === 1, "recovery opened another Run");
      completed = runs[0];
      return completed?.status === "completed";
    }, 45_000);
    t.assertions.assert(completed!.id === before!.id, "recovery replaced the pinned Run");
    t.assertions.assert(completed!.nodes.find(n => n.sessionId === firstId)?.status === "completed", "accepted predecessor was replayed");
    const recovered = completed!.nodes.find(n => n.id === recoverable!.nodes.find(n => n.sessionId === interruptedId)!.id)!;
    t.assertions.assert(recovered.sessionId === interruptedId && recovered.status === "completed", "recovery replaced the original Worker Session");
    const effects = readFileSync(trace, "utf8").trim().split("\n");
    t.assertions.assert(effects.length === 3 && effects[0] !== effects[1] && effects[1] === effects[2], `operation effects differ: ${JSON.stringify(effects)}`);
    await new Promise(resolve => setTimeout(resolve, 19_000));
  } finally {
    opened.client.close();
    await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    await opened.mock.stop();
  }
});
