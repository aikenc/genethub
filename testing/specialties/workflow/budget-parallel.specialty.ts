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

for (const scenario of ["observation", "retry", "budget-expiry", "entries", "entries-empty", "entries-type", "entries-limit", "entries-max", "parallel-restart", "parallel-sibling-lost", "parallel-failure", "parallel-double-failure", "parallel-human-wait"] as const) defineSpecialty({
  id: `specialty.workflow.budget-parallel.${scenario}`,
  title: `Budget observations and deterministic parallel data: ${scenario}`,
  oracle: "Public Run output preserves budget observations across amendments/restart and request retries; independently overlapping Workers reduce by stable keys, while host failures clean up and only a wholly waiting Run pauses execution time",
  catches: ["budget read mutates limits", "restart refreshes a committed observation", "retry resets shared usage", "a fourth Run bypasses the shared limit", "structured budget expiry loses its PM handoff cause", "stale budget revision overwrites PM", "entries depends on completion order", "entries accepts wrong types or unbounded data", "parallel work is serialized", "one Human wait exempts working siblings", "failure leaves live siblings", "one lost sibling silently continues a partially failed Run or replays a side effect"],
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
    const budgetCase = scenario === "observation" || scenario === "retry" || scenario === "budget-expiry";
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
    opened.mock.script(...Array.from({ length: 90 }, () => ({ respond: (request: unknown) => {
      const text = JSON.stringify(request);
      if (scenario === "parallel-double-failure" && text.includes("只读复查被处理的 Run")) return { hang: true as const };
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
      if (scenario === "parallel-human-wait" && data.key === "a") return { tool: { name: "request_user_input", arguments: { questions: [{ id: "scope", header: "Scope", question: "Confirm this acceptance scope", options: [{ label: "yes", description: "Approve" }, { label: "no", description: "Decline" }] }] } } };
      const finish = (scenario === "parallel-failure" && data.key === "a") || scenario === "parallel-double-failure" ? '--outcome failed --reason "checker unavailable"'
        : `--output ${q(JSON.stringify({ passed: scenario !== "entries" || data.key !== "z" }))}`;
      const barrier = scenario === "observation" || scenario === "budget-expiry" || scenario === "parallel-human-wait" ? waitFile(release)
        : pure || budgetCase ? "true" : waitFile(effect(data.key === "a" ? "z" : "a"));
      const pause = scenario === "parallel-sibling-lost" ? "sleep 45 && "
        : scenario === "parallel-failure" && data.key === "z" ? "sleep 30 && " : data.key === "z" ? "sleep 0.3 && " : "";
      const after = scenario === "observation" || (scenario === "parallel-restart" && data.key === "z") ? " && sleep 5" : "";
      return { tool: { name: "bash", arguments: { command: `printf '%s\\n' ${q(identity)} >> ${q(effect(data.key))} && ${barrier} && ${pause}"$GENEHUB_CLI" workflow complete ${finish}${after}` } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    let inputSeq = 0;
    // Durable input queues behind an automatic completion notice instead of
    // racing its active PM turn through the immediate-input API.
    const send = (text: string) => opened.client.call({ type: "session.send", payload: {
      sessionId: pm, messageId: `u_budget_${++inputSeq}`, text,
      attachments: [], continuesRound: null, artifactPreviewBaseUrl: null,
    } });
    const history = async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("missing history"); return reply.data;
    };
    let run: WorkflowRunStatus | undefined;
    const current = async () => { const runs = await history(); run = scenario === "parallel-sibling-lost"
      ? runs.find(item => item.taskId === "observed-1") : runs[0]; return run; };
    const restart = async () => { opened.client.close(); await cli(["daemon", "stop"]); await cli(["daemon", "start"]); opened.client = await connectProductClient(daemonEndpoint(opened.daemon)); };
    await send("Execute the configured Workflow and retain its facts.");
    let before: WorkflowRequestBudgetSnapshot | undefined;
    if (scenario === "budget-expiry") {
      await t.tools.waitUntil(async () => !!(await current()) && existsSync(effect("budget")), 35_000);
      const original = run!.id;
      nextCommand = `"$GENEHUB_CLI" workflow budget --run ${q(original)} --revision 0 --deadline-seconds 1`;
      await send("Limit this request to one second of execution time.");
      await t.tools.waitUntil(async () => (await current())?.requestBudget.revision === 1, 25_000);
      await t.tools.waitUntil(async () => (await current())?.status === "blocked", 25_000);
      const snapshotPath = path.join(opened.workspaceRoot, ".genethub/components/pm/requests", original,
        "runs", original, "run.json");
      const saved = JSON.parse(readFileSync(snapshotPath, "utf8")) as { run: { stop?: { causeCode?: string }; updatedAtMs: number } };
      t.assertions.assert(saved.run.stop?.causeCode === "requestBudget",
        `structured budget expiry lost its PM handoff cause: ${saved.run.stop?.causeCode}`);
      t.assertions.assert(!(await history()).some(item => item.handles.some(handle => handle.runId === original)),
        "ordinary request budget expiry started a recovery Run");
      opened.client.close();
      await cli(["daemon", "stop"]);
      // Advance only the persisted PM answer clock; the patrol must create
      // the same Human feedback exit it creates for other budget blocks.
      saved.run.updatedAtMs = Date.now() - 1_805_000;
      writeFileSync(snapshotPath, JSON.stringify(saved));
      await cli(["daemon", "start"]);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      await t.tools.waitUntil(async () => (await history()).find(item => item.id === original)?.humanExit?.kind === "d", 25_000);
      t.assertions.assert(!(await history()).some(item => item.handles.some(handle => handle.runId === original)),
        "PM timeout created a recovery Run for a structured budget block");
      return;
    }
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
      await t.tools.waitUntil(async () => {
        await current(); return run?.nodes.some(n => n.status === "completed" && n.uses === "agent.session") === true
          && run.nodes.some(n => n.status === "finishing");
      }, 40_000);
      await restart();
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
      const elapsed = async () => {
        const reply = await opened.client.call({ type: "workflow.check", payload: { workspaceId: opened.workspaceId, runId: run!.id } });
        if (reply?.type !== "workflowCheck") throw new Error("missing check");
        const text = reply.data.findings.find(f => f.code === "requestBudget")?.detail;
        const match = text?.match(/执行耗时 (\d+)\//);
        if (!match) throw new Error(`missing execution-time fact: ${text}`); return Number(match[1]);
      };
      const workingAt = await elapsed(); await new Promise(resolve => setTimeout(resolve, 1600));
      t.assertions.assert(await elapsed() - workingAt >= 1000, "one waiting Worker paused working sibling time");
      writeFileSync(release, "continue");
      await t.tools.waitUntil(async () => {
        await current(); const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
        return run?.nodes.some(n => n.status === "completed") === true && reply?.type === "snapshot" && reply.data.summary.workSummary?.executing === 0;
      }, 25_000);
      const waitingAt = await elapsed(); await new Promise(resolve => setTimeout(resolve, 1600));
      t.assertions.assert(await elapsed() - waitingAt < 500, "whole-Run Human wait still spent execution time");
      await current();
      await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: run!.id, expectedRevision: run!.revision } });
    }
    await t.tools.waitUntil(async () => { await current(); return !!run && ["completed", "blocked", "cancelled"].includes(run.status); }, 70000);
    const expected = ["parallel-human-wait", "parallel-sibling-lost"].includes(scenario) ? "cancelled"
      : ["entries-type", "entries-limit", "parallel-failure", "parallel-double-failure"].includes(scenario) ? "blocked" : "completed";
    t.assertions.assert(run!.status === expected && !run!.activeNodes.length && !run!.cleanupError, `unexpected terminal facts: ${JSON.stringify(run)}`);
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
          && lastAuthorized.before.remainingRuns === 0, "third business Run did not exhaust the shared request budget");

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

        const usageMs = (await history()).reduce((sum, item) => sum + item.updatedAtMs - item.createdAtMs, 0);
        const amendedDeadlineSeconds = Math.ceil(usageMs / 1000) + 120;
        seen.clear();
        nextCommand = `"$GENEHUB_CLI" workflow budget --run ${q(original)} --revision 0 --max-runs 4 --deadline-seconds ${amendedDeadlineSeconds} --max-llm-rounds 512`;
        await send("Raise this request budget within the existing authorization.");
        await t.tools.waitUntil(async () => (await history()).find(item => item.id === original)?.requestBudget.revision === 1, 30_000);
        nextCommand = `"$GENEHUB_CLI" workflow dispatch --workflow direct-change --task observed-4 --retry-of ${q(original)} --no-wait --message "PM approved more budget"`;
        await send("Continue the same task using the newly approved budget.");
        await t.tools.waitUntil(async () => { await current(); return run?.taskId === "observed-4" && run.status === "completed"; }, 40_000);
        t.assertions.assert(run!.requestRunId === original && run!.requestBudget.revision === 1
          && run!.requestBudget.maxRuns === 4 && run!.requestBudget.deadlineMs === amendedDeadlineSeconds * 1000
          && run!.requestBudget.maxLlmRounds === 512, "PM budget amendment did not carry into the successor");
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
