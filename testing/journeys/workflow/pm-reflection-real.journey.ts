import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { SessionSnapshot, WorkflowRunStatus } from "@genehub/proto";
import { BlockedError, connectProductClient, daemonEndpoint, defineJourney, runGenetAsync } from "../../framework/public.ts";

function field(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    for (const line of value.split("\n").reverse()) {
      try { const found = field(JSON.parse(line), key); if (found !== undefined) return found; } catch { /* prose */ }
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    for (const child of Object.values(record).reverse()) { const found = field(child, key); if (found !== undefined) return found; }
  }
  return undefined;
}

for (const scenario of ["correction", "workflow-intent", "self-method"] as const) defineJourney({
  id: `journey.workflow.pm-reflection-real.${scenario}`,
  title: `Real installed PM handles ${scenario} through existing product interfaces`,
  oracle: "After mechanical takeover setup, the configured real model corrects delegation or updates its own project method; read-only follow-up does not start implementation, activate a candidate or repeat a Run",
  catches: ["scripted PM answers are sold as autonomous behavior", "workflow pseudocode becomes PM milestone dispatches", "self-improvement edits only generated assets", "an explanatory follow-up repeats execution"],
  tags: ["workflow", "pm-reflection-real"], llm: { default: "real" },
  expectedDurationMs: 180_000, timeoutMs: 600_000, retention: true,
  resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "real-llm" },
  surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
  productInterfaces: ["session.send", "session.respondPermission", "genet workflow build", "genet space builder", "genet workflow", "workflow.history"],
}, async t => {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  // The Agent's `git clone` step, performed by the fixture: a package is an
  // ordinary directory until `workflow build` authorizes its components.
  t.flows.main.clonePackage({ openRoot: t.openRoot, projectRoot: opened.workspaceRoot });
  const cli = async (args: string[]) => {
    const result = await runGenetAsync(opened.daemon.genet, args, opened.daemon.env, { cwd: opened.workspaceRoot });
    t.assertions.assert(result.code === 0, result.stderr || result.stdout); return result.stdout;
  };
  const snapshot = async (sessionId: string): Promise<SessionSnapshot> => {
    const reply = await opened.client.call({ type: "session.get", payload: { sessionId } });
    if (reply?.type !== "snapshot") throw new Error("missing PM snapshot"); return reply.data;
  };
  const history = async (): Promise<WorkflowRunStatus[]> => {
    const reply = await opened.client.call({ type: "workflow.history", payload: { workspaceId: opened.workspaceId, limit: 20 } });
    if (reply?.type !== "workflowRuns") throw new Error("missing Run facts"); return reply.data;
  };
  try {
    rmSync(path.join(opened.workspaceRoot, ".keep"));
    for (const [key, value] of [["user.name", "Real PM Trial"], ["user.email", "pm@example.com"], ["commit.gpgsign", "false"]]) {
      t.assertions.assert(spawnSync("git", ["config", "--global", key!, value!], { env: opened.daemon.env }).status === 0, "isolated Git setup failed");
    }
    await t.flows.main.configureMockProvider(opened.client, opened.mock);
    let stage = 0;
    // Script only permission/setup. The last reply deliberately establishes a
    // mistaken PM judgment in real session history, not an injected tool fact.
    opened.mock.script(...Array.from({ length: 12 }, () => ({ respond: (request: unknown) => {
      const current = stage++;
      if (current === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow build --package game-delivery' } } };
      if (current === 1) return { tool: { name: "request_user_input", arguments: { questions: [{ id: field(request, "challengeId"), header: "接管", question: "确认接管测试项目", options: [{ label: "yes", description: "接管" }, { label: "no", description: "拒绝" }] }] } } };
      if (current === 2) return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow build --package game-delivery --apply --plan-digest ${field(request, "planDigest")} --revision ${field(request, "expectedRevision")} --action-id install-real-pm-trial` } } };
      return { text: "项目已接管。我先前把远程攻击理解成远程联机，把工作流伪代码当成 PM 的逐项派发任务，并把灰烬包生成完成等同于正式发布完成。这些判断还没有核对。" };
    } })));
    let pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
    await t.flows.main.sendPrompt(opened.client, pm, "接管项目。后续我会纠正之前的项目判断，暂不委派其他工作。");
    await t.tools.waitUntil(async () => (await snapshot(pm)).pendingPermissions.length > 0, 40_000);
    const permission = (await snapshot(pm)).pendingPermissions[0]!;
    await opened.client.call({ type: "session.respondPermission", payload: { sessionId: pm, requestId: permission.id, outcome: { outcome: "selected", optionId: "approve-once" } } });
    await t.tools.waitUntil(async () => stage >= 4 && (await snapshot(pm)).summary.status === "idle", 50_000);
    opened.client.close(); await cli(["daemon", "stop"]);
    t.flows.main.seedHostBetaProviders(t.env); // No credentials enter prompts or reports.
    await cli(["daemon", "start"]); opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
    const mockCalls = opened.mock.requests.length;
    const before = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    if (before?.type !== "workflowProject") throw new Error("installed catalog unavailable");
    const head = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: opened.workspaceRoot, env: opened.daemon.env, encoding: "utf8" }).stdout.trim();
    const originalHead = head();
    const turn = async (prompt: string) => {
      const events = await t.flows.main.attachEventLog(opened.client, pm);
      await t.flows.main.sendPrompt(opened.client, pm, prompt);
      await t.tools.waitUntil(async () => events.some(e => e.type === "turnFailed") || (events.some(e => e.type === "turnCompleted") && (await snapshot(pm)).summary.status === "idle"), 240_000);
      const failed = events.find(e => e.type === "turnFailed");
      if (failed) {
        const detail = JSON.stringify(failed.raw);
        if (/Insufficient Balance|402.*Payment Required/.test(detail)) throw new BlockedError("configured real PM provider has insufficient balance (HTTP 402); behavioral validation did not run");
        throw new Error(`real PM turn failed: ${detail.slice(0, 1500)}`);
      }
      t.assertions.assert((await snapshot(pm)).pendingPermissions.length === 0, "routine project decision was sent back as unnecessary approval");
      t.note(`Prompt: ${prompt}\nReply: ${JSON.stringify((await snapshot(pm)).summary.messagePreview ?? {}).slice(0, 900)}`);
    };
    if (scenario === "correction") {
      await turn("纠正你上一条：远程攻击是 ranged combat，不是联机。我的原目标是评估近战与远程战斗的实现范围。先请业务团队只做可行性评估，保留未知项，绝不开发或改工作流。你也要核对并修正自己的理解和委派。");
      await t.tools.waitUntil(async () => (await history()).some(r => r.status === "completed" || r.status === "blocked"), 180_000);
      const runs = await history();
      t.assertions.assert(runs.length === 1 && runs[0]!.workflowId === "game-assessment" && runs[0]!.status === "completed", "real PM failed to correct business delegation");
      t.assertions.assert(runs[0]!.nodes.every(n => n.uses !== "agent.session" || n.evidence.report), "assessment lacks its returned business report");
      await turn("只解释这次你纠正了什么、团队还不确定什么；评估报告完成不代表游戏已经交付，不要启动新任务，也不要沉淀一次性结论。");
      t.assertions.assert((await history()).length === 1 && head() === originalHead, "read-only correction or follow-up started implementation");
    } else if (scenario === "workflow-intent") {
      await turn("纠正：下面是完整 Workflow 需求，不是 PM 的逐里程碑任务清单：需求评审→遍历动态里程碑→开发自测→逐项交付评审→本项最多两次尝试，仍未过则 break→保留已验收成果重规划，全部在一个 Executor Run 闭环。先交 WM 对照当前配置，吻合可给出有依据的无需修改结论。不激活，不制作游戏，不让 PM 拆成多个开发 Run。");
      const runs = await history();
      t.assertions.assert(runs.length === 1 && runs[0]!.workflowId === "workflow-improvement", "real PM executed the pseudocode instead of delegating its whole requirement to WM");
      await t.tools.waitUntil(async () => ["completed", "blocked"].includes((await history())[0]!.status), 180_000);
      await turn("这次只说明证据范围：即使 WM 给出 structure passed，也不能直接证明改进有效。先保留未验证结论，不再启动实验、评审或开发，不激活。");
      t.assertions.assert((await history()).length === 1, "evidence explanation triggered another delegation");
    } else {
      await turn("纠正你上一条：本项目的‘灰烬包’只是内部体验材料，绝不等于正式发布。请保留这个反证、修正和适用范围，写进本项目自己的共享 Skill 层 .genethub/skills/project-lessons/SKILL.md，并通过已有 Builder 构建验证它对本项目生效；PM 的通用方法是产品内置，不要改它，也不要改 Workflow、Worker 或公共平台规则，不委派游戏开发。后续相关任务应先检索这条项目经验。");
      // PM's general method is a product built-in; a project-specific lesson
      // belongs in the project's own Skill layer, which is exactly what
      // `.genethub/skills/` is for.
      const source = path.join(opened.workspaceRoot, ".genethub/skills/project-lessons");
      t.assertions.assert(existsSync(path.join(source, "SKILL.md")) && readFileSync(path.join(source, "SKILL.md"), "utf8").length > 0, "PM did not persist a project-scoped lesson");
      const snap = JSON.stringify((await snapshot(pm)).items);
      t.assertions.assert(snap.includes("builder") && snap.includes("build") && snap.includes("verify"), "PM did not exercise source-to-generated method validation");
      pm = await t.flows.main.createBuiltinSession(opened.client, opened.workspaceId);
      await turn("灰烬包已生成。请先检索本项目沉淀的相关经验，再说明当前能确认的交付状态；本轮仅解释，不修改文件，不发布，不开新任务。");
      t.assertions.assert(JSON.stringify((await snapshot(pm)).items).includes("project-lessons.md"), "subsequent PM did not retrieve the applicable project method");
      t.assertions.assert((await history()).length === 0, "PM method correction became a business Workflow Run");
    }
    const after = await opened.client.call({ type: "workflow.inspect", payload: { workspaceId: opened.workspaceId } });
    t.assertions.assert(after?.type === "workflowProject" && after.data.activationRevision === before.data.activationRevision, "reflection activated an unverified candidate");
    t.assertions.assert(opened.mock.requests.length === mockCalls, "behavioral trial accidentally used scripted LLM responses");
    t.note("Real-model canary validates these observed actions only; not a claim of universal or long-term autonomous reflection.");
  } finally { opened.client.close(); await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env); await opened.mock.stop(); }
});
