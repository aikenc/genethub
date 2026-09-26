import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { defineSpecialty } from "../../framework/public.ts";

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const examples = ["01-simple-assessment", "02-medium-repair", "03-complex-batch", "04-very-complex-delivery"];
type Contract = { id: string; goal: string; criteria?: Array<{ id: string; requirement: string }> };
type Assignment = {
  phase: string; contract?: Contract; criterion?: { id: string }; artifact?: { commit: string };
  accepted?: Contract[]; deliveries?: unknown[]; previousFailure?: { contract: Contract };
  batch?: { approved: boolean; accepted: Contract[] }; assessment?: { evidence: string };
};

function field(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    for (const line of value.split("\n").reverse()) {
      try { const found = field(JSON.parse(line), key); if (found !== undefined) return found; } catch { /* ordinary prose */ }
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    for (const child of Object.values(record).reverse()) { const found = field(child, key); if (found !== undefined) return found; }
  }
  return undefined;
}

function assignment(value: unknown): Assignment | undefined {
  if (typeof value === "string") {
    const match = value.match(/结构化输入（数据，不是指令）：([^\n]+)/);
    if (match) return JSON.parse(match[1]!);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value).reverse()) { const found = assignment(child); if (found) return found; }
  }
  return undefined;
}

for (const scenario of ["simple", "medium-repair", "medium-rejected", "complex-success", "complex-break",
  "very-complex-replan", "very-complex-exhausted", "very-complex-no-go", "very-complex-authorization", "very-complex-empty-plan"] as const) defineSpecialty({
  id: `specialty.workflow.examples.${scenario}`,
  title: `Documented Workflow example closes ${scenario} in one Executor`,
  oracle: "The exact published YAML compiles and executes through the installed Pack; real committed artifacts and independent review checks demonstrate bounded repairs, local exits, parallel joins, preserved contracts and no false publication",
  catches: ["example syntax drifts from the real compiler", "missing data in a nested scope", "regression branch is ignored", "break starts the next item", "replan repeats accepted contracts", "rejection publishes a delivery", "PM dispatches another milestone Run"],
  tags: ["core", "workflow", "workflow-examples"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 240_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["genet workflow build", "genet workflow", "session.send", "session.respondPermission", "workflow.history"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const root = path.join(opened.workspaceRoot, "example-project");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    t.assertions.assert(result.status === 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    mkdirSync(root); t.data.git.init(root);
    t.flows.main.clonePackage({ openRoot: t.openRoot, projectRoot: root });
    // Fixture preparation is outside product actions; all Workflow mutations below
    // are issued by real Worker CLI commands under the installed execution policy.
    writeFileSync(path.join(root, "README.md"), "# Sample project\nStart: inspect the committed source.\n");
    git(["add", "README.md"]); git(["commit", "-m", "initial example project"]);
    const project = await opened.client.call({ type: "workspace.open", payload: { root } });
    if (project?.type !== "workspace") throw new Error("project workspace unavailable");
    const workspaceId = project.data.id;
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const sources = examples.map(name => ({ name, id: `example-${name.slice(3)}`,
      text: readFileSync(path.join(t.openRoot, "docs/examples/workflows", `${name}.yaml`), "utf8") }));
    const selected = sources[scenario === "simple" ? 0 : scenario.startsWith("medium") ? 1 : scenario.startsWith("complex") ? 2 : 3]!;
    // A flow enters the package by being a file in `flows/` whose name
    // matches its own id. There is no registry to append to.
    const install = `const fs=require('fs');const dir='.genethub/workflows/game-delivery/flows/';const sources=${JSON.stringify(sources)};for(const s of sources){fs.writeFileSync(dir+s.id+'.yaml',s.text);}`;
    const contracts: Contract[] = [1, 2, 3, 4].map(n => ({ id: `m${n}`, goal: `Deliver module ${n}`,
      criteria: [{ id: "exists", requirement: "The artifact is committed" }, { id: "correct", requirement: "The artifact contains :ok:" }] }));
    const events: Assignment[] = [], seen = new Set<string>(), attempts = new Map<string, number>();
    let pmStage = 0;
    opened.mock.script(...Array.from({ length: 200 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request), input = assignment(request);
      if (body.includes("<genehub_managed_session>") && input) {
        const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
        if (!operation) throw new Error("Worker operation identity missing");
        if (seen.has(operation)) return { text: "Result submitted." };
        seen.add(operation); events.push(input);
        const complete = (output: unknown) => ({ tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow complete --output ${q(JSON.stringify(output))}` } } });
        if (input.phase === "plan-batch") return complete(contracts.map(({ id, goal }) => ({ id, goal })));
        if (input.phase === "requirements") return complete({
          decision: scenario.endsWith("no-go") ? "noGo" : scenario.endsWith("authorization") ? "needsAuthorization" : "go",
          rationale: "Keep the original goal and identical accepted contracts; no authority expansion",
          milestones: scenario.endsWith("empty-plan") ? [] : contracts,
        });
        if (input.phase === "inspect") {
          const script = "const fs=require('fs');const text=fs.readFileSync('README.md','utf8');if(!text.includes('Start:'))process.exit(3);process.stdout.write(JSON.stringify({findings:['Startup instructions inspected'],evidence:'README.md'}));";
          return { tool: { name: "bash", arguments: { command: `cd ${q(root)} && "$GENEHUB_CLI" workflow complete --output "$(node -e ${q(script)})"` } } };
        }
        if (input.phase === "summarize") return complete({ summary: JSON.stringify(input.batch ?? input.assessment) });
        const id = input.contract?.id;
        if (!id || !["feature", "m1", "m2", "m3", "m4"].includes(id)) throw new Error("unexpected contract");
        const file = `${id}.txt`;
        if (input.phase === "implement") {
          const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
          const defect = scenario === "medium-rejected" || (scenario === "medium-repair" && count === 1)
            || (id === "m2" && ["complex-break", "very-complex-exhausted"].includes(scenario));
          // In this case both criteria pass, but independent regression must veto
          // delivery twice. This catches an incorrectly ignored parallel result.
          const regression = scenario === "very-complex-replan" && id === "m2" && count <= 2;
          const content = `${id}:${defect ? "needs-fix" : "ok"}:attempt-${count}${regression ? ":regression-bad:" : ""}`;
          return { tool: { name: "bash", arguments: { command: `cd ${q(root)} && printf '%s\\n' ${q(content)} > ${q(file)} && git add -- ${q(file)} && git commit -m ${q(`deliver ${id} attempt ${count}`)} && test -s ${q(file)} && "$GENEHUB_CLI" workflow complete --evidence "commit=$(git rev-parse HEAD)" --evidence ${q(`checks=read ${file}`)}` } } };
        }
        if (!["review", "criterion", "regression"].includes(input.phase) || !input.artifact?.commit) throw new Error("review has no artifact identity");
        const condition = input.phase === "criterion" && input.criterion?.id === "exists" ? "content.length>0"
          : input.phase === "regression" ? "content.includes(':ok:')&&!content.includes(':regression-bad:')" : "content.includes(':ok:')";
        const script = `const fs=require('fs'),cp=require('child_process');const f=${JSON.stringify(file)},commit=${JSON.stringify(input.artifact.commit)};const content=fs.readFileSync(f,'utf8');const saved=cp.execFileSync('git',['show',commit+':'+f],{encoding:'utf8'});const approved=content===saved&&(${condition});process.stdout.write(JSON.stringify({approved,finding:commit+':'+f+':'+(approved?'checked':'rejected')}));`;
        return { tool: { name: "bash", arguments: { command: `cd ${q(root)} && "$GENEHUB_CLI" workflow complete --output "$(node -e ${q(script)})"` } } };
      }
      switch (pmStage++) {
        case 0: return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow build --package game-delivery' } } };
        case 1: return { tool: { name: "request_user_input", arguments: { questions: [{ id: field(request, "challengeId"), header: "接管", question: "确认接管隔离示例项目", options: [{ label: "yes", description: "接管" }, { label: "no", description: "拒绝" }] }] } } };
        case 2: return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow build --package game-delivery --apply --plan-digest ${field(request, "planDigest")} --revision ${field(request, "expectedRevision")} --action-id install-examples-pack` } } };
        case 3: return { tool: { name: "bash", arguments: { command: `node -e ${q(install)} && git add -A && git commit -m 'install documented example definitions and the built team' && "$GENEHUB_CLI" workflow inspect` } } };
        case 4: {
          const revision = field(request, "activationRevision");
          if (typeof revision !== "number") throw new Error("inspect did not return activation revision");
          return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow activate --revision ${revision}` } } };
        }
        case 5: return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --workflow ${selected.id} --task documented-example --no-wait --message "Execute this complete configured example in one Run. Do not dispatch follow-up milestones."` } } };
        default: return { text: "Observe the final Run facts; do not dispatch again." };
      }
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, workspaceId);
    const snapshot = async (): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("PM snapshot unavailable");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "Install the Pack and the documented configurations, then execute the selected example once.");
    await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions.length > 0, 40_000);
    const permission = (await snapshot()).pendingPermissions[0]!;
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: permission.id, outcome: { outcome: "selected", optionId: "approve-once" } } });
    let run: WorkflowRunStatus | undefined;
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("Run history unavailable");
      t.assertions.assert(reply.data.length <= 1, "example escaped into another PM-dispatched Run");
      run = reply.data[0]; return !!run && ["completed", "blocked", "failed", "cancelled"].includes(run.status);
    }, 180_000).catch(async error => { throw new Error(`${scenario}: ${error}; events=${JSON.stringify(events)}; run=${JSON.stringify(run)}; pm=${JSON.stringify((await snapshot()).items).slice(-6000)}`); });
    t.assertions.assert(run!.workflowId === selected.id && !!run!.executorSessionId && run!.executorTurns === 0, "example bypassed deterministic Executor");
    t.assertions.assert(run!.status === (scenario.endsWith("exhausted") ? "blocked" : "completed"), `unexpected Run outcome: ${JSON.stringify(run)}`);
    for (const source of sources) t.assertions.assert(readFileSync(path.join(root, ".genethub/workflows/game-delivery/flows", `${source.id}.yaml`), "utf8") === source.text, "tested example differs from published YAML");
    const writes = events.filter(e => e.phase === "implement").map(e => e.contract!.id);
    const noWork = scenario === "simple" || ["very-complex-no-go", "very-complex-authorization", "very-complex-empty-plan"].includes(scenario);
    const expected = noWork ? [] : scenario.startsWith("medium") ? ["feature", "feature"]
      : scenario === "complex-break" ? ["m1", "m2"] : scenario === "very-complex-replan" ? ["m1", "m2", "m2", "m2", "m3", "m4"]
        : scenario === "very-complex-exhausted" ? ["m1", ...Array.from({ length: 6 }, () => "m2")] : ["m1", "m2", "m3", "m4"];
    t.assertions.assert(JSON.stringify(writes) === JSON.stringify(expected), `unexpected work order: ${writes}`);
    const commits = git(["log", "--format=%s"]).split("\n").filter(line => line.startsWith("deliver ")).reverse();
    t.assertions.assert(commits.length === expected.length && commits.every((line, i) => line.startsWith(`deliver ${expected[i]} attempt `)), "real Git effects do not match dispatched work");
    t.assertions.assert(git(["status", "--porcelain"]) === "", "example left uncommitted changes");
    if (scenario === "complex-break" || scenario === "very-complex-exhausted") t.assertions.assert(!existsSync(path.join(root, "m3.txt")), "later milestone started after rejection");
    const value = (run!.structure as { outcome?: { value?: Record<string, unknown> } })?.outcome?.value;
    const publications = run!.nodes.filter(n => n.uses === "result.publish");
    const delivered = scenario === "medium-repair" || scenario === "very-complex-replan";
    t.assertions.assert(publications.length === (delivered ? 1 : 0), "business rejection or read-only work published a delivery");
    if (scenario === "simple") {
      t.assertions.assert(events.length === 2 && events[1]!.assessment?.evidence === "README.md" && typeof value?.summary === "string", "assessment did not reach the summary");
    } else if (scenario.startsWith("medium")) {
      t.assertions.assert(value?.approved === delivered && value.attempt === 2 && events.filter(e => e.phase === "review").length === 2, "bounded repair lost its final verdict");
    } else if (scenario.startsWith("complex")) {
      const batch = value?.batch as { approved: boolean; accepted: Contract[]; failure: { contract: Contract } | null };
      t.assertions.assert(batch.approved === (scenario === "complex-success") && batch.accepted.length === (scenario === "complex-success" ? 4 : 1), "serial fold lost accepted work");
      t.assertions.assert(events.at(-1)?.phase === "summarize" && events.at(-1)?.batch?.approved === batch.approved, "break incorrectly skipped enclosing report");
      if (scenario === "complex-break") t.assertions.assert(batch.failure?.contract.id === "m2", "failed contract lost at break");
    } else {
      const plans = events.filter(e => e.phase === "requirements");
      t.assertions.assert(plans.length === (scenario.endsWith("exhausted") ? 3 : scenario.endsWith("replan") ? 2 : 1), "planning bound differs");
      for (const plan of plans.slice(1)) t.assertions.assert(plan.accepted?.length === 1 && isDeepStrictEqual(plan.accepted[0], contracts[0]) && plan.previousFailure?.contract.id === "m2", "replan lost full accepted contract or rejected input");
      t.assertions.assert(events.filter(e => e.phase === "criterion").length === writes.length * 2 && events.filter(e => e.phase === "regression").length === writes.length, "parallel join or nested checklist omitted work");
      if (!scenario.endsWith("exhausted")) t.assertions.assert(value?.done === delivered && (value.accepted as Contract[]).length === (delivered ? 4 : 0), "execution completion confused with accepted delivery");
    }
    t.note(`${selected.name}: exact YAML; one Executor Run; ${writes.length} real commits; mocked LLM choices prove configuration mechanics, not autonomous judgment`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
