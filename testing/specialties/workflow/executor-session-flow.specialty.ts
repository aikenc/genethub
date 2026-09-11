import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { connectProductClient, daemonEndpoint, defineSpecialty, runGenetAsync } from "../../framework/public.ts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fieldFromRequest(value: unknown, field: string): unknown {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = fieldFromRequest(value[index], field);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record[field] !== undefined) return record[field];
    for (const child of Object.values(record).reverse()) {
      const found = fieldFromRequest(child, field);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  for (const candidate of [value, ...value.split("\n")]) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const found = fieldFromRequest(JSON.parse(trimmed) as unknown, field);
      if (found !== undefined) return found;
    } catch {
      // Tool results may contain prose around their JSON envelope.
    }
  }
  const quoted = value.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  if (quoted) return quoted[1];
  const numeric = value.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return numeric ? Number(numeric[1]) : undefined;
}

for (const outcome of ["approved", "repaired", "exhausted", "cancel-handoff", "restart-handoff", "corrupt-frontier"] as const) defineSpecialty(
  {
    id: outcome === "approved" ? "specialty.workflow.executor-session-flow" : `specialty.workflow.executor-session-flow.${outcome}`,
    title: "Executor Session drives Coder and Reviewer with structured messages",
    oracle:
      "one ordinary PM turn discovers and applies the game Bootstrap Pack, commits its project assets, and dispatches the project DCG; one non-LLM Executor Session owns the Run snapshot and structured timeline while Coder and Reviewer execute in their attached AgentSpaces",
    catches: [
      "the PM has to know a hard-coded Pack id that cannot be discovered",
      "bootstrap leaves the project dirty so the first Coder cannot obtain its write lease",
      "the PM remains the direct parent of Worker Sessions",
      "role labels do not resolve to the Coder and Reviewer AgentSpaces",
      "Worker Sessions bind to their role but start in the project root and load the PM Skill",
      "Executor state remains only in daemon-private runtime",
      "mechanical DCG transitions consume Executor LLM turns",
      "FlowMessages are chat text or omit the Coder-to-Reviewer transition",
    ],
    tags: ["core", "workflow", "executor", "flow-message", "agent-space", "bootstrap-pack", "session-control-fixes", ...(outcome === "restart-handoff" ? ["workflow-restart-handoff"] : [])],
    llm: { default: "mock" },
    expectedDurationMs: 55_000,
    timeoutMs: 150_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
    productInterfaces: ["genet space bootstrap", "genet workflow", "genet session flow"],
  },
  async (t) => {
    const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
    try {
      const repairs = outcome === "repaired" || outcome === "exhausted";
      const projectRoot = path.join(opened.workspaceRoot, "asteroid-garden");
      mkdirSync(projectRoot, { recursive: true });
      t.data.git.init(projectRoot);
      writeFileSync(path.join(projectRoot, "README.md"), "# Asteroid Garden\n");
      git(projectRoot, ["add", "README.md"]);
      git(projectRoot, ["commit", "-m", "initial game project"]);

      const projectReply = await opened.client.call({
        type: "workspace.open",
        payload: { root: projectRoot },
      });
      t.assertions.assert(projectReply?.type === "workspace", "workspace.open did not return the project");
      const projectId = projectReply?.type === "workspace" ? projectReply.data.id : "";

      await t.flows.main.configureMockProvider(opened.client, opened.mock);
      const gameHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Asteroid Garden</title><style>body{margin:0;background:#08152b;color:#fff;font:16px sans-serif;text-align:center}canvas{background:#10264c;border:2px solid #79e8ff;margin:20px}</style></head><body><h1>Asteroid Garden</h1><p>方向键移动，收集星种</p><canvas id="game" width="640" height="360"></canvas><script>const c=document.querySelector('#game'),x=c.getContext('2d');let px=320,score=0;addEventListener('keydown',e=>{px+=e.key==='ArrowLeft'?-20:e.key==='ArrowRight'?20:0;score++;draw()});function draw(){x.fillStyle='#10264c';x.fillRect(0,0,c.width,c.height);x.fillStyle='#79e8ff';x.fillRect(px,300,28,28);x.fillStyle='#fff';x.fillText('星种 '+score,20,30)}draw()</script></body></html>`;
      let pmStage = 0;
      const coderOperations = new Set<string>();
      const reviewerOperations = new Set<string>();
      const coderStages = { implement: 0, repair: 0 };
      const reviewerStages = { review: 0, after: 0 };
      let pmAtReview: number | undefined;
      let repairedFromFinding = false;
      const respond = (request: unknown) => {
        const body = JSON.stringify(request);
        if (body.includes("你是小游戏项目的 Coder")) {
          const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
          if (operation) coderOperations.add(operation);
          const repairing = operation ? [...coderOperations].indexOf(operation) > 0 : body.includes("当前节点：repair");
          const stage = coderStages[repairing ? "repair" : "implement"]++;
          if (repairing && stage === 0) {
            repairedFromFinding = body.includes("startup-ready-defect") && body.includes("runtime-start-failed");
            t.assertions.assert(pmStage === pmAtReview, "ordinary rework woke PM instead of following the workflow");
          }
          if (stage === 0) {
            return {
              tool: {
                name: "write",
                arguments: { path: path.join(projectRoot, "index.html"), content: gameHtml + (repairing ? "<!-- startup-fixed -->" : "") },
              },
            };
          }
          if (stage === 1) {
            return {
              tool: {
                name: "bash",
                arguments: {
                  command: `cd ${shellArg(projectRoot)} && git add index.html && git commit -m "build asteroid garden" && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks="index-html-static-smoke"`,
                },
              },
            };
          }
          return { text: "实现节点已完成。" };
        }
        if (body.includes("你是小游戏项目的 Reviewer")) {
          const operation = body.match(/当前节点：(operation-\d+)/)?.[1];
          if (operation) reviewerOperations.add(operation);
          const afterRepair = operation ? [...reviewerOperations].indexOf(operation) > 0 : body.includes("当前节点：review-after-repair");
          const stage = reviewerStages[afterRepair ? "after" : "review"]++;
          if (!afterRepair && stage === 0) pmAtReview = pmStage;
          if (afterRepair && stage === 0) t.assertions.assert(pmStage === pmAtReview, "rereview consumed a PM turn");
          if (stage === 0 && repairs && (!afterRepair || outcome === "exhausted")) return {
            tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --outcome changesRequested --reason startup-ready-defect --evidence checks=runtime-start-failed' } }
          };
          if (stage === 0) {
            return {
              tool: {
                name: "bash",
                arguments: {
                  command: `cd ${shellArg(projectRoot)} && test -s index.html && grep -q "<canvas" index.html && grep -q "ArrowLeft" index.html && rejected=$("$GENEHUB_CLI" workflow complete --evidence review=rejected --evidence checks="canvas-input-smoke" 2>&1); status=$?; test "$status" -ne 0 && printf "%s" "$rejected" | grep -q "必须等于" && "$GENEHUB_CLI" workflow complete --evidence review=approved --evidence checks="canvas-input-smoke"`,
                },
              },
            };
          }
          return { text: "评审已通过。" };
        }

        const stage = pmStage++;
        if (stage === 0) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space inspect' } } };
        }
        if (stage === 1) {
          return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" space bootstrap list' } } };
        }
        if (stage === 2) {
          return {
            tool: {
              name: "bash",
              arguments: { command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1' },
            },
          };
        }
        if (stage === 3) {
          const challengeId = fieldFromRequest(request, "challengeId");
          if (typeof challengeId !== "string") throw new Error(`plan omitted challengeId: ${body.slice(-4000)}`);
          return {
            tool: {
              name: "request_user_input",
              arguments: {
                questions: [
                  {
                    id: challengeId,
                    header: "项目接管",
                    question: "是否按这一份计划转换为 PM 驱动项目？",
                    options: [
                      { label: "确认", description: "只允许这一份计划执行一次。" },
                      { label: "暂不", description: "保持项目不变。" },
                    ],
                  },
                ],
              },
            },
          };
        }
        if (stage === 4) {
          const planDigest = fieldFromRequest(request, "planDigest");
          const expectedRevision = fieldFromRequest(request, "expectedRevision");
          if (typeof planDigest !== "string" || typeof expectedRevision !== "number") {
            throw new Error(`approved turn lost plan facts: ${body.slice(-5000)}`);
          }
          return {
            tool: {
              name: "bash",
              arguments: {
                command: `"$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 --plan-digest ${shellArg(planDigest)} --expected-revision ${expectedRevision} --action-id bootstrap-asteroid-garden && cat .pipebuilder/skills/project-manager/SKILL.md && "$GENEHUB_CLI" workflow dispatch --kind game --complexity project --task asteroid-garden --no-wait --message "制作一个可玩的太空花园小游戏，方向键移动、收集星种并显示得分。"`,
              },
            },
          };
        }
        if (stage === 5) return { text: "Executor 已接收目标。" };
        return { text: "小游戏已经由 Coder 实现并由 Reviewer 验收。" };
      };
      opened.mock.script(...Array.from({ length: 48 }, () => ({ respond })));

      const pmSessionId = await t.flows.main.createBuiltinSession(opened.client, projectId);
      const pmEvents = await t.flows.main.attachEventLog(opened.client, pmSessionId);
      await t.flows.main.sendPrompt(
        opened.client,
        pmSessionId,
        "请搭建小游戏开发团队，并完成一个可以用方向键收集星种的太空花园小游戏。",
      );
      await t.tools.waitUntil(
        () =>
          pmEvents.some((event) => {
            const inner = t.flows.main.sessionEventOf(event);
            const request = inner?.request as { kind?: string } | undefined;
            return inner?.type === "permissionRequested" && request?.kind === "planApproval";
          }),
        120_000,
      );
      const requested = pmEvents.find((event) => {
        const inner = t.flows.main.sessionEventOf(event);
        const request = inner?.request as { kind?: string } | undefined;
        return inner?.type === "permissionRequested" && request?.kind === "planApproval";
      });
      const requestId = requested
        ? (t.flows.main.sessionEventOf(requested)?.request as { id?: string } | undefined)?.id
        : undefined;
      if (!requestId) throw new Error("PM takeover request omitted request id");
      const approval = await opened.client.call({
        type: "session.respondPermission",
        payload: {
          sessionId: pmSessionId,
          requestId,
          outcome: { outcome: "selected", optionId: "approve-once" },
        },
      });
      t.assertions.assert(approval?.type === "ack", `Human approval failed: ${JSON.stringify(approval)}`);
      await t.tools.waitUntil(
        async () => {
          const reply = await opened.client.call({type: "session.get", payload: {sessionId: pmSessionId}});
          return reply?.type === "snapshot" && reply.data.summary.status === "idle" && !reply.data.pendingPermissions?.length;
        },
        40_000,
      );
      t.assertions.assert(
        pmEvents.some((event) => event.type === "turnCompleted") &&
          !pmEvents.some((event) => event.type === "turnFailed"),
        `PM turn failed: ${JSON.stringify(pmEvents.slice(-10).map((event) => event.raw)).slice(-6000)}`,
      );

      if (outcome === "cancel-handoff" || outcome === "restart-handoff" || outcome === "corrupt-frontier") {
        let accepted: import("@genehub/proto").WorkflowRunStatus | undefined;
        await t.tools.waitUntil(async () => {
          const result = await opened.client.call({type: "workflow.history", payload: {workspaceId: projectId, limit: 10}});
          accepted = result?.type === "workflowRuns" ? result.data[0] : undefined;
          return accepted?.nodes.some(node => node.status === "finishing") === true;
        }, 35_000);
        if (outcome === "cancel-handoff") {
          const callsBefore = pmStage;
          await opened.client.call({type: "workflow.cancel", payload: {workspaceId: projectId, runId: accepted!.id, expectedRevision: accepted!.revision}});
          await t.tools.waitUntil(async () => {
            const result = await opened.client.call({type: "workflow.get", payload: {workspaceId: projectId, runId: accepted!.id}});
            if (result?.type !== "workflowRun" || result.data.status !== "cancelled") return false;
            t.assertions.assert(result.data.nodes.filter(node => node.sessionId).length === 1 && !result.data.reportPending,
              "cancellation during handoff launched a successor or PM report");
            return true;
          }, 35_000);
          await new Promise(resolve => setTimeout(resolve, 3_000));
          t.assertions.assert(pmStage === callsBefore, "handoff cancellation woke PM");
          t.note("Accepted node result retained; direct cancellation prevented successor activation.");
          return;
        }
        opened.client.close();
        // Keep the external mock HTTP server responsive while the real daemon
        // stops/starts; a synchronous child command blocks this Node event loop.
        const stopped = await runGenetAsync(opened.daemon.genet, ["daemon", "stop"], opened.daemon.env);
        t.assertions.assert(stopped.code === 0, `daemon stop failed: ${stopped.stderr}`);
        if (outcome === "corrupt-frontier") {
          const snapshotPath = path.join(projectRoot,"spaces","executor",".genethub","sessions",accepted!.executorSessionId!,"components","executor","snapshots",`run-${accepted!.id}.json`);
          const saved = JSON.parse(readFileSync(snapshotPath,"utf8"));
          t.assertions.assert(!!saved.run.engine,"fault fixture lacks a structured snapshot");
          saved.run.engine.frames[saved.run.engine.root].cursor = {phase:"selected",child:999999};
          writeFileSync(snapshotPath,JSON.stringify(saved));
          t.note("Daemon stopped; changed the isolated persisted root cursor to an invalid child before restart.");
        }
        const started = await runGenetAsync(opened.daemon.genet, ["daemon", "start"], opened.daemon.env);
        t.assertions.assert(started.code === 0, `daemon restart failed: ${started.stderr}`);
        opened.client = await connectProductClient(daemonEndpoint(opened.daemon));
        if (outcome === "corrupt-frontier") {
          await t.tools.waitUntil(async()=>{
            const reply = await opened.client.call({type:"workflow.get",payload:{workspaceId:projectId,runId:accepted!.id}});
            if(reply?.type !== "workflowRun" || reply.data.status !== "blocked") return false;
            t.assertions.assert(reply.data.reason?.includes("快照") && reply.data.nodes.filter(n=>n.sessionId).length === 1,"invalid snapshot guessed a successor or concealed its reason");
            const worker=reply.data.nodes.find(n=>n.sessionId)!;
            const session=await opened.client.call({type:"session.get",payload:{sessionId:worker.sessionId!}});
            return session?.type === "snapshot" && session.data.summary.status === "closed";
          },35_000);
          return;
        }
      }
      await t.tools.waitUntil(async () => {
        const history = await opened.client.call({
          type: "workflow.history",
          payload: { workspaceId: projectId, limit: 10 },
        });
        return history?.type === "workflowRuns" && history.data.length === 1 && history.data.some((run) => run.status === (outcome === "exhausted" ? "blocked" : "completed"));
      }, 140_000);
      const listed = await opened.client.call({
        type: "session.list",
        payload: { workspaceId: null, includeArchived: false },
      });
      t.assertions.assert(listed?.type === "sessions", `session.list returned ${listed?.type}`);
      const sessions = listed?.type === "sessions" ? listed.data : [];
      const workers = sessions.filter((session) => session.managed?.workflowRunId);
      t.assertions.assert(
        workers.length === (repairs ? 4 : 2),
        `expected Coder and Reviewer, got ${JSON.stringify(workers)}; PM events=${JSON.stringify(
          pmEvents.map((event) => event.raw),
        ).slice(-12000)}; requests=${JSON.stringify(opened.mock.requests).slice(-8000)}`,
      );
      const coder = workers.find((session) => session.managed?.role === "coder");
      const reviewer = workers.find((session) => session.managed?.role === "reviewer");
      t.assertions.assert(Boolean(coder && reviewer), "Coder or Reviewer Session is missing");
      const runId = coder?.managed?.workflowRunId ?? "missing";

      const runReply = await opened.client.call({
        type: "workflow.get",
        payload: { workspaceId: projectId, runId },
      });
      t.assertions.assert(runReply?.type === "workflowRun", `workflow.get returned ${runReply?.type}`);
      const run = runReply?.type === "workflowRun" ? runReply.data : undefined;
      t.assertions.assert(
        run?.status === (outcome === "exhausted" ? "blocked" : "completed"),
        `Run ended as ${run?.status}; run=${JSON.stringify(run)}; sessions=${JSON.stringify(sessions)}; PM=${JSON.stringify(
          pmEvents.map((event) => event.raw),
        ).slice(-12000)}`,
      );
      t.assertions.assert(run?.executorTurns === 0, "deterministic Executor used an LLM turn");
      t.assertions.assert(Boolean(run?.executorSessionId), "Run has no Executor Session");
      t.assertions.assert(
        coder?.managed?.parentSessionId === run?.executorSessionId &&
          reviewer?.managed?.parentSessionId === run?.executorSessionId,
        "Workers are not children of the Executor Session",
      );

      const spacesReply = await opened.client.call({ type: "workspace.list" });
      t.assertions.assert(spacesReply?.type === "workspaces", "workspace.list failed");
      const spaces = spacesReply?.type === "workspaces" ? spacesReply.data : [];
      const coderSpace = spaces.find((space) => space.name === "coder");
      const reviewerSpace = spaces.find((space) => space.name === "reviewer");
      const executorSpace = spaces.find((space) => space.name === "executor");
      t.assertions.assert(coder?.workspaceId === coderSpace?.id, "Coder did not run in Coder AgentSpace");
      t.assertions.assert(
        reviewer?.workspaceId === reviewerSpace?.id,
        "Reviewer did not run in Reviewer AgentSpace",
      );
      const sessionMeta = (spaceRoot: string, sessionId: string) =>
        JSON.parse(
          readFileSync(
            path.join(spaceRoot, ".genethub", "sessions", sessionId, "meta.json"),
            "utf8",
          ),
        ) as { cwd?: string; managedSystemPrompt?: string };
      const coderMeta = sessionMeta(coderSpace?.root ?? "missing", coder?.id ?? "missing");
      const reviewerMeta = sessionMeta(
        reviewerSpace?.root ?? "missing",
        reviewer?.id ?? "missing",
      );
      t.assertions.assert(
        path.resolve(coderMeta.cwd ?? "missing") === path.resolve(coderSpace?.root ?? "missing"),
        "Coder Session cwd is not the Coder AgentSpace root",
      );
      t.assertions.assert(
        path.resolve(reviewerMeta.cwd ?? "missing") ===
          path.resolve(reviewerSpace?.root ?? "missing"),
        "Reviewer Session cwd is not the Reviewer AgentSpace root",
      );
      t.assertions.assert(
        coderMeta.managedSystemPrompt?.includes(
          `任务工作目录（JSON 字符串）是 ${JSON.stringify(projectRoot)}`,
        ) === true,
        "Coder Session did not receive the distinct project task cwd",
      );
      t.assertions.assert(
        run?.executorWorkspaceId === executorSpace?.id,
        "Run did not reuse the Executor AgentSpace",
      );

      const flowReply = await opened.client.call({
        type: "session.flow",
        payload: { sessionId: run?.executorSessionId ?? "missing" },
      });
      t.assertions.assert(flowReply?.type === "sessionFlow", `session.flow returned ${flowReply?.type}`);
      const flow = flowReply?.type === "sessionFlow" ? flowReply.data : undefined;
      const kinds = flow?.messages.filter(message=>message.kind !== "structure.transition").map((message) => message.kind) ?? [];
      const terminal = outcome === "exhausted" ? "run.blocked" : "run.completed";
      const expected = ["run.requested", "node.assigned", "node.completed", "node.assigned", "node.completed"];
      if (repairs) expected.push("node.assigned", "node.completed", "node.assigned", "node.completed");
      expected.push(terminal);
      t.assertions.assert(kinds.join(",") === expected.join(","), `unexpected FlowMessage timeline: ${JSON.stringify(kinds)}`);
      t.assertions.assert(flow?.run.status === run?.status, "Executor flow snapshot disagrees with Run");
      const implementations = run!.nodes.filter(node=>workers.some(w=>w.id === node.sessionId && w.managed?.role === "coder"))
        .sort((a,b)=>(a.assignedAtMs ?? 0)-(b.assignedAtMs ?? 0));
      const [implementation,repair] = implementations;
      if (!repairs) {
        t.assertions.assert(!repair, "approval unnecessarily launched repair");
      } else {
        t.assertions.assert(repairedFromFinding, "repair assignment omitted the review reason and evidence");
        t.assertions.assert(repair?.evidence.commit && repair.evidence.commit !== implementation?.evidence.commit,
          "repair reused the first commit instead of acquiring a fresh baseline");
        t.assertions.assert(git(projectRoot, ["rev-parse", "HEAD"]) === repair?.evidence.commit, "repair evidence does not name the actual target commit");
      }
      t.assertions.assert(run!.nodes.some(n=>n.uses === "result.publish" && n.status === "completed") === (outcome !== "exhausted"), "publication ignored final review");
      t.assertions.assert(!!run!.structure,"default development template is not structured");
      t.assertions.assert(workers.every(worker => worker.status === "closed"), "terminal nodes left live execution owners");

      const executorRoot = path.join(projectRoot, "spaces", "executor");
      const flowRoot = path.join(
        executorRoot,
        ".genethub",
        "sessions",
        run?.executorSessionId ?? "missing",
        "components",
        "executor",
      );
      const snapshot = JSON.parse(readFileSync(path.join(flowRoot, "snapshots", `run-${runId}.json`), "utf8"));
      t.assertions.assert(snapshot.run.flowMessages.some((message: {kind: string}) => message.kind === terminal), "the durable Run is missing its terminal flow message");
      for (const obsolete of ["manifest.json", "inbox.jsonl", "journal.jsonl", "outbox.jsonl"]) {
        t.assertions.assert(!existsSync(path.join(flowRoot, obsolete)), "Run writes redundant flow projections");
      }
      t.assertions.assert(existsSync(path.join(projectRoot, "index.html")), "game entry was not produced");
      t.assertions.assert(git(projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `pm=${pmSessionId} executor=${run?.executorSessionId} coder=${coder?.id} reviewer=${reviewer?.id} run=${runId}`,
      );
    } finally {
      opened.client.close();
      await runGenetAsync(opened.daemon.genet,["daemon","stop"],opened.daemon.env);
      await opened.mock.stop();
    }
  },
);
