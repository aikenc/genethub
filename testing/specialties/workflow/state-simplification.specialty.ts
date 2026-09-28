import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty, runGenetAsync } from "../../framework/public.ts";

for (const mode of ["parallel", "cancel", "report"] as const) defineSpecialty({
  id: `specialty.workflow.state-simplification.${mode}`,
  title: `Workflow execution facts remain independent: ${mode}`,
  oracle: "Real Workers can settle beside an interrupted sibling; repeated interruption has a new durable identity, cancellation prevents continuation, and a recovery report finishes without rewriting the failed business program or granting WR control authority",
  catches: ["a sibling interruption rejects valid completion", "polling invents another fault", "cancelled execution resumes", "a recovery report waits forever for PM", "WR acquires PM authority", "accepted sibling effects are replayed"],
  tags: ["core", "workflow", "workflow-state-simplification"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem"],
  productInterfaces: ["workflow.get", "workflow.history", "workflow.recover", "workflow.cancel", "genet workflow complete", "genet workflow deliver"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "STATE_FACT_WORKER: perform only this operation.\n");
    const parallel = mode !== "report";
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "work", uses: "agent.session", with: { role: "worker" }, completion: { all: [{ key: "done", verify: "value.nonEmpty" }] } }],
      structure: { body: parallel ? { id: "team", type: "parallel", branches: [
        { id: "lost", type: "task", activity: "work", input: { op: "literal", value: "LOSS_BRANCH" } },
        { id: "sibling", type: "task", activity: "work", input: { op: "literal", value: "SIBLING_BRANCH" } },
      ] } : { id: "business", type: "task", activity: "work" } },
    }));
    let dispatched = false, siblingStarted = false, businessFailed = false, reportSubmitted = false;
    let lostStage = 0, lastLostRequest = "", finalSent = false;
    const bash = (command: string) => ({ tool: { name: "bash", arguments: { command } } });
    opened.mock.script(...Array.from({ length: 90 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request);
      if (body.includes("STATE_FACT_WORKER")) {
        if (mode === "report") {
          if (businessFailed) return { text: "Failure already submitted." };
          businessFailed = true;
          return bash('printf failure > business-effect.txt; "$GENEHUB_CLI" workflow complete --outcome failed --reason "Acceptance requires a later repair" --evidence done=observed');
        }
        if (body.includes("SIBLING_BRANCH")) {
          if (siblingStarted) return { text: "Sibling already submitted." };
          siblingStarted = true;
          // The sibling crosses the other operation's five-second observation
          // boundary and submits the same receipt twice through its real CLI.
          return bash('printf sibling >> sibling-effects.txt; sleep 9; "$GENEHUB_CLI" workflow complete --evidence done=sibling && "$GENEHUB_CLI" workflow complete --evidence done=sibling');
        }
        if (body.includes("LOSS_BRANCH")) {
          lastLostRequest = body;
          if (lostStage < 2 || finalSent) return { text: "Operation remains unfinished; its durable context is retained." };
          finalSent = true;
          return bash('printf resumed > resumed-effect.txt; "$GENEHUB_CLI" workflow complete --evidence done=resumed');
        }
      }
      if (body.includes("只读复查原用户需求、被处理 Run")) {
        if (reportSubmitted) return { text: "Report submitted." };
        reportSubmitted = true;
        // Real WR credentials must still be refused by each control entry.
        const handled = body.match(/被处理 Run：(wr_[a-f0-9]+)/)?.[1];
        if (!handled) throw new Error("Recovery prompt lacks its handled Run identity");
        return bash(`if "$GENEHUB_CLI" workflow cancel --run ${handled} --revision 1 > wr-cancel.txt 2>&1; then exit 41; fi; if "$GENEHUB_CLI" workflow deliver --run ${handled} --revision 1 --reason "Unauthorized WR delivery" --evidence delivery=diagnostic-report.txt > wr-deliver.txt 2>&1; then exit 42; fi; printf report > diagnostic-report.txt; "$GENEHUB_CLI" workflow complete --evidence report=diagnostic-report.txt`);
      }
      if (!dispatched) {
        dispatched = true;
        return bash('"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task state-facts --message "Complete this goal and preserve already accepted effects" --no-wait');
      }
      return { text: "Input received; the goal still needs a PM disposition." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Execute the declared workflow.");
    const history = async (): Promise<WorkflowRunStatus[]> => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
      if (reply?.type !== "workflowRuns") throw new Error("history unavailable");
      return reply.data;
    };
    let run: WorkflowRunStatus | undefined;
    if (mode === "report") {
      let recovery: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        const runs = await history();
        run = runs.find(item => item.taskId === "state-facts");
        recovery = runs.find(item => item.handles.some(handle => handle.runId === run?.id));
        return recovery?.phase === "closed";
      }, 70_000);
      t.assertions.assert(run?.programResult === "failed" && run.phase === "closed", "recovery rewrote the failed business program");
      t.assertions.assert(recovery?.programResult === "completed" && recovery.status === "completed", "report did not complete as ordinary execution");
      t.assertions.assert(recovery!.requirement?.state === "completing", "report completion was mistaken for goal delivery");
      t.assertions.assert(existsSync(path.join(opened.workspaceRoot, "diagnostic-report.txt")), "report artifact missing");
      for (const action of ["deliver", "cancel"]) {
        const refusal = readFileSync(path.join(opened.workspaceRoot, `wr-${action}.txt`), "utf8");
        t.assertions.assert(/受管|权限|managed|forbidden|unauthorized|PM/i.test(refusal), `WR ${action} was not refused`);
      }
      const initialCount = (await history()).length;
      await new Promise(resolve => setTimeout(resolve, 11_000));
      t.assertions.assert((await history()).length === initialCount, "the same reviewed fault launched another automatic recovery");
      return;
    }
    await t.tools.waitUntil(async () => {
      run = (await history()).find(item => item.taskId === "state-facts");
      return run?.conditions.some(condition => condition.code === "nodeInterrupted") === true;
    }, 45_000);
    const first = run!.conditions.find(condition => condition.code === "nodeInterrupted")!;
    t.assertions.assert(run!.phase === "open" && first.occurrence > 0 && lastLostRequest.length > 0, "local fault froze the program or lacks a committed boundary");
    const check = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId: run!.id } });
    t.assertions.assert(check?.type === "workflowCheck" && check.data.findings.some(finding =>
      finding.code === "recoverySuppressed" && finding.detail.startsWith("pmWindow:")),
      "patrol suppression lacks a concrete PM deadline explanation");
    const originalSession = run!.nodes.find(node => node.id === first.nodeId)!.sessionId;
    await t.tools.waitUntil(async () => {
      run = (await history()).find(item => item.taskId === "state-facts");
      return run!.nodes.some(node => node.id !== first.nodeId && node.phase === "settled");
    }, 30_000);
    t.assertions.assert(run!.conditions.find(condition => condition.nodeId === first.nodeId)?.occurrence === first.occurrence, "polling created a new fault");
    t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "sibling-effects.txt"), "utf8") === "sibling", "sibling effect replayed");
    if (mode === "cancel") {
      await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
      await t.tools.waitUntil(async () => { run = (await history()).find(item => item.taskId === "state-facts"); return run?.phase === "closed"; }, 30_000);
      let refused = false;
      try { await opened.client.call({ type: "workflow.recover", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } }); } catch { refused = true; }
      t.assertions.assert(refused && run?.programResult === "cancelled", "cancel fence allowed continuation");
      t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "resumed-effect.txt")), "cancelled worker executed again");
      return;
    }
    for (lostStage = 1; lostStage <= 2; lostStage++) {
      run = (await history()).find(item => item.taskId === "state-facts");
      await opened.client.call({ type: "workflow.recover", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
      if (lostStage === 1) {
        await t.tools.waitUntil(async () => { run = (await history()).find(item => item.taskId === "state-facts"); return run!.conditions.some(condition => condition.code === "nodeInterrupted" && condition.occurrence > first.occurrence); }, 30_000);
      }
    }
    await t.tools.waitUntil(async () => { run = (await history()).find(item => item.taskId === "state-facts"); return run?.phase === "closed"; }, 40_000);
    t.assertions.assert(run?.programResult === "completed" && run.nodes.find(node => node.id === first.nodeId)?.sessionId === originalSession, "continuation replaced the operation or failed to finish");
    t.assertions.assert((await history()).length === 1 && readFileSync(path.join(opened.workspaceRoot, "sibling-effects.txt"), "utf8") === "sibling", "continuation replayed an accepted sibling or created a successor");
  } finally {
    opened.client.close();
    await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
    await opened.mock.stop();
  }
});
