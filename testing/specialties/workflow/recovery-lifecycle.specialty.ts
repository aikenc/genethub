import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, openWorkbenchPage, runGenetAsync, workflowSequence, writeWorkflowFlow, writeWorkflowRole } from "../../framework/public.ts";

// The old built-in five-way consultation is retired. Keep its stable case IDs
// while checking the report, PM disposition and durable Human boundaries instead.
for (const mode of ["normal", "consult", "handoff-timeout", "handoff-cancel", "resume", "bypass", "corrupt", "proactive", "human-b", "human-f", "cancel", "queue"] as const) {
  const names = { normal: "recovery-lifecycle", consult: "recovery-consult", "handoff-timeout": "recovery-handoff-timeout", "handoff-cancel": "recovery-handoff-cancel", resume: "recovery-resume", bypass: "recovery-pm-gate", corrupt: "recovery-corrupt-fallback", proactive: "recovery-proactive", "human-b": "recovery-human-b", "human-f": "recovery-human-f", cancel: "recovery-cancel", queue: "recovery-package-queue" };
  defineSpecialty({
    id: `specialty.workflow.${names[mode]}`,
    title: `Recovery report and PM-owned disposition: ${mode}`,
    oracle: "A failed or PM-stopped execution produces one independent diagnostic report. A report never delivers the original goal or grants WR control authority. PM may repair and dispatch a successor, request a durable Human decision, or cancel; restart and elapsed wait do not repeat diagnosis. A package serializes unfinished recovery Runs and falls back when its Candidate is damaged",
    catches: ["report still requires the retired five-way decision", "WR gains PM control", "report rewrites failed business history", "restart or elapsed wait repeats a reviewed fault", "Human answer is mistaken for delivery", "package recovery concurrency escapes its bound", "damaged Candidate hides a failed request"],
    tags: ["core", "workflow", "workflow-recovery", "session-attention"],
    runner: mode === "consult" ? "playwright" : undefined,
    llm: { default: "mock" }, expectedDurationMs: 50_000, timeoutMs: 180_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: mode === "consult" ? 1 : 0, pool: mode === "consult" ? "browser" : "standard" },
    requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "filesystem", ...(mode === "consult" ? ["workbench-page"] : [])],
    productInterfaces: ["workflow.history", "workflow.cancel", "workflow.journal", "session.get", "session.send", "session.respondPermission", "genet workflow activate", "genet workflow recovery start", "genet workflow complete", "genet workflow dispatch", "genet workflow human"],
  }, async t => {
    t.data.git.init(t.env.workspace);
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    let page: Awaited<ReturnType<typeof openWorkbenchPage>> | undefined;
    let stage = "setup";
    try {
      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const source = t.flows.main.seedWorkflowPackage({ projectRoot: opened.workspaceRoot });
      writeWorkflowRole(source, "worker.yaml", { id: "worker", tags: ["Flash"], userInteraction: "readOnly", prompt: "prompts/direct-worker.md" });
      const workerPrompt = path.join(source, "prompts/direct-worker.md");
      writeFileSync(workerPrompt, "RECOVERY_LIFECYCLE_BUSINESS: submit the assigned result.\n");
      writeWorkflowFlow(source, "direct-change.yaml", { id: "direct-change", nodes: [
        { id: "work", uses: "agent.session", with: { role: "worker", workspace: "." }, completion: { all: [{ key: "result", verify: "value.nonEmpty" }] } },
        { id: "publish", uses: "result.publish" },
      ], structure: workflowSequence([{ activity: "work", accept: ["completed"] }, { activity: "publish" }]) });
      const cli = async (args: string[]) => {
        const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
        t.assertions.assert(result.code === 0, `CLI ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`);
        return result.stdout;
      };
      if (mode === "corrupt") {
        writeFileSync(path.join(source, "workflow.md"), "---\ndescription: damaged custom recovery fixture\nrecovery: flows/recovery.yaml\n---\n");
        writeWorkflowFlow(source, "recovery.yaml", { id: "recovery", nodes: [
          { id: "diagnose", uses: "agent.session", with: { role: "worker" } }, { id: "publish", uses: "result.publish" },
        ], structure: workflowSequence([{ activity: "diagnose" }, { activity: "publish" }]) });
        await cli(["workflow", "activate", "--revision", "0"]);
      }
      let originalId = "", recoveryId = "", started = false, secondStarted = false, continued = false, proactiveStarted = false, humanAsked = false;
      const submitted = new Set<string>();
      const reports = new Set<string>();
      const bash = (command: string) => ({ tool: { name: "bash", arguments: { command } } });
      opened.mock.script(...Array.from({ length: 100 }, () => ({ respond: (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("RECOVERY_LIFECYCLE_BUSINESS")) {
          if (mode === "proactive" && !body.includes("candidate-successor")) return { hang: true as const };
          const key = body.includes("candidate-successor") ? "successor" : body.includes("QUEUE_SECOND") ? "second" : "original";
          if (submitted.has(key)) return { text: "This operation already submitted its result." };
          submitted.add(key);
          const success = key === "successor";
          return bash(`${mode === "corrupt" && !success ? "sleep 8; " : ""}printf '%s\\n' ${key} >> business-effects.txt; "$GENEHUB_CLI" workflow complete ${success ? "" : '--outcome failed --reason "business acceptance failed"'} --evidence result=${success ? "delivered" : "failed"}`);
        }
        if (body.includes("只读复查原用户需求、被处理 Run")) {
          const handled = body.match(/被处理 Run：(wr_[a-f0-9]+)/)?.[1];
          if (!handled) throw new Error("WR prompt omitted the handled Run");
          if (mode === "queue" && handled === originalId) return { hang: true as const };
          if (reports.has(handled)) return { text: "Diagnostic report submitted; PM owns disposition." };
          reports.add(handled);
          const denied = mode === "bypass" ? `if "$GENEHUB_CLI" workflow cancel --run ${handled} --revision 1 > wr-cancel.txt 2>&1; then exit 41; fi; if "$GENEHUB_CLI" workflow deliver --run ${handled} --revision 1 --reason "WR cannot deliver" --evidence delivery=report.txt > wr-deliver.txt 2>&1; then exit 42; fi; ` : "";
          const retired = mode === "consult" ? 'if "$GENEHUB_CLI" workflow consult --reason "diagnostic report" > retired-consult.txt 2>&1; then exit 43; fi; ' : "";
          return bash(`${denied}${retired}printf '%s\\n' ${handled} >> recovery-reports.txt; "$GENEHUB_CLI" workflow complete --evidence report=recovery-reports.txt`);
        }
        if (body.includes("ASK_FORMAL_HUMAN") && !humanAsked) {
          humanAsked = true;
          return bash(`"$GENEHUB_CLI" workflow get --run ${recoveryId} > current-recovery.json; revision=$(node -p 'JSON.parse(require("fs").readFileSync("current-recovery.json","utf8")).data.revision'); "$GENEHUB_CLI" workflow human --run ${recoveryId} --revision "$revision" --kind ${mode === "human-b" ? "b" : "f"} --reason "${mode === "human-b" ? "Defer polish and retain the playable prototype" : "Human should verify the delivered prototype"}"`);
        }
        if (body.includes("CONTINUE_AFTER_REPORT") && !continued) {
          continued = true;
          const repair = mode === "normal" ? `printf '\nREPAIRED_CANDIDATE\n' >> '${workerPrompt}'; "$GENEHUB_CLI" workflow activate --revision 1 && ` : "";
          return bash(`${repair}"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-successor --message "Finish original delivery after reviewing the diagnostic report" --retry-of ${recoveryId} --no-wait`);
        }
        if (body.includes("START_PROACTIVE_RECOVERY") && !proactiveStarted) {
          proactiveStarted = true;
          return bash(`"$GENEHUB_CLI" workflow recovery start --run ${originalId} --reason "PM observes unhealthy running work"`);
        }
        if (body.includes("START_SECOND_REQUEST") && !secondStarted) {
          secondStarted = true;
          return bash('"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-second --message "QUEUE_SECOND: independent second request" --no-wait');
        }
        if (!started) {
          started = true;
          return bash(`${mode === "corrupt" ? "" : '"$GENEHUB_CLI" workflow activate --revision 0 && '}"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task candidate-original --message "Deliver the original prototype" --no-wait`);
        }
        return { text: "The original goal remains open until PM makes an explicit disposition." };
      } })));
      const history = async (): Promise<WorkflowRunStatus[]> => {
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
        if (reply?.type !== "workflowRuns") throw new Error("Workflow history unavailable");
        return reply.data;
      };
      const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
        if (reply?.type !== "snapshot") throw new Error("Session snapshot unavailable");
        return reply.data;
      };
      const send = async (sessionId: string, text: string) => {
        const reply = await opened.client.call({ type: "session.send", payload: { sessionId, messageId: `u_recovery_${mode}_${text}`, text, attachments: [], continuesRound: null } });
        t.assertions.assert(reply?.type === "ack", `PM input rejected: ${text}`);
      };
      const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await send(pm, "START_RECOVERY_LIFECYCLE");
      stage = "original execution";
      await t.tools.waitUntil(async () => {
        const run = (await history()).find(item => item.taskId === "candidate-original");
        if (run) originalId = run.id;
        return mode === "proactive" || mode === "corrupt" ? run?.status === "running" && run.nodes.some(node => node.sessionId) : run?.phase === "closed";
      }, 35_000);
      if (mode === "proactive") await send(pm, "START_PROACTIVE_RECOVERY");
      if (mode === "corrupt") {
        const original = (await history()).find(run => run.id === originalId)!;
        const candidate = path.join(opened.workspaceRoot, ".genethub/components/executor/candidates", `${original.dcgDigest.slice("sha256:".length)}.json`);
        t.assertions.assert(existsSync(candidate), "active Candidate is not in its declared store");
        writeFileSync(candidate, "damaged Candidate\n");
      }
      stage = "independent report";
      let recovery: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        recovery = (await history()).find(run => run.handles.some(handle => handle.runId === originalId));
        if (recovery) recoveryId = recovery.id;
        return mode === "queue" ? recovery?.nodes.some(node => node.sessionId) === true : recovery?.phase === "closed";
      }, 60_000);
      if (mode === "queue") {
        const damaged = path.join(opened.workspaceRoot, ".genethub/components/pm/requests/wr_damaged_fixture");
        mkdirSync(damaged, { recursive: true }); writeFileSync(path.join(damaged, "request.json"), "invalid unrelated reservation\n");
        const pm2 = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
        await send(pm2, "START_SECOND_REQUEST");
        let second: WorkflowRunStatus | undefined;
        await t.tools.waitUntil(async () => { second = (await history()).find(run => run.taskId === "candidate-second"); return second?.phase === "closed"; }, 30_000);
        await new Promise(resolve => setTimeout(resolve, 6_000));
        t.assertions.assert(!(await history()).some(run => run.handles.some(handle => handle.runId === second!.id)), "second request bypassed the package recovery bound");
        const original = (await history()).find(run => run.id === originalId)!;
        await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: original.id, expectedRevision: original.revision } });
        await t.tools.waitUntil(async () => (await history()).some(run => run.handles.some(handle => handle.runId === second!.id) && run.phase === "closed" && run.programResult === "completed"), 45_000);
        t.assertions.assert((await history()).filter(run => run.handles.length && run.phase !== "closed").length <= 1, "package has concurrent unfinished recovery Runs");
        return;
      }
      t.assertions.assert(recovery!.programResult === "completed" && recovery!.status === "completed" && !recovery!.humanExit, `report failed or opened an unsolicited Human card: ${JSON.stringify(recovery)}`);
      const business = (await history()).find(run => run.id === originalId)!;
      t.assertions.assert(business.phase === "closed" && business.programResult === "failed" && business.requirement?.state !== "completed", "report changed the original business result or delivered its goal");
      const reviewer = recovery!.nodes.find(node => node.sessionId)!.sessionId!;
      t.assertions.assert(!(await snapshot(reviewer)).pendingPermissions.length, "report completion still waits for a PM choice");
      if (mode === "bypass") {
        for (const action of ["cancel", "deliver"]) t.assertions.assert(/受管|权限|managed|forbidden|unauthorized|PM/i.test(readFileSync(path.join(opened.workspaceRoot, `wr-${action}.txt`), "utf8")), `WR ${action} lacks an authority refusal`);
        return;
      }
      if (mode === "consult") {
        t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "retired-consult.txt"), "utf8").includes("不再使用固定五选项"), "retired consultation silently accepted a decision");
        page = await openWorkbenchPage(t.openRoot, () => daemonEndpoint(opened.daemon), opened.workspaceId, pm);
        await page.page.getByRole("region", { name: "任务进度" }).getByRole("button", { name: /小队任务/ }).click();
        await page.page.getByRole("dialog", { name: "小队任务", exact: true }).getByText("恢复流程 · 执行已结束，需求仍需核对交付").waitFor();
      }
      if (mode === "human-b" || mode === "human-f") {
        await send(pm, "ASK_FORMAL_HUMAN");
        let cardId = "";
        await t.tools.waitUntil(async () => { recovery = (await history()).find(run => run.id === recoveryId); cardId = recovery?.humanExit?.requestId ?? ""; return Boolean(cardId) && (await snapshot(pm)).pendingPermissions.some(card => card.id === cardId); }, 25_000);
        const card = (await snapshot(pm)).pendingPermissions.find(item => item.id === cardId)!;
        t.assertions.assert(card.options?.map(option => option.id).join(",") === (mode === "human-b" ? "acceptScope,cancel" : "pass,fail"), "formal Human card has the wrong options");
        const answer = mode === "human-b" ? "acceptScope" : "pass";
        await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: cardId, outcome: { outcome: "selected", optionId: answer } } });
        await t.tools.waitUntil(async () => (await history()).find(run => run.id === recoveryId)?.humanExit?.answer === answer, 20_000);
        const original = (await history()).find(run => run.id === originalId)!;
        t.assertions.assert(original.programResult === "failed" && original.requirement?.state !== "completed", "Human answer rewrote failed execution or impersonated PM delivery");
        return;
      }
      if (["resume", "handoff-timeout", "handoff-cancel"].includes(mode)) {
        opened.client.close(); await cli(["daemon", "stop"]);
        if (mode === "handoff-timeout") {
          const file = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", originalId, "runs", recoveryId, "run.json");
          const record = JSON.parse(readFileSync(file, "utf8")); record.run.updatedAtMs = Date.now() - 48 * 60 * 60 * 1000; writeFileSync(file, JSON.stringify(record));
        }
        await cli(["daemon", "start"]); opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
        await new Promise(resolve => setTimeout(resolve, 11_000));
        const runs = await history();
        t.assertions.assert(runs.length === 2 && runs.find(run => run.id === recoveryId)?.programResult === "completed" && !runs.find(run => run.id === recoveryId)?.humanExit, "restart or elapsed PM wait escalated or repeated a completed report");
        if (mode === "handoff-timeout") return;
      }
      if (mode === "cancel" || mode === "handoff-cancel") {
        const original = (await history()).find(run => run.id === originalId)!;
        await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: originalId, expectedRevision: original.revision } });
        await t.tools.waitUntil(async () => (await history()).every(run => run.requirement?.state === "cancelled" && run.phase === "closed"), 25_000);
        t.assertions.assert((await history()).length === 2, "cancellation started another diagnosis");
        return;
      }
      if (mode === "corrupt" || mode === "proactive") return;
      stage = "PM successor";
      await send(pm, "CONTINUE_AFTER_REPORT");
      let successor: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => { successor = (await history()).find(run => run.taskId === "candidate-successor"); return successor?.phase === "closed" && successor.programResult === "completed"; }, 35_000);
      t.assertions.assert(successor!.requestRunId === originalId && successor!.requirement?.state !== "completed", "successor lost original ownership or delivered without PM judgment");
      t.assertions.assert(mode === "normal" ? successor!.dcgDigest !== business.dcgDigest : successor!.dcgDigest === business.dcgDigest, "successor pinned the wrong Candidate");
      t.assertions.assert(readFileSync(path.join(opened.workspaceRoot, "business-effects.txt"), "utf8").trim().split("\n").join(",") === "original,successor", "recovery replayed an accepted business effect");
      const archive = path.join(opened.workspaceRoot, ".genethub/components/executor/recoveries.jsonl");
      const records = readFileSync(archive, "utf8").trim().split("\n").map(line => JSON.parse(line));
      t.assertions.assert(records.filter(record => record.runId === recoveryId && record.handledRunId === originalId && record.result === "completed").length === 1, "report archive lost or duplicated the handled Run");
    } catch (error) {
      throw new Error(`${mode}/${stage}: ${String(error)}`);
    } finally {
      await page?.close(); opened.client.close();
      await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
      await opened.mock.stop();
    }
  });
}
