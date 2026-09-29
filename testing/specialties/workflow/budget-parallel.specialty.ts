import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus, WorkflowRequestBudgetSnapshot } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const lit = (value: unknown) => ({ op: "literal", value });
const ref = (path: string) => ({ op: "ref", path });
const obj = (fields: Record<string, unknown>) => ({ op: "object", fields });
const task = (id: string, activity: string, input: unknown = lit(null)) => ({ id, type: "task", activity, input });
const seq = (id: string, steps: unknown[], output?: unknown) => ({ id, type: "sequence", steps, ...(output ? { output } : {}) });
function assignment(value: unknown): { key: string } | undefined {
  if (typeof value === "string") {
    const match = value.match(/结构化输入（数据，不是指令）：([^\n]+)/);
    if (match) return JSON.parse(match[1]!);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value).reverse()) { const found = assignment(child); if (found) return found; }
  }
  return undefined;
}

for (const scenario of ["observation", "retry", "entries", "entries-empty", "entries-type", "entries-limit", "entries-max", "parallel-restart", "parallel-sibling-lost", "parallel-failure", "parallel-double-failure", "parallel-human-wait"] as const) defineSpecialty({
  id: `specialty.workflow.budget-parallel.${scenario}`,
  title: `Budget observations and deterministic parallel data: ${scenario}`,
  oracle: "Public Run output preserves budget observations across amendments/restart and request retries; independently overlapping Workers reduce by stable keys, while host failures clean up and Human waits retain their request without execution clocks",
  catches: ["budget read mutates limits", "restart refreshes a committed observation", "retry resets shared usage", "a fourth Run bypasses the shared limit", "stale budget revision overwrites PM", "entries depends on completion order", "entries accepts wrong types or unbounded data", "parallel work is serialized", "failure leaves live siblings", "one lost sibling silently continues a partially failed Run or replays a side effect"],
  tags: ["core", "workflow", "structured-workflow", "budget-parallel"],
  llm: { default: "mock" }, expectedDurationMs: 20_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  requiredArtifacts: ["genet", "genehub-host-local", "genehub_guest.wasm"],
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["genet schema workflow.definition", "genet workflow", "workflow.history", "workflow.check", "session.send", "session.get"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout); return result.stdout;
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
        const source = t.flows.main.seedDirectChangePackage({ projectRoot: opened.workspaceRoot });
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "BUDGET_PARALLEL_WORKER: execute only the bound assignment and submit actual results.\n");
    const budgetCase = scenario === "observation" || scenario === "retry";
    const pure = scenario.startsWith("entries-");
    const input = scenario === "entries-empty" ? {} : scenario === "entries-type" ? []
      : Object.fromEntries(Array.from({ length: scenario === "entries-limit" ? 4097 : 4096 }, (_, n) => [`k${n.toString().padStart(4, "0")}`, n]));
    // Stop-on-first-failure as an expression: an arrived failure already decides
    // the group, so the Run stops instead of waiting out its live siblings.
    const parallel = { id: "checks", type: "forEach", items: lit(["z", "a"]), key: ref("/item"), maxConcurrency: 2,
      ...(scenario === "parallel-double-failure" ? {} : { completeWhen: { op: "not", value: { op: "eq", left: ref("/group/failed"), right: lit(0) } } }),
      body: task("check", "work", obj({ key: ref("/item") })) };
    const fold = { id: "reduce", type: "forEach", items: { op: "entries", value: ref("/results/checks") }, key: ref("/item/key"), maxConcurrency: 1,
      initial: lit({ approved: true, keys: [] }), body: seq("read-result", [], ref("/item/value")),
      update: obj({ approved: { op: "all", values: [ref("/vars/approved"), ref("/results/output/passed")] },
        keys: { op: "append", array: ref("/vars/keys"), value: ref("/item/key") } }) };
    const root = pure ? seq("root", [], { op: "entries", value: ref("/input") })
      : budgetCase ? seq("root", [task("before", "budget"), task("work-step", "work", lit({ key: "budget" })), task("after", "budget")],
        obj({ before: ref("/results/before/output"), after: ref("/results/after/output") }))
      : seq("root", [parallel, fold, { id: "deliver-if-approved", type: "if", condition: ref("/results/reduce/approved"), then: task("publish", "publish") }], ref("/results/reduce"));
    writeFileSync(path.join(source, "flows/direct-change.yaml"), JSON.stringify({ schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [{ id: "budget", uses: "request.budget" }, { id: "publish", uses: "result.publish" },
        { id: "work", uses: "agent.session", with: { role: "worker" }, completion: { output: { type: "object", properties: { passed: { type: "boolean" } } } } }],
      structure: { input, body: root } }));
    await cli(["workflow", "check", "--draft"]);
    const schema = await cli(["schema", "workflow.definition"]);
    t.assertions.assert(schema.includes("request.budget") && schema.includes("entries"), "authoring schema omits new capabilities");
    const release = path.join(opened.workspaceRoot, "release-worker");
    const effect = (key: string) => path.join(opened.workspaceRoot, `started-${key}`);
    // A bounded real-tool barrier makes serial execution fail, not merely take longer.
    const waitFile = (file: string) => `for i in $(seq 1 400); do test -f ${q(file)} && break; sleep 0.05; done; test -f ${q(file)}`;
    let nextCommand: string | undefined = '"$GENEHUB_CLI" workflow activate --revision 0 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task observed-1 --no-wait --message "Process the bounded record batch within the existing request budget"';
    const seen = new Set<string>();
    const reported = new Set<string>();
    opened.mock.script(...Array.from({ length: 90 }, () => ({ respond: (request: unknown) => {
      const text = JSON.stringify(request);
      if (scenario === "parallel-double-failure" && text.includes("只读复查这条用户需求及其 Run")) return { hang: true as const };
      if (text.includes("角色标签为 `recovery-reviewer`")) {
        const reportOperation = text.match(/当前节点：(operation-\d+)/)?.[1];
        const reportKey = "report:" + (text.match(/被处理 Run：(wr_[a-f0-9]+)/)?.[1] ?? "run") + ":" + reportOperation;
        if (reported.has(reportKey)) return { text: "Diagnostic report submitted." };
        reported.add(reportKey);
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence report="Observed failed program and retained the original goal"' } } };
      }
      if (!text.includes("BUDGET_PARALLEL_WORKER")) {
        if (!nextCommand) return { text: "Observed execution facts." };
        const command = nextCommand; nextCommand = undefined; return { tool: { name: "bash", arguments: { command } } };
      }
      const id = text.match(/当前节点：(operation-\d+)/)?.[1], data = assignment(request);
      if (!id || !data) throw new Error("missing bound Worker assignment");
      // Retries are distinct Runs but may reuse operation IDs.
      const run = text.match(/wf_[a-zA-Z0-9_-]+/)?.[0] ?? "run";
      const identity = `${run}:${id}`;
      // A continued Worker submits from its original Session without repeating
      // the side effect its own predecessor turn already recorded.
      if (seen.has(identity)) {
        return { text: "Result submitted." };
      }
      seen.add(identity);
      if (scenario === "parallel-human-wait" && data.key === "a") return { tool: { name: "request_user_input", arguments: { title: "Confirm this acceptance scope", summary: "共 1 个待回答问题。", description: "请使用下方选项回答问题；提交后继续当前任务。", questions: [{ id: "scope", header: "Scope", question: "Confirm this acceptance scope", options: [{ label: "yes", description: "Approve" }, { label: "no", description: "Decline" }] }] } } };
      const finish = (scenario === "parallel-failure" && data.key === "a") || scenario === "parallel-double-failure" ? '--outcome failed --reason "checker unavailable"'
        : `--output ${q(JSON.stringify({ passed: scenario !== "entries" || data.key !== "z" }))}`;
      const barrier = scenario === "observation" || scenario === "parallel-human-wait" ? waitFile(release)
        : pure || budgetCase ? "true" : waitFile(effect(data.key === "a" ? "z" : "a"));
      // Both real Workers must start before either can submit.
      const pause = scenario === "parallel-sibling-lost" ? "sleep 45 && "
        : scenario === "parallel-failure" && data.key === "z" ? "sleep 30 && " : data.key === "z" ? "sleep 0.3 && " : "";
      const after = scenario === "observation" ? " && sleep 5" : "";
      return { tool: { name: "bash", arguments: { command: `printf '%s\\n' ${q(identity)} >> ${q(effect(data.key))} && ${barrier} && ${pause}"$GENEHUB_CLI" workflow complete ${finish}${after}` } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    let inputSeq = 0;
    // Durable input queues behind an automatic completion notice instead of
    // racing its active PM turn through the immediate-input API.
    const send = (text: string) => opened.client.call({ type: "session.send", payload: {
      sessionId: pm, messageId: `u_budget_${++inputSeq}`, text,
      attachments: [], continuesRound: null,
    } });
    const history = async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("missing history"); return reply.data;
    };
    let run: WorkflowRunStatus | undefined;
    const current = async () => { const runs = await history(); run = runs.filter(item => item.handles.length === 0)[0]; return run; };
    const restart = async () => { opened.client.close(); await cli(["daemon", "stop"]); await cli(["daemon", "start"]); opened.client = await connectProductClient(daemonEndpoint(opened.daemon)); };
    await send("Execute the configured Workflow and retain its facts.");
    let before: WorkflowRequestBudgetSnapshot | undefined;
    if (scenario === "observation") {
      await t.tools.waitUntil(async () => !!(await current()) && existsSync(effect("budget")), 35_000);
      before = run!.nodes.find(n => n.uses === "request.budget")!.output as WorkflowRequestBudgetSnapshot;
      nextCommand = `"$GENEHUB_CLI" workflow budget --run ${q(run!.id)} --revision 0 --max-llm-rounds 512`;
      await send("The request budget may be raised to 512 rounds; keep the current Run.");
      await t.tools.waitUntil(async () => (await current())?.requestBudget?.revision === 1, 25_000);
      writeFileSync(release, "continue");
      await t.tools.waitUntil(async () => (await current())?.nodes.some(n => n.uses === "agent.session" && n.status === "finishing") === true, 25_000);
      await restart();
    } else if (scenario === "parallel-restart") {
      let snapshotPath = "";
      let acceptedCheckpoint: string | undefined;
      // z has already recorded its side effect but cannot submit until a has
      // settled. Thus the mixed frontier cannot be skipped by close timing.
      await t.tools.waitUntil(async () => {
        await current();
        if (!run) return false;
        snapshotPath = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", run.id, "runs", run.id, "run.json");
        const raw = readFileSync(snapshotPath, "utf8"), saved = JSON.parse(raw);
        const workers = Object.values(saved.run.nodes).filter((node: any) => node.uses === "agent.session") as Array<{ phase: string; resultAcceptedAtMs: number }>;
        if (workers.length === 2 && workers.every(node => node.resultAcceptedAtMs > 0)
          && workers.some(node => node.phase === "finishing") && saved.run.engine?.status === "running") acceptedCheckpoint = raw;
        return run.status === "completed" && run.nodes.filter(n => n.uses === "agent.session" && n.status === "completed").length === 2;
      }, 40_000).catch(async error => { throw new Error(`${error}; beforeRestart=${JSON.stringify(run)}; requests=${opened.mock.requests.length}`); });
      t.assertions.assert(!!acceptedCheckpoint, "did not observe a genuine accepted-result/unfinished-cleanup checkpoint");
      opened.client.close();
      await cli(["daemon", "stop"]);
      // Replay an actual durable pre-cleanup snapshot, including its pure engine
      // state. Changing only a completed node label would manufacture an invalid checkpoint.
      writeFileSync(snapshotPath, acceptedCheckpoint!);
      await cli(["daemon", "start"]);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    } else if (scenario === "parallel-sibling-lost") {
      await t.tools.waitUntil(async () => {
        await current(); return existsSync(effect("a")) && existsSync(effect("z"))
          && run?.nodes.filter(n => n.uses === "agent.session" && n.status === "running").length === 2;
      }, 40_000);
      const [stranded, survivor] = run!.nodes.filter(n => n.uses === "agent.session");
      opened.client.close();
      await cli(["daemon", "stop"]);
      // One Worker loses its durable Session while the daemon is down. The
      // affected structured Run must freeze both branches and enter one
      // recovery attempt without replaying either disk side effect.
      const spaces = path.join(opened.workspaceRoot, "spaces");
      const homes = [opened.workspaceRoot, ...(existsSync(spaces) ? readdirSync(spaces).map(space => path.join(spaces, space)) : [])];
      const removed = homes.filter(home => {
        const dir = path.join(home, ".genethub/sessions", stranded!.sessionId!);
        if (!existsSync(dir)) return false;
        rmSync(dir, { recursive: true, force: true }); return true;
      });
      t.assertions.assert(removed.length === 1, `Worker Session record was not where the product stores it: ${stranded!.sessionId}`);
      await cli(["daemon", "start"]);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      await t.tools.waitUntil(async () => (await current())?.status === "blocked", 45_000);
      t.assertions.assert(run!.nodes.find(n => n.id === survivor!.id)?.sessionId === survivor!.sessionId
        && run!.nodes.find(n => n.id === stranded!.id)?.sessionId === stranded!.sessionId
        && !run!.nodes.some(n => n.status === "running"),
      "the lost sibling did not freeze the original structured Run and preserve both identities");
      await t.tools.waitUntil(async () => (await history()).filter(item =>
        item.handles.some(handle => handle.runId === run!.id)).length === 1, 45_000);
      t.assertions.assert(["a", "z"].every(key => readFileSync(effect(key), "utf8").trim().split("\n").length === 1),
        "recovery replayed a Worker side effect");
      await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
    } else if (scenario === "parallel-human-wait") {
      await t.tools.waitUntil(async () => {
        await current(); const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return existsSync(effect("z")) && reply?.type === "snapshot" && !!reply.data.summary.workSummary?.tasks[0]?.waiting?.length;
      }, 35_000);
      writeFileSync(release, "continue");
      await t.tools.waitUntil(async () => {
        await current(); const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return run?.nodes.some(n => n.status === "completed") === true && reply?.type === "snapshot" && reply.data.summary.workSummary?.executing === 0;
      }, 25_000);
      const check = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId: run!.id } });
      t.assertions.assert(check?.type === "workflowCheck" && !JSON.stringify(check.data).includes("执行耗时"), "untimed Human wait still publishes a request execution clock");
      await current();
      await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
    }
    await t.tools.waitUntil(async () => { await current(); return !!run && ["completed", "blocked", "cancelled"].includes(run.status); }, 70000);
    const expected = scenario === "parallel-human-wait" ? "cancelled" : scenario === "parallel-sibling-lost" ? "blocked"
      : ["entries-type", "entries-limit", "parallel-failure", "parallel-double-failure"].includes(scenario) ? "blocked" : "completed";
    t.assertions.assert(run!.status === expected && (scenario !== "parallel-sibling-lost" || run!.requirement?.state === "cancelled") && !run!.activeNodes.length && !run!.cleanupError, `unexpected terminal facts: ${JSON.stringify(run)}`);
    const value = () => (run!.structure as { outcome?: { value?: unknown } })?.outcome?.value;
    if (budgetCase) {
      const result = value() as { before: WorkflowRequestBudgetSnapshot; after: WorkflowRequestBudgetSnapshot };
      t.assertions.assert(result.before.usedRuns === 1 && result.before.remainingRuns === 2 && result.after.observedLlmRounds >= 1, "budget usage differs from actual request work");
      if (before) t.assertions.assert(JSON.stringify(result.before) === JSON.stringify(before) && result.after.budget.revision === 1 && result.after.budget.maxLlmRounds === 512
        && result.after.remainingLlmRounds === 512 - result.after.observedLlmRounds, "amendment/restart changed a committed observation or lost the fresh one");
      if (scenario === "retry") {
        const original = run!.id; seen.clear();
        nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task observed-2 --retry-of ${q(original)} --no-wait --message "Repeat within the same authorized request"`;
        await send("Retry the same original request.");
        await t.tools.waitUntil(async () => { await current(); return run?.id !== original && run?.status === "completed"; }, 40000);
        const retry = value() as typeof result;
        t.assertions.assert(retry.before.requestRunId === original && retry.before.usedRuns === 2 && retry.before.remainingRuns === 1
          && retry.before.observedLlmRounds >= result.after.observedLlmRounds, "retry reset request usage");
        seen.clear();
        nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task observed-3 --retry-of ${q(original)} --no-wait --message "Use the final authorized business Run"`;
        await send("Use the final authorized business Run.");
        await t.tools.waitUntil(async () => { await current(); return run?.taskId === "observed-3" && run.status === "completed"; }, 40_000);
        const lastAuthorized = value() as typeof result;
        t.assertions.assert(lastAuthorized.before.requestRunId === original && lastAuthorized.before.usedRuns === 3
          && lastAuthorized.before.remainingRuns === 0
          && lastAuthorized.before.currentRunAdmitted && lastAuthorized.before.currentRunCanExecute,
          "last admitted Run lost execution authority when future admission capacity reached zero");

        nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task forbidden-4 --retry-of ${q(original)} --no-wait --message "Attempt beyond shared limit"`;
        await send("Attempt one more Run with the old budget.");
        await t.tools.waitUntil(async () => {
          const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
          return reply?.type === "snapshot" && reply.data.summary.status === "idle"
            && !reply.data.summary.inputSummary?.pendingMessageIds.includes(`u_budget_${inputSeq}`);
        }, 30_000);
        t.assertions.assert((await history()).length === 3
          && JSON.stringify(opened.mock.requests).includes("requestBudgetExceeded"),
        "fourth business Run bypassed the budget or PM could not see the refusal");

        seen.clear();
        nextCommand = `"$GENEHUB_CLI" workflow budget --run ${q(original)} --revision 0 --max-runs 4 --max-llm-rounds 512`;
        await send("Raise this request budget within the existing authorization.");
        await t.tools.waitUntil(async () => (await history()).find(item => item.id === original)?.requestBudget.revision === 1, 30_000);
        nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task observed-4 --retry-of ${q(original)} --no-wait --message "PM approved more budget"`;
        await send("Continue the same task using the newly approved budget.");
        await t.tools.waitUntil(async () => { await current(); return run?.taskId === "observed-4" && run.status === "completed"; }, 40_000);
        t.assertions.assert(run!.requestRunId === original && run!.requestBudget.revision === 1
          && run!.requestBudget.maxRuns === 4 && run!.requestBudget.maxLlmRounds === 512,
          "PM budget amendment did not carry into the successor");
        const stale = await runGenetAsync(opened.daemon.genet,
          ["workflow", "budget", "--run", original, "--revision", "0", "--max-runs", "5"],
          opened.daemon.env, { cwd: opened.workspaceRoot });
        t.assertions.assert(stale.code !== 0 && `${stale.stdout}${stale.stderr}`.includes("预算 revision 冲突"),
          "stale budget update overwrote the PM decision");
      }
    } else if (scenario === "entries-empty") t.assertions.assert(JSON.stringify(value()) === "[]", "empty object did not reduce to empty array");
    else if (scenario === "entries-max") {
      const result = value() as Array<{ key: string; value: number }>;
      t.assertions.assert(result.length === 4096 && result[0]!.key === "k0000" && result[4095]!.value === 4095, "bounded maximum lost entries or ordering");
    } else if (scenario === "entries" || scenario === "parallel-restart") {
      const result = value() as { approved: boolean; keys: string[] };
      t.assertions.assert(JSON.stringify(result.keys) === '["a","z"]' && result.approved === (scenario !== "entries"), "parallel reduction lost identity or negative verdict");
      for (const key of ["a", "z"]) t.assertions.assert(readFileSync(effect(key), "utf8").trim().split("\n").length === 1, "restart repeated a settled check");
      t.assertions.assert(run!.nodes.filter(n => n.uses === "agent.session").length === 2, "aggregation consumed another Worker");
      t.assertions.assert(run!.nodes.some(n => n.uses === "result.publish") === result.approved, "negative verdict was published");
    } else if (scenario === "parallel-failure" || scenario === "parallel-double-failure") {
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
        return reply?.type === "workflowRuns" && reply.data.some(candidate =>
          candidate.handles.some(handle => handle.runId === run!.id));
      }, 35_000);
      t.assertions.assert(run!.nodes.some(n => n.outcome === "failed") && !run!.nodes.some(n => n.uses === "result.publish"), "host failure was turned into a business result");
      if (scenario === "parallel-double-failure") {
        t.assertions.assert(run!.nodes.filter(n => n.outcome === "failed").length === 2,
          "two independently failed branches were not retained on the same business Run");
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
        t.assertions.assert(reply?.type === "workflowRuns" && reply.data.filter(candidate =>
          candidate.handles.some(handle => handle.runId === run!.id)).length === 1,
        "parallel failures launched overlapping recovery Runs for one business Run");
      }
      for (const node of run!.nodes.filter(n => n.sessionId)) {
        const reply = await opened.client.call({ type: "session.get", payload: { sessionId: node.sessionId! } });
        t.assertions.assert(reply?.type === "snapshot" && !["running", "waiting"].includes(reply.data.summary.status), "the decided group left an executing sibling");
      }
    } else if (scenario === "entries-type" || scenario === "entries-limit") {
      t.assertions.assert(JSON.stringify(run!.structure).includes(scenario === "entries-type" ? "entries requires an object" : "entries exceeds 4096 items"), "runtime type/size error lacks actionable cause");
    }
  } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env); await opened.mock.stop(); }
});
