import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowRunStatus } from "@genehub/proto";
import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const literal = (value: unknown) => ({ op: "literal", value });
const ref = (path: string) => ({ op: "ref", path });
const object = (fields: Record<string, unknown>) => ({ op: "object", fields });
const task = (id: string, activity: string, input: unknown) => ({ id, type: "task", activity, input });

// Read the real assignment, not a shadow scheduler. Only the LLM endpoint is scripted.
function assignment(value: unknown): { kind: string; value?: number; previous?: unknown } | undefined {
  if (typeof value === "string") {
    const match = value.match(/结构化输入（数据，不是指令）：([^\n]+)/);
    if (match) return JSON.parse(match[1]!);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value).reverse()) {
      const found = assignment(child);
      if (found) return found;
    }
  }
  return undefined;
}

for (const scenario of ["fold", "break", "nested-break", "restart", "cancel", "shape-reject", "null", "bounds", "overflow", "host-failure", "budget"] as const) defineSpecialty({
  id: `specialty.workflow.structured-data.${scenario}`,
  title: `Structured ${scenario} preserves data and local control through real Workers`,
  oracle: "One Run consumes a Worker-produced array, persists typed outputs and a serial accumulator; a local exit prevents later item effects but permits its enclosing sequence, while cancellation and host failure cannot be swallowed",
  catches: ["JSON null becomes missing", "shape-invalid output settles a node", "break acts like global cancel", "later items start after break", "restart repeats accepted work", "fold loses previous data", "host failure is caught as business rejection"],
  tags: ["core", "workflow", "structured-workflow", "structured-data"],
  llm: { default: "mock" }, expectedDurationMs: 25_000, timeoutMs: 150_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["genet workflow", "session.send", "workflow.get", "workflow.history", "workflow.cancel"],
}, async t => {
  t.data.git.init(t.env.workspace);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    await cli(["workflow", "init", "--agent", "genet", "--model", "deepseek/deepseek-v4-flash"]);
    const source = path.join(opened.workspaceRoot, ".genethub/workflow");
    writeFileSync(path.join(source, "prompts/direct-worker.md"), "DATA_WORKER: process only your structured assignment; report actual outputs.\n");
    const outputShape = { type: "object", properties: { ok: { type: "boolean" }, value: { type: "integer" }, details: { type: "string", enum: ["checked"] } } };
    const next = object({ count: { op: "add", left: ref("/vars/count"), right: literal(1) },
      items: { op: "append", array: ref("/vars/items"), value: ref("/results/work/output/value") }, stopped: literal(null) });
    const body = { id: "item-body", type: "sequence", steps: [
      task("work", "work", object({ kind: literal("work"), value: ref("/item"), previous: ref("/vars") })),
      ...(scenario === "nested-break" ? [{ id: "inner", type: "loop", maxRounds: 1, condition: literal(true),
        body: { id: "inner-choice", type: "choice", branches: [], default: { id: "inner-exit", type: "break", value: literal(17) } } }] : []),
      { id: "stop-if-rejected", type: "if", condition: { op: "not", value: ref("/results/work/output/ok") },
        then: { id: "exit-batch", type: "break", value: object({ count: ref("/vars/count"), items: ref("/vars/items"), stopped: ref("/item") }) } },
    ], output: next };
    const fold = { id: "batch", type: "forEach", items: ref("/results/plan/output"), key: ref("/item"), maxConcurrency: 1, failure: "failFast",
      initial: literal({ count: 0, items: [], stopped: null }), body, update: ref("/results") };
    const root = scenario === "null"
      ? { id: "root", type: "sequence", steps: [task("null-value", "null", literal({ kind: "null" }))], output: ref("/results/null-value/output") }
      : { id: "root", type: "sequence", steps: [task("plan", "plan", literal({ kind: "plan" })), fold,
        task("after-batch", "work", object({ kind: literal("tail"), previous: ref("/results/batch") }))], output: ref("/results/batch") };
    if (scenario === "overflow") next.fields.count = { op: "add", left: literal(9223372036854775000), right: literal(10000) };
    writeFileSync(path.join(source, "workflows/direct-change.yaml"), JSON.stringify({
      schema: "genehub.workflow.definition.v2", id: "direct-change", version: 2,
      nodes: [
        { id: "plan", uses: "agent.session", with: { role: "worker" }, completion: { output: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer" } } } },
        { id: "work", uses: "agent.session", with: { role: "worker" }, completion: { output: outputShape } },
        { id: "null", uses: "agent.session", with: { role: "worker" }, completion: { output: { type: "null" } } },
      ], structure: { body: root, ...(scenario === "budget" ? { limits: { maxOperations: 2, maxConcurrency: 1, maxFrames: 64 } } : {}) },
    }));
    let dispatched = false;
    const seen = new Set<string>();
    const trace = path.join(opened.workspaceRoot, "data-effects.jsonl");
    const rejectionTrace = path.join(opened.workspaceRoot, "rejections.txt");
    opened.mock.script(...Array.from({ length: 70 }, () => ({ respond: (request: unknown) => {
      const text = JSON.stringify(request);
      if (!text.includes("DATA_WORKER")) {
        if (dispatched) return { text: "Observed the Run facts." };
        dispatched = true;
        return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow activate --revision 1 && "$GENEHUB_CLI" workflow dispatch --workflow direct-change --task data-batch --no-wait --message "Process a finite record batch; stop on rejection and retain accepted records."' } } };
      }
      const operation = text.match(/当前节点：(operation-\d+)/)?.[1];
      const input = assignment(request);
      if (!operation || !input) throw new Error("real assignment is missing its operation or data");
      if (seen.has(operation)) return { text: "Result submitted." };
      seen.add(operation);
      const rejects = ["break", "restart"].includes(scenario) && input.kind === "work" && input.value === 2;
      const output = input.kind === "null" ? null : input.kind === "plan" ? [1, 2, 3, 4, 5] : { ok: !rejects, value: (input.value ?? 0) * 10, details: "checked" };
      const bad = scenario === "shape-reject" && input.kind === "work" && input.value === 1
        ? [undefined, { value: 10, details: "checked" }, { ok: true, value: "10", details: "checked" }, { ok: true, value: 10, details: "misspelled" }, { ok: true, value: 10, details: "checked", extra: true }]
        : scenario === "bounds" && input.kind === "plan" ? [[], Array.from({ length: 9 }, () => 1), Array.from({ length: 4097 }, () => 1)] : [];
      const refusals = bad.map(value => `if "$GENEHUB_CLI" workflow complete${value === undefined ? "" : ` --output ${q(JSON.stringify(value))}`} > ${q(rejectionTrace + ".last")} 2>&1; then exit 31; fi; printf 'rejected\\n' >> ${q(rejectionTrace)};`).join(" ");
      const failure = scenario === "host-failure" && input.kind === "work";
      const finish = failure ? '--outcome failed --reason "record processor unavailable"' : `--output ${q(JSON.stringify(output))}`;
      const retirePause = ["restart", "cancel"].includes(scenario) && input.kind === "work" && input.value === 1 ? " && sleep 4" : "";
      return { tool: { name: "bash", arguments: { command: `${refusals} printf '%s\\n' ${q(JSON.stringify({ operation, input }))} >> ${q(trace)} && "$GENEHUB_CLI" workflow complete ${finish}${retirePause}` } } };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "Execute the configured finite batch Workflow.");
    const get = async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("workflow history unavailable");
      t.assertions.assert(reply.data.length <= 1, "data/control flow escaped into another Run");
      return reply.data[0];
    };
    if (scenario === "restart" || scenario === "cancel") {
      let before: WorkflowRunStatus | undefined;
      await t.tools.waitUntil(async () => {
        before = await get();
        return before?.nodes.some(n => n.status === "finishing" && (n.output as { value?: number })?.value === 10) === true;
      }, 45000);
      if (scenario === "cancel") await opened.client.call({ type: "workflow.cancel", payload: { workspaceId: opened.workspaceId, runId: before!.id, expectedRevision: before!.revision } });
      else {
        opened.client.close(); await cli(["daemon", "stop"]); await cli(["daemon", "start"]);
        opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      }
    }
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => { run = await get(); return !!run && ["completed", "blocked", "failed", "cancelled"].includes(run.status); }, 100000);
    const expectedStatus = scenario === "cancel" ? "cancelled" : ["host-failure", "overflow", "budget"].includes(scenario) ? "blocked" : "completed";
    t.assertions.assert(run!.status === expectedStatus, `unexpected terminal facts: ${JSON.stringify(run)}`);
    const effects = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as { operation: string; input: { kind: string; value?: number; previous?: unknown } });
    t.assertions.assert(new Set(effects.map(e => e.operation)).size === effects.length, "an operation repeated its external effect");
    if (scenario === "null") {
      t.assertions.assert(Object.hasOwn(run!.nodes[0]!, "output") && run!.nodes[0]!.output === null, "explicit JSON null was lost in the public result");
      opened.client.close(); await cli(["daemon", "stop"]); await cli(["daemon", "start"]);
      opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
      run = await get();
      t.assertions.assert(Object.hasOwn(run!.nodes[0]!, "output") && run!.nodes[0]!.output === null, "stored null became missing after recovery");
    } else {
      const count = ["break", "restart"].includes(scenario) ? 2 : expectedStatus !== "completed" ? 1 : 5;
      t.assertions.assert(JSON.stringify(effects.filter(e => e.input.kind === "work").map(e => e.input.value)) === JSON.stringify([1, 2, 3, 4, 5].slice(0, count)), "unexpected item work after stop/break or lost array items");
      const tail = effects.find(e => e.input.kind === "tail");
      t.assertions.assert(!!tail === (expectedStatus === "completed"), "local break swallowed outer work or global failure permitted it");
      if (tail) {
        const expected = ["break", "restart"].includes(scenario) ? { count: 1, items: [10], stopped: 2 } : { count: 5, items: [10, 20, 30, 40, 50], stopped: null };
        // JSON property order is not a contract; compare independent literal fields.
        const actual = tail.input.previous as typeof expected;
        t.assertions.assert(actual.count === expected.count && actual.stopped === expected.stopped && JSON.stringify(actual.items) === JSON.stringify(expected.items), `accumulator differs: ${JSON.stringify(actual)}`);
        const result = (run!.structure as { outcome?: { value?: typeof expected } })?.outcome?.value;
        t.assertions.assert(result?.count === actual.count && result?.stopped === actual.stopped && JSON.stringify(result?.items) === JSON.stringify(actual.items), "final computed result is not exposed by workflow get/history");
      }
    }
    if (scenario === "shape-reject" || scenario === "bounds") t.assertions.assert(existsSync(rejectionTrace) && readFileSync(rejectionTrace, "utf8").trim().split("\n").length === (scenario === "shape-reject" ? 5 : 3), "invalid result cases were not rejected before valid completion");
  } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env); await opened.mock.stop(); }
});
