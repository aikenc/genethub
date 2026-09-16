import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { defineJourney } from "../../framework/public.ts";

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
type Contract = { id: string; goal: string; criteria: Array<{ id: string; requirement: string; method: string }> };
type Assignment = { phase: string; accepted?: Contract[]; previousFailure?: { contract: Contract }; contract?: Contract; milestoneId?: string; criterion?: { id: string }; artifact?: { commit: string } };

// Read daemon-issued approvals and real Worker assignments, never synthesize a scheduler.
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

for (const scenario of ["milestones", "replan", "exhausted", "no-go", "budget-gate", "budget-query-gate", "empty-plan"] as const) defineJourney({
  id: `journey.workflow.pack-development.${scenario}`,
  title: `Installed game-dev closes ${scenario} inside one Executor Run`,
  oracle: "The installed Pack drives four dynamic contracts and every criterion; bounded rejection stops later milestones, retains accepted contracts and replans without another PM dispatch; non-go never publishes",
  catches: ["business sequencing leaks into PM", "fixed milestone slots", "accepted work is repeated", "rejection starts later milestones", "missing checklist items pass", "no-go is reported as delivery"],
  tags: ["core", "workflow", "unified-game-dev", "bootstrap-pack"],
  llm: { default: "mock" }, expectedDurationMs: 45_000, timeoutMs: 240_000,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["session.send", "session.respondPermission", "genet space bootstrap", "genet workflow", "workflow.history"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    rmSync(path.join(opened.workspaceRoot, ".keep"));
    for (const [key, value] of [["user.name", "Pack Journey"], ["user.email", "pack@example.com"], ["commit.gpgsign", "false"]]) {
      const result = spawnSync("git", ["config", "--global", key!, value!], { env: opened.daemon.env, encoding: "utf8" });
      t.assertions.assert(result.status === 0, "isolated Git setup failed");
    }
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    const contracts: Contract[] = [1, 2, 3, 4].map(n => ({ id: `m${n}`, goal: `Deliver artifact m${n}`,
      criteria: [{ id: "exists", requirement: `m${n}.txt is committed`, method: "inspect the supplied commit" },
        { id: "correct", requirement: `m${n}.txt contains :ok:`, method: "read committed and working content" }] }));
    const events: Assignment[] = [], seen = new Set<string>(), attempts = new Map<string, number>();
    let pmStage = 0, budgetCommand: string | undefined;
    const budgetReady = path.join(t.env.root, "budget-amended");
    opened.mock.script(...Array.from({ length: 160 }, () => ({ respond: (request: unknown) => {
      const body = JSON.stringify(request), input = assignment(request);
      if (body.includes("<genehub_managed_session>") && input) {
        const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
        if (!operation) throw new Error("Worker has no operation identity");
        if (seen.has(operation)) return { text: "Result submitted." };
        seen.add(operation); events.push(input);
        if (input.phase === "requirements") {
          const output = { decision: scenario === "no-go" ? "noGo" : scenario === "budget-gate" ? "needsAuthorization" : "go",
            scope: "Four artifact contracts; original target unchanged", feasibility: "Bounded local edits", risks: "No external effects", budgetAdvice: "Remain within the existing request envelope",
            milestones: scenario === "empty-plan" ? [] : contracts };
          const waitBudget = scenario === "budget-query-gate" ? `for i in $(seq 1 600); do test -f ${q(budgetReady)} && break; sleep 0.05; done; test -f ${q(budgetReady)} && ` : "";
          return { tool: { name: "bash", arguments: { command: `${waitBudget}"$GENEHUB_CLI" workflow complete --output ${q(JSON.stringify(output))}` } } };
        }
        const id = input.contract?.id ?? input.milestoneId;
        if (!id || !contracts.some(c => c.id === id)) throw new Error("Worker has no bound contract");
        const file = `${id}.txt`;
        if (input.phase === "implementation") {
          const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
          const defect = id === "m2" && (scenario === "exhausted" || (scenario === "replan" && count <= 2));
          return { tool: { name: "bash", arguments: { command: `cd ${q(opened.workspaceRoot)} && printf '%s\\n' ${q(`${id}:${defect ? "needs-fix" : "ok"}:attempt-${count}`)} > ${q(file)} && git add -- ${q(file)} && git commit -m ${q(`deliver ${id} attempt ${count}`)} && test -s ${q(file)} && "$GENEHUB_CLI" workflow complete --evidence "commit=$(git rev-parse HEAD)" --evidence ${q(`checks=read ${file}`)}` } } };
        }
        if (input.phase !== "acceptance-item" || !input.criterion || !input.artifact?.commit) throw new Error("Reviewer lacks criterion or artifact identity");
        if (input.contract) throw new Error("Per-item Reviewer input redundantly includes the complete milestone contract");
        const check = `const fs=require('fs'),cp=require('child_process');const f=${JSON.stringify(file)},commit=${JSON.stringify(input.artifact.commit)};const content=fs.readFileSync(f,'utf8');const saved=cp.execFileSync('git',['show',commit+':'+f],{encoding:'utf8'});const passed=content===saved&&${input.criterion.id === "exists" ? "content.length>0" : "content.includes(':ok:')"};process.stdout.write(JSON.stringify({passed,finding:passed?'criterion verified':'artifact still needs repair',evidence:commit+':'+f+':${input.criterion.id}'}));`;
        const ready = path.join(t.env.root, `review-${input.artifact.commit}-${input.criterion.id}`);
        const sibling = path.join(t.env.root, `review-${input.artifact.commit}-${input.criterion.id === "exists" ? "correct" : "exists"}`);
        const barrier = `touch ${q(ready)}; for i in $(seq 1 300); do test -f ${q(sibling)} && break; sleep 0.05; done; test -f ${q(sibling)}`;
        return { tool: { name: "bash", arguments: { command: `cd ${q(opened.workspaceRoot)} && ${barrier} && "$GENEHUB_CLI" workflow complete --output "$(node -e ${q(check)})"` } } };
      }
      if (budgetCommand) { const command = budgetCommand; budgetCommand = undefined; return { tool: { name: "bash", arguments: { command } } }; }
      const stage = pmStage++;
      if (stage === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1' } } };
      if (stage === 1) return { tool: { name: "request_user_input", arguments: { questions: [{ id: field(request, "challengeId"), header: "接管", question: "确认接管测试项目", options: [{ label: "yes", description: "接管" }, { label: "no", description: "拒绝" }] }] } } };
      if (stage === 2) return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${field(request, "planDigest")} --expected-revision ${field(request, "expectedRevision")} --action-id install-pack` } } };
      if (stage === 3) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow dispatch --workflow game-dev --task four-contracts --message "Deliver all four contracts inside this Workflow; preserve accepted work on replan" --no-wait' } } };
      return { text: "Inspect the result; do not dispatch another milestone Run." };
    } })));
    const pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    const snapshot = async (): Promise<SessionSnapshot> => {
      const reply = await opened.client.call({ type: "session.get", payload: { sessionId: pm } });
      if (reply?.type !== "snapshot") throw new Error("missing PM");
      return reply.data;
    };
    await t.flows.main.sendPrompt(opened.client, pm, "Install the default Pack and execute the four-contract development request.");
    await t.tools.waitUntil(async () => (await snapshot()).pendingPermissions.length > 0, 40_000);
    const permission = (await snapshot()).pendingPermissions[0]!;
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: permission.id, outcome: { outcome: "selected", optionId: "approve-once" } } });
    let run: WorkflowRunStatus | undefined;
    if (scenario === "budget-query-gate") {
      await t.tools.waitUntil(async () => {
        const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
        if (reply?.type !== "workflowRuns") throw new Error("missing history");
        run = reply.data[0]; return !!run && events.some(e => e.phase === "requirements");
      }, 45000);
      budgetCommand = `"$GENEHUB_CLI" workflow budget --run ${q(run!.id)} --revision 0 --max-llm-rounds 31 && touch ${q(budgetReady)}`;
      await opened.client.call({ type: "session.send", payload: { sessionId: pm, messageId: "u_budget_amendment",
        text: "Limit this request to 31 rounds. Preserve the configured admission policy and report any gap.",
        attachments: [], continuesRound: null, artifactPreviewBaseUrl: null,
      } });
    }
    await t.tools.waitUntil(async () => {
      const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 10 } });
      if (reply?.type !== "workflowRuns") throw new Error("missing history");
      t.assertions.assert(reply.data.length <= 1, "PM split the business flow into multiple Runs");
      run = reply.data[0]; return !!run && ["completed", "blocked", "failed", "cancelled"].includes(run.status);
    }, 180_000).catch(async error => { throw new Error(`${scenario}: ${error}; events=${JSON.stringify(events)}; run=${JSON.stringify(run)}; pm=${JSON.stringify((await snapshot()).items).slice(-6000)}`); });
    t.assertions.assert(run!.workflowId === "game-dev" && !!run!.executorSessionId, "installed development bypassed the Executor");
    t.assertions.assert(run!.status === (scenario === "exhausted" ? "blocked" : "completed"), `unexpected terminal facts: ${JSON.stringify(run)}`);
    const plans = events.filter(e => e.phase === "requirements"), writes = events.filter(e => e.phase === "implementation").map(e => e.contract!.id);
    const reviews = events.filter(e => e.phase === "acceptance-item");
    const noWork = ["no-go", "budget-gate", "empty-plan"].includes(scenario);
    const expected = noWork ? [] : scenario === "budget-query-gate" ? ["m1"] : scenario === "exhausted" ? ["m1", ...Array.from({ length: 6 }, () => "m2")] : scenario === "replan" ? ["m1", "m2", "m2", "m2", "m3", "m4"] : ["m1", "m2", "m3", "m4"];
    t.assertions.assert(JSON.stringify(writes) === JSON.stringify(expected), `unexpected milestone execution order: ${writes}`);
    t.assertions.assert(reviews.length === (scenario === "budget-query-gate" ? 0 : writes.length * 2), "a declared criterion was omitted or replayed, or started without admission");
    for (let i = 0; i < reviews.length; i += 2) t.assertions.assert(JSON.stringify(reviews.slice(i, i + 2).map(r => r.criterion!.id).sort()) === '["correct","exists"]', "criterion identities drifted across parallel repairs");
    t.assertions.assert(plans.length === (scenario === "exhausted" ? 3 : scenario === "replan" ? 2 : 1), "planning bound or replan was lost");
    for (const replan of plans.slice(1)) {
      t.assertions.assert(replan.accepted?.length === 1 && replan.accepted[0]!.id === "m1" && replan.previousFailure?.contract.id === "m2", "replan lost accepted work or failure context");
      t.assertions.assert(replan.accepted![0]!.criteria.length === 2, "accepted contract lost its original criteria");
    }
    const outcome = (run!.structure as { outcome?: { value?: { done: boolean; accepted: Contract[]; delivered: unknown[] } } })?.outcome?.value;
    const noDelivery = noWork || scenario === "budget-query-gate";
    if (scenario !== "exhausted") t.assertions.assert(outcome?.done === !noDelivery && outcome.accepted.length === (noDelivery ? 0 : 4) && outcome.delivered.length === (noDelivery ? 0 : 4), "execution completion was confused with accepted delivery");
    if (scenario === "budget-query-gate") t.assertions.assert(JSON.stringify(outcome).includes('"needsAuthorization":true') && existsSync(path.join(opened.workspaceRoot, "m1.txt"))
      && !existsSync(path.join(opened.workspaceRoot, "m2.txt")) && !run!.nodes.some(n => n.uses === "result.publish"), "budget gap lost the artifact, started later work or published");
    if (noWork || scenario === "exhausted") t.assertions.assert(!existsSync(path.join(opened.workspaceRoot, "m3.txt")), "later work started after refusal");
    const pmSource = readFileSync(path.join(opened.workspaceRoot, ".pipebuilder/skills/project-manager/SKILL.md"), "utf8");
    t.assertions.assert(pmSource === readFileSync(path.join(t.openRoot, "apps/daemon/bootstrap-packs/game-delivery-v1/project/.pipebuilder/skills/project-manager/SKILL.md"), "utf8"), "installed PM methods differ from the shipped source");
    t.note(`one Executor Run; ${plans.length} plans, ${writes.length} real committed edits, ${reviews.length} commit-bound criterion checks; this proves scripted mechanics, not autonomous PM judgment`);
  } finally { opened.client.close(); opened.daemon.stop(); await opened.mock.stop(); }
});
