import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type {
  ExecutorFlowStatus,
  SessionSummary,
  WorkflowProjectStatus,
  WorkflowRunStatus,
  WorkspaceInfo,
} from "@genehub/proto";

import { defineJourney, type CaseContext } from "../../framework/public.ts";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const PACK_ID = "game-delivery-v1";
const TEAM_NAMES = ["workflow-manager", "executor", "coder", "reviewer"] as const;

type Opened = Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>;
type JourneyMock = Opened["mock"];

interface ProjectFixture {
  opened: Opened;
  projectId: string;
  projectRoot: string;
}

interface DeliveryResult {
  flow: ExecutorFlowStatus;
  run: WorkflowRunStatus;
  sessions: SessionSummary[];
  spaces: WorkspaceInfo[];
  implementationMs: number;
}

const BASE_GAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>星尘花园</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#061225;color:#eefbff}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 20%,#183b68,#061225 65%)}
    main{width:min(920px,94vw);text-align:center}.hud{display:flex;justify-content:center;gap:2rem;margin:.8rem;font-weight:700}
    canvas{width:100%;height:auto;border:2px solid #77edff;border-radius:18px;background:#0b1d3b;box-shadow:0 18px 70px #0008}
    button{margin:.8rem;padding:.7rem 1.2rem;border:0;border-radius:999px;background:#77edff;color:#062039;font-weight:800;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>星尘花园</h1>
    <p>方向键或 WASD 移动，收集星种，避开漂浮陨石。</p>
    <div class="hud"><span id="score">星种 0</span><span id="lives">能量 3</span></div>
    <canvas id="game" width="900" height="520" aria-label="星尘花园游戏画布"></canvas>
    <button id="restart">重新开始</button>
  </main>
  <script>
    const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d');
    const keys=new Set();let player,seed,rocks,score,lives,last=0;
    addEventListener('keydown',event=>keys.add(event.key));addEventListener('keyup',event=>keys.delete(event.key));
    document.querySelector('#restart').addEventListener('click',reset);
    const randomPoint=()=>({x:50+Math.random()*800,y:70+Math.random()*390});
    function reset(){player={x:450,y:420,r:17};seed=randomPoint();rocks=Array.from({length:5},(_,i)=>({...randomPoint(),vx:(i%2?1:-1)*(45+i*8),r:15}));score=0;lives=3;sync()}
    function sync(){document.querySelector('#score').textContent='星种 '+score;document.querySelector('#lives').textContent='能量 '+lives}
    function hit(a,b,pad=0){return Math.hypot(a.x-b.x,a.y-b.y)<a.r+b.r+pad}
    function update(dt){
      const dx=(keys.has('ArrowRight')||keys.has('d')?1:0)-(keys.has('ArrowLeft')||keys.has('a')?1:0);
      const dy=(keys.has('ArrowDown')||keys.has('s')?1:0)-(keys.has('ArrowUp')||keys.has('w')?1:0);
      player.x=Math.max(20,Math.min(880,player.x+dx*240*dt));player.y=Math.max(20,Math.min(500,player.y+dy*240*dt));
      if(hit(player,{...seed,r:10})){score+=10;seed=randomPoint();sync()}
      for(const rock of rocks){rock.x+=rock.vx*dt;if(rock.x<15||rock.x>885)rock.vx*=-1;if(hit(player,rock)){lives=Math.max(0,lives-1);player.x=450;player.y=420;sync()}}
    }
    function draw(){
      ctx.clearRect(0,0,900,520);ctx.fillStyle='#ffffff18';for(let i=0;i<45;i++)ctx.fillRect((i*83)%900,(i*47)%520,2,2);
      ctx.fillStyle='#ffe36e';ctx.beginPath();ctx.arc(seed.x,seed.y,10,0,7);ctx.fill();
      ctx.fillStyle='#ff718c';for(const rock of rocks){ctx.beginPath();ctx.arc(rock.x,rock.y,rock.r,0,7);ctx.fill()}
      ctx.fillStyle=lives?'#77edff':'#777';ctx.beginPath();ctx.arc(player.x,player.y,player.r,0,7);ctx.fill();
      if(!lives){ctx.fillStyle='#fff';ctx.font='700 42px sans-serif';ctx.fillText('花园需要重新充能',245,260)}
    }
    function frame(now){const dt=Math.min(.03,(now-last)/1000||0);last=now;if(lives)update(dt);draw();requestAnimationFrame(frame)}
    reset();requestAnimationFrame(frame);
  </script>
</body>
</html>
`;

const FEATURE_GAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>星尘花园：气象远征</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#061225;color:#eefbff}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#284a79,#061225 66%)}
    main{width:min(980px,95vw);text-align:center}.hud{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin:.8rem}.card{padding:.65rem;border-radius:12px;background:#ffffff12}
    canvas{width:100%;height:auto;border:2px solid #77edff;border-radius:18px;background:#0b1d3b;box-shadow:0 18px 70px #0008}
    button{margin:.8rem;padding:.7rem 1.2rem;border:0;border-radius:999px;background:#77edff;color:#062039;font-weight:800;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>星尘花园：气象远征</h1>
    <p>在晴空、流星雨与星雾间完成每日远征；连续收集会提高倍率。</p>
    <section class="hud" id="weather-system">
      <span class="card" id="score">星种 0</span><span class="card" id="combo-meter">连击 x1</span>
      <span class="card" id="weather">天气 晴空</span><span class="card" id="mission">远征 0/12</span>
    </section>
    <canvas id="game" width="960" height="540" aria-label="气象远征游戏画布"></canvas>
    <button id="restart">重新远征</button>
  </main>
  <script>
    const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d'),keys=new Set();
    const dailyChallenge={target:12,reward:250};const weatherCycle=['晴空','流星雨','星雾'];
    let player,seed,hazards,score,combo,collected,weatherIndex,weatherClock,last=0,best=Number(localStorage.getItem('asteroidGardenBest')||0);
    addEventListener('keydown',event=>keys.add(event.key));addEventListener('keyup',event=>keys.delete(event.key));document.querySelector('#restart').onclick=reset;
    const point=()=>({x:45+Math.random()*870,y:65+Math.random()*420});
    function reset(){player={x:480,y:460,r:17};seed=point();hazards=Array.from({length:7},(_,i)=>({...point(),vx:(i%2?1:-1)*(55+i*7),vy:(i%3-1)*22,r:13}));score=0;combo=1;collected=0;weatherIndex=0;weatherClock=0;sync()}
    function sync(){document.querySelector('#score').textContent='星种 '+score+' · 最佳 '+best;document.querySelector('#combo-meter').textContent='连击 x'+combo;document.querySelector('#weather').textContent='天气 '+weatherCycle[weatherIndex];document.querySelector('#mission').textContent='远征 '+collected+'/'+dailyChallenge.target}
    const hit=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<a.r+b.r;
    function update(dt){
      weatherClock+=dt;if(weatherClock>8){weatherClock=0;weatherIndex=(weatherIndex+1)%weatherCycle.length;sync()}
      const fog=weatherCycle[weatherIndex]==='星雾'?.72:1;const dx=(keys.has('ArrowRight')||keys.has('d')?1:0)-(keys.has('ArrowLeft')||keys.has('a')?1:0);const dy=(keys.has('ArrowDown')||keys.has('s')?1:0)-(keys.has('ArrowUp')||keys.has('w')?1:0);
      player.x=Math.max(20,Math.min(940,player.x+dx*260*fog*dt));player.y=Math.max(20,Math.min(520,player.y+dy*260*fog*dt));
      if(hit(player,{...seed,r:10})){score+=10*combo;combo=Math.min(8,combo+1);collected++;seed=point();if(collected===dailyChallenge.target)score+=dailyChallenge.reward;best=Math.max(best,score);localStorage.setItem('asteroidGardenBest',String(best));sync()}
      const storm=weatherCycle[weatherIndex]==='流星雨'?1.8:1;for(const h of hazards){h.x+=h.vx*storm*dt;h.y+=h.vy*storm*dt;if(h.x<12||h.x>948)h.vx*=-1;if(h.y<12||h.y>528)h.vy*=-1;if(hit(player,h)){combo=1;player.x=480;player.y=460;sync()}}
    }
    function draw(){
      const weather=weatherCycle[weatherIndex];ctx.fillStyle=weather==='星雾'?'#243451':'#0b1d3b';ctx.fillRect(0,0,960,540);ctx.fillStyle='#ffffff22';for(let i=0;i<55;i++)ctx.fillRect((i*101)%960,(i*61)%540,2,2);
      ctx.fillStyle='#ffe36e';ctx.beginPath();ctx.arc(seed.x,seed.y,10,0,7);ctx.fill();ctx.fillStyle=weather==='流星雨'?'#ff9f68':'#ff718c';for(const h of hazards){ctx.beginPath();ctx.arc(h.x,h.y,h.r,0,7);ctx.fill()}
      ctx.fillStyle='#77edff';ctx.beginPath();ctx.arc(player.x,player.y,player.r,0,7);ctx.fill();if(collected>=dailyChallenge.target){ctx.fillStyle='#fff';ctx.font='700 36px sans-serif';ctx.fillText('今日远征完成！',335,270)}
    }
    function frame(now){const dt=Math.min(.03,(now-last)/1000||0);last=now;update(dt);draw();requestAnimationFrame(frame)}reset();requestAnimationFrame(frame);
  </script>
</body>
</html>
`;

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

async function createProject(
  t: CaseContext,
  name: string,
  initialHtml?: string,
): Promise<ProjectFixture> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  const projectRoot = path.join(opened.workspaceRoot, name);
  mkdirSync(projectRoot, { recursive: true });
  t.data.git.init(projectRoot);
  writeFileSync(path.join(projectRoot, "README.md"), `# ${name}\n`);
  if (initialHtml) writeFileSync(path.join(projectRoot, "index.html"), initialHtml);
  git(projectRoot, ["add", "."]);
  git(projectRoot, ["commit", "-m", "initial game baseline"]);

  const projectReply = await opened.client.call({
    type: "workspace.open",
    payload: { root: projectRoot },
  });
  t.assertions.assert(projectReply?.type === "workspace", "workspace.open did not return the project");
  const projectId = projectReply?.type === "workspace" ? projectReply.data.id : "";
  await t.flows.main.configureMockProvider(opened.client, opened.mock);
  return { opened, projectId, projectRoot };
}

function runGenet(
  fixture: ProjectFixture,
  args: string[],
): { status: number; data: Record<string, unknown>; text: string } {
  const result = spawnSync(fixture.opened.daemon.genet, args, {
    cwd: fixture.projectRoot,
    env: fixture.opened.daemon.env,
    encoding: "utf8",
  });
  let data: Record<string, unknown> = {};
  for (const line of result.stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const envelope = JSON.parse(line) as { data?: Record<string, unknown> };
      data = envelope.data ?? {};
    } catch {
      // Product diagnostics may surround the one JSON result.
    }
  }
  return {
    status: result.status ?? -1,
    data,
    text: `${result.stdout}\n${result.stderr}`,
  };
}

function installPack(fixture: ProjectFixture): WorkspaceInfo[] {
  const applied = runGenet(fixture, [
    "space",
    "bootstrap",
    "apply",
    "--workspace",
    fixture.projectId,
    "--pack",
    PACK_ID,
    "--agent",
    "genet",
    "--model",
    "deepseek/deepseek-v4-flash",
  ]);
  if (applied.status !== 0) throw new Error(`Bootstrap Pack failed: ${applied.text}`);
  git(fixture.projectRoot, ["add", "."]);
  git(fixture.projectRoot, ["commit", "-m", "install game delivery team"]);
  return (applied.data.spaces ?? []) as WorkspaceInfo[];
}

function scriptDelivery(
  mock: JourneyMock,
  input: {
    bootstrap: boolean;
    workflow: "project" | "feature";
    task: string;
    message: string;
    html: string;
    commitMessage: string;
    markers: string[];
  },
): void {
  const turns: Parameters<JourneyMock["script"]> = [];
  if (input.bootstrap) {
    turns.push({
      tool: {
        name: "bash",
        arguments: {
          command:
            '"$GENEHUB_CLI" space bootstrap list && "$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1 && "$GENEHUB_CLI" space bootstrap apply --pack game-delivery-v1 && git add . && git commit -m "bootstrap game delivery team"',
        },
      },
    });
  }
  turns.push(
    {
      tool: {
        name: "bash",
        arguments: {
          command: `"$GENEHUB_CLI" workflow dispatch --kind ${
            input.workflow === "project" ? "game --complexity project" : "feature --complexity complex"
          } --task ${shellArg(input.task)} --message ${shellArg(input.message)} --wait --timeout 840`,
        },
      },
    },
    { tool: { name: "write", arguments: { path: "index.html", content: input.html } } },
    {
      tool: {
        name: "bash",
        arguments: {
          command: `git add index.html && git commit -m ${shellArg(
            input.commitMessage,
          )} && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks=${shellArg(
            "html5-static-game-smoke",
          )} && sleep 2`,
        },
      },
    },
    {
      tool: {
        name: "bash",
        arguments: {
          command: `test -s index.html && ${input.markers
            .map((marker) => `grep -q ${shellArg(marker)} index.html`)
            .join(" && ")} && "$GENEHUB_CLI" workflow complete --evidence review=approved --evidence checks=${shellArg(
            "playability-and-regression-smoke",
          )}`,
        },
      },
    },
    { text: "实现节点已完成并提交。" },
    { text: "Reviewer 已完成独立验收。" },
    { text: "目标已由 Executor 推进完成。" },
  );
  mock.script(...turns);
}

async function runUserTurn(
  t: CaseContext,
  fixture: ProjectFixture,
  sessionId: string,
  prompt: string,
): Promise<number> {
  const events = await t.flows.main.attachEventLog(fixture.opened.client, sessionId);
  const startedAt = Date.now();
  await t.flows.main.sendPrompt(fixture.opened.client, sessionId, prompt);
  await t.tools.waitUntil(
    () =>
      events.some((event) => event.type === "turnCompleted") ||
      events.some((event) => event.type === "turnFailed"),
    FIFTEEN_MINUTES_MS,
  );
  const elapsedMs = Date.now() - startedAt;
  t.assertions.assert(
    events.some((event) => event.type === "turnCompleted") &&
      !events.some((event) => event.type === "turnFailed"),
    `user turn failed: ${JSON.stringify(events.slice(-12).map((event) => event.raw)).slice(-8000)}`,
  );
  t.assertions.assert(
    elapsedMs <= FIFTEEN_MINUTES_MS,
    `user-visible journey took ${elapsedMs}ms, over the 15-minute gate`,
  );
  return elapsedMs;
}

async function listSpaces(fixture: ProjectFixture): Promise<WorkspaceInfo[]> {
  const reply = await fixture.opened.client.call({ type: "workspace.list" });
  if (reply?.type !== "workspaces") throw new Error(`workspace.list returned ${reply?.type}`);
  return reply.data;
}

function teamByName(spaces: WorkspaceInfo[]): Map<string, WorkspaceInfo> {
  return new Map(
    spaces.filter((space) => TEAM_NAMES.includes(space.name as (typeof TEAM_NAMES)[number])).map((space) => [space.name, space]),
  );
}

function assertTeam(t: CaseContext, fixture: ProjectFixture, spaces: WorkspaceInfo[]): Map<string, WorkspaceInfo> {
  const team = teamByName(spaces);
  for (const name of TEAM_NAMES) {
    t.assertions.assert(Boolean(team.get(name)), `Bootstrap team omitted ${name}`);
    t.assertions.assert(
      existsSync(path.join(fixture.projectRoot, "spaces", name, ".pipebuilder", "lock.json")),
      `${name} was not built and verified by AgentSpaceBuilder`,
    );
  }
  const executor = team.get("executor")!;
  const manager = team.get("workflow-manager")!;
  const coder = team.get("coder")!;
  const reviewer = team.get("reviewer")!;
  t.assertions.assert(
    executor.agentSpace?.parentWorkspaceId === fixture.projectId &&
      executor.agentSpace.components.some((component) => component.componentId === "executor"),
    "Executor is not the project scheduling boundary",
  );
  for (const worker of [manager, coder, reviewer]) {
    t.assertions.assert(
      worker.agentSpace?.parentWorkspaceId === executor.id,
      `${worker.name} is not attached directly to Executor`,
    );
  }
  t.assertions.assert(
    manager.agentSpace?.components.some((component) => component.componentId === "executor"),
    "WorkflowManager is not a nested Executor boundary",
  );
  t.assertions.assert(
    reviewer.agentSpace?.components.some((component) => component.componentId === "reviewer"),
    "Reviewer specialization is missing",
  );
  return team;
}

async function inspectProject(fixture: ProjectFixture): Promise<WorkflowProjectStatus> {
  const reply = await fixture.opened.client.call({
    type: "workflow.inspect",
    payload: { workspaceId: fixture.projectId },
  });
  if (reply?.type !== "workflowProject") throw new Error(`workflow.inspect returned ${reply?.type}`);
  return reply.data;
}

async function assertDelivery(
  t: CaseContext,
  fixture: ProjectFixture,
  taskId: string,
  totalElapsedMs: number,
): Promise<DeliveryResult> {
  const historyReply = await fixture.opened.client.call({
    type: "workflow.history",
    payload: { workspaceId: fixture.projectId, limit: 20 },
  });
  if (historyReply?.type !== "workflowRuns") {
    throw new Error(`workflow.history returned ${historyReply?.type}`);
  }
  const run = historyReply.data.find((candidate) => candidate.taskId === taskId);
  t.assertions.assert(Boolean(run), `Workflow history omitted task ${taskId}`);
  const completed = run!;
  t.assertions.assert(completed.status === "completed", `Run ended as ${completed.status}`);
  t.assertions.assert(completed.executorTurns === 0, "deterministic Executor consumed an LLM turn");
  t.assertions.assert(Boolean(completed.executorSessionId), "Run has no Executor Session");

  const flowReply = await fixture.opened.client.call({
    type: "session.flow",
    payload: { sessionId: completed.executorSessionId ?? "missing" },
  });
  if (flowReply?.type !== "sessionFlow") throw new Error(`session.flow returned ${flowReply?.type}`);
  const flow = flowReply.data;
  const kinds = flow.messages.map((message) => message.kind);
  t.assertions.assert(
    kinds.join(",") ===
      "run.requested,node.assigned,node.completed,node.assigned,node.completed,run.completed",
    `unexpected Executor timeline: ${JSON.stringify(kinds)}`,
  );
  const implementAssigned = flow.messages.find(
    (message) => message.kind === "node.assigned" && message.nodeId === "implement",
  );
  const implementCompleted = flow.messages.find(
    (message) => message.kind === "node.completed" && message.nodeId === "implement",
  );
  const implementationMs =
    (implementCompleted?.createdAtMs ?? Number.POSITIVE_INFINITY) -
    (implementAssigned?.createdAtMs ?? 0);
  t.assertions.assert(
    implementationMs >= 0 && implementationMs <= TEN_MINUTES_MS,
    `Coder implementation took ${implementationMs}ms, over its 10-minute design budget`,
  );
  t.assertions.assert(
    totalElapsedMs <= FIFTEEN_MINUTES_MS,
    `total delivery took ${totalElapsedMs}ms, over the 15-minute gate`,
  );

  const sessionsReply = await fixture.opened.client.call({
    type: "session.list",
    payload: { workspaceId: null, includeArchived: false },
  });
  if (sessionsReply?.type !== "sessions") throw new Error(`session.list returned ${sessionsReply?.type}`);
  const sessions = sessionsReply.data;
  const workers = sessions.filter((session) => session.managed?.workflowRunId === completed.id);
  const coder = workers.find((session) => session.managed?.role === "coder");
  const reviewer = workers.find((session) => session.managed?.role === "reviewer");
  t.assertions.assert(workers.length === 2 && Boolean(coder && reviewer), "Run did not use one Coder and one Reviewer");
  t.assertions.assert(
    coder?.managed?.parentSessionId === completed.executorSessionId &&
      reviewer?.managed?.parentSessionId === completed.executorSessionId,
    "Worker Sessions are not managed by the Executor Session",
  );

  const spaces = await listSpaces(fixture);
  const team = assertTeam(t, fixture, spaces);
  t.assertions.assert(coder?.workspaceId === team.get("coder")?.id, "Coder ran outside Coder AgentSpace");
  t.assertions.assert(
    reviewer?.workspaceId === team.get("reviewer")?.id,
    "Reviewer ran outside Reviewer AgentSpace",
  );
  t.assertions.assert(
    completed.executorWorkspaceId === team.get("executor")?.id,
    "Run did not use the team's Executor AgentSpace",
  );

  const flowRoot = path.join(
    fixture.projectRoot,
    "spaces",
    "executor",
    ".genethub",
    "sessions",
    completed.executorSessionId ?? "missing",
    "components",
    "executor",
  );
  for (const file of ["manifest.json", "inbox.jsonl", "journal.jsonl", "outbox.jsonl"]) {
    t.assertions.assert(existsSync(path.join(flowRoot, file)), `Executor Session omitted ${file}`);
  }
  return { flow, run: completed, sessions, spaces, implementationMs };
}

async function dispose(fixture: ProjectFixture): Promise<void> {
  fixture.opened.client.close();
  fixture.opened.daemon.stop();
  await fixture.opened.mock.stop();
}

defineJourney(
  {
    id: "journey.workflow.pm-builds-game-with-team",
    title: "One PM request builds a four-Space team and a playable game",
    oracle:
      "one user message makes PM discover and apply a Bootstrap Pack, create WorkflowManager/Executor/Coder/Reviewer AgentSpaces, and finish a playable HTML5 game through a zero-turn Executor and independent review within 15 minutes",
    catches: [
      "team setup remains a manual prerequisite",
      "PM dispatches Worker Sessions directly",
      "Executor mechanics consume LLM turns",
      "the game is a placeholder rather than a playable loop",
      "Coder work exceeds the 10-minute implementation budget or total delivery exceeds 15 minutes",
    ],
    tags: ["core", "workflow", "v2b-three-journeys", "pm-game-project", "html-preview"],
    llm: { default: "mock", realEligible: true },
    expectedDurationMs: 90_000,
    timeoutMs: 930_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git", "asset-preview"],
    productInterfaces: ["genet space bootstrap", "genet workflow", "genet session flow"],
    retention: true,
  },
  async (t) => {
    const fixture = await createProject(t, "stardust-garden");
    try {
      scriptDelivery(fixture.opened.mock, {
        bootstrap: true,
        workflow: "project",
        task: "stardust-garden",
        message: "完成一个可玩的星尘花园小游戏，保留十分钟主实现和十五分钟总交付预算",
        html: BASE_GAME_HTML,
        commitMessage: "build stardust garden",
        markers: ["<canvas", "ArrowLeft", "requestAnimationFrame", "星种"],
      });
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const elapsedMs = await runUserTurn(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内搭好小游戏团队并交付一个可玩的星尘花园；主实现按十分钟控制。",
      );
      const delivery = await assertDelivery(t, fixture, "stardust-garden", elapsedMs);
      const html = readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8");
      for (const marker of ["<canvas", "ArrowLeft", "requestAnimationFrame", "score", "restart"]) {
        t.assertions.assert(html.includes(marker), `playable game omitted ${marker}`);
      }
      t.assertions.assert(!/https?:\/\//.test(html), "game depends on a remote asset instead of local preview files");
      t.assertions.assert(git(fixture.projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `journey=game-project elapsedMs=${elapsedMs} implementationMs=${delivery.implementationMs} pm=${pmSessionId} executor=${delivery.run.executorSessionId} run=${delivery.run.id} preview=${path.join(
          fixture.projectRoot,
          "index.html",
        )}`,
      );
    } finally {
      await dispose(fixture);
    }
  },
);

defineJourney(
  {
    id: "journey.workflow.pm-adds-complex-game-feature",
    title: "One PM request reuses the team to add a complex game feature",
    oracle:
      "given the game and four-Space team from the first journey, one user message reuses the same Executor/Coder/Reviewer AgentSpaces to add a cohesive weather, combo, persistence, and daily-mission feature within 15 minutes",
    catches: [
      "a feature request rebuilds or duplicates the team",
      "PM or Executor implements the feature instead of Coder",
      "Reviewer is omitted from the declared feature DCG",
      "the feature removes the original playable loop",
      "Coder work exceeds 10 minutes or the user-visible feature journey exceeds 15 minutes",
    ],
    tags: ["core", "workflow", "v2b-three-journeys", "pm-game-feature", "html-preview"],
    llm: { default: "mock", realEligible: true },
    expectedDurationMs: 80_000,
    timeoutMs: 930_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git", "asset-preview"],
    productInterfaces: ["genet space bootstrap", "genet workflow", "genet session flow"],
    retention: true,
  },
  async (t) => {
    const fixture = await createProject(t, "stardust-expedition", BASE_GAME_HTML);
    try {
      installPack(fixture);
      const before = assertTeam(t, fixture, await listSpaces(fixture));
      const beforeIdentity = TEAM_NAMES.map((name) => {
        const space = before.get(name)!;
        return `${name}:${space.id}:${space.agentSpace?.revision}`;
      });
      scriptDelivery(fixture.opened.mock, {
        bootstrap: false,
        workflow: "feature",
        task: "weather-expedition",
        message: "在现有玩法上加入轮换天气、连击倍率、每日远征目标和本地最佳分数",
        html: FEATURE_GAME_HTML,
        commitMessage: "add weather expedition feature",
        markers: ["weather-system", "combo-meter", "dailyChallenge", "localStorage"],
      });
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const elapsedMs = await runUserTurn(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内给现有小游戏增加一套复杂的气象远征：天气轮换、连击、每日目标和本地最佳分数；主实现按十分钟控制。",
      );
      const delivery = await assertDelivery(t, fixture, "weather-expedition", elapsedMs);
      const after = teamByName(delivery.spaces);
      const afterIdentity = TEAM_NAMES.map((name) => {
        const space = after.get(name)!;
        return `${name}:${space.id}:${space.agentSpace?.revision}`;
      });
      t.assertions.assert(
        afterIdentity.join(",") === beforeIdentity.join(","),
        `feature delivery rebuilt the team: before=${beforeIdentity} after=${afterIdentity}`,
      );
      t.assertions.assert(delivery.run.workflowId === "game-feature", "PM selected the wrong project DCG");
      const html = readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8");
      for (const marker of [
        "weather-system",
        "combo-meter",
        "dailyChallenge",
        "localStorage",
        "ArrowLeft",
        "requestAnimationFrame",
      ]) {
        t.assertions.assert(html.includes(marker), `complex feature omitted ${marker}`);
      }
      t.assertions.assert(git(fixture.projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `journey=game-feature elapsedMs=${elapsedMs} implementationMs=${delivery.implementationMs} pm=${pmSessionId} executorSpace=${delivery.run.executorWorkspaceId} executorSession=${delivery.run.executorSessionId} run=${delivery.run.id}`,
      );
    } finally {
      await dispose(fixture);
    }
  },
);

defineJourney(
  {
    id: "journey.workflow.manager-improves-dcg-from-run",
    title: "WorkflowManager analyzes a real Run and produces an inactive DCG Candidate",
    oracle:
      "from its own AgentSpace, one WorkflowManager request reads structured Run history and Executor flow, changes only project Workflow assets, evaluates the changed DCG, and leaves a distinct reviewable Candidate without activating it",
    catches: [
      "WorkflowManager analyzes chat impressions rather than structured run facts",
      "the analysis cannot access Executor Session flow",
      "workflow policy is hard-coded in daemon and cannot be changed as project assets",
      "the improvement silently activates itself",
      "WorkflowManager modifies game implementation or creates another Worker Run",
      "the analysis-and-improvement request exceeds 15 minutes",
    ],
    tags: ["core", "workflow", "v2b-three-journeys", "workflow-manager", "dcg-candidate"],
    llm: { default: "mock", realEligible: true },
    expectedDurationMs: 110_000,
    timeoutMs: 930_000,
    resources: { environments: 1, cpu: 2, memoryMb: 768, io: 1, browser: 0, pool: "standard" },
    surfaces: ["daemon", "agent", "genet-cli", "workbench-client", "git"],
    productInterfaces: ["genet workflow history", "genet session flow", "genet workflow inspect"],
    retention: true,
  },
  async (t) => {
    const fixture = await createProject(t, "stardust-workflow-lab", BASE_GAME_HTML);
    try {
      installPack(fixture);
      scriptDelivery(fixture.opened.mock, {
        bootstrap: false,
        workflow: "feature",
        task: "evidence-baseline",
        message: "加入气象远征，作为后续 Workflow 分析的真实完成样本",
        html: FEATURE_GAME_HTML,
        commitMessage: "add evidence baseline feature",
        markers: ["weather-system", "combo-meter", "dailyChallenge", "localStorage"],
      });
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const baselineElapsedMs = await runUserTurn(
        t,
        fixture,
        pmSessionId,
        "先完成气象远征 Feature，给 WorkflowManager 留下一条真实结构化执行记录。",
      );
      const baseline = await assertDelivery(t, fixture, "evidence-baseline", baselineElapsedMs);
      const before = await inspectProject(fixture);
      const runCountBefore = (await fixture.opened.client.call({
        type: "workflow.history",
        payload: { workspaceId: fixture.projectId, limit: 20 },
      }));
      t.assertions.assert(runCountBefore?.type === "workflowRuns", "baseline history is unavailable");
      const managedBefore = baseline.sessions.filter((session) => session.managed?.workflowRunId).length;

      const team = assertTeam(t, fixture, baseline.spaces);
      const managerSpace = team.get("workflow-manager")!;
      const managerSessionId = await t.flows.main.createBuiltinSession(
        fixture.opened.client,
        managerSpace.id,
      );
      const componentsReply = await fixture.opened.client.call({
        type: "session.components",
        payload: { sessionId: managerSessionId },
      });
      t.assertions.assert(
        componentsReply?.type === "sessionComponents" &&
          componentsReply.data.some((component) => component.componentId === "worker") &&
          componentsReply.data.some((component) => component.componentId === "executor"),
        "WorkflowManager Session did not auto-instantiate its Worker and Executor Components",
      );

      const promptPath = path.join(
        fixture.projectRoot,
        ".genethub",
        "workflow",
        "prompts",
        "coder.md",
      );
      fixture.opened.mock.script(
        {
          tool: {
            name: "bash",
            arguments: { command: '"$GENEHUB_CLI" workflow history --limit 20' },
          },
        },
        {
          tool: {
            name: "edit",
            arguments: {
              path: promptPath,
              edits: [
                {
                  oldText: "完成后运行真实检查并提交到当前租约 ref。",
                  newText:
                    "完成后先运行与变更相关的静态检查和最小玩法回归，再提交到当前租约 ref。",
                },
              ],
            },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: { command: "node skills/workflow-manager/scripts/evaluate.mjs" },
          },
        },
        {
          tool: {
            name: "bash",
            arguments: {
              command:
                'git -C ../.. add .genethub/workflow/prompts/coder.md && git -C ../.. commit -m "improve game delivery workflow"',
            },
          },
        },
        {
          text: "已基于结构化 Run 和 Executor 流程记录形成并评估新 Candidate；它保持未激活，可由用户审阅后决定是否晋级。",
        },
      );
      const elapsedMs = await runUserTurn(
        t,
        fixture,
        managerSessionId,
        "请分析刚才的 Workflow 执行记录，改进下一次交付的检查质量；完成评估但不要激活，十五分钟内给我结果。",
      );

      const after = await inspectProject(fixture);
      t.assertions.assert(before.activeDigest === after.activeDigest, "WorkflowManager changed the active DCG");
      t.assertions.assert(
        before.activationRevision === after.activationRevision,
        "WorkflowManager changed the activation revision",
      );
      t.assertions.assert(after.sourceChanged, "Workflow improvement did not produce changed project source");
      t.assertions.assert(
        Boolean(after.candidateDigest) && after.candidateDigest !== after.activeDigest,
        "Workflow improvement did not produce a distinct inactive Candidate",
      );

      const reportPath = path.join(
        fixture.projectRoot,
        "spaces",
        "workflow-manager",
        ".genethub",
        "sessions",
        managerSessionId,
        "components",
        "worker",
        "evaluations",
        "latest.json",
      );
      t.assertions.assert(
        existsSync(reportPath),
        `WorkflowManager did not persist its evaluation report; requests=${JSON.stringify(
          fixture.opened.mock.requests.slice(-6),
        ).slice(-12000)}`,
      );
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        status?: string;
        activeDigest?: string;
        candidateDigest?: string;
        activationRevision?: number;
        analyzedRuns?: string[];
        analyzedMessages?: number;
        nodeDurations?: Array<{ runId: string; nodeId: string; durationMs: number }>;
        finding?: { code: string; runId: string; nodeId: string; durationMs: number };
        hypothesis?: string;
        comparisonPlan?: string;
        changedFiles?: string[];
        checks?: string[];
      };
      t.assertions.assert(report.status === "passed", "Workflow Candidate evaluation did not pass");
      t.assertions.assert(
        report.activeDigest === before.activeDigest && report.candidateDigest === after.candidateDigest,
        "evaluation report is not bound to active and Candidate digests",
      );
      t.assertions.assert(
        report.activationRevision === before.activationRevision,
        "evaluation report used a different activation revision",
      );
      t.assertions.assert(
        report.analyzedRuns?.includes(baseline.run.id) &&
          (report.analyzedMessages ?? 0) >= baseline.flow.messages.length,
        "evaluation report is not based on the completed structured Run",
      );
      t.assertions.assert(
        report.nodeDurations?.some(
          (duration) =>
            duration.runId === baseline.run.id &&
            duration.nodeId === "implement" &&
            duration.durationMs >= 0,
        ) &&
          report.finding?.code === "longest-node" &&
          Boolean(report.hypothesis) &&
          report.comparisonPlan?.includes("inactive"),
        "WorkflowManager did not turn structured timing into a reviewable improvement hypothesis",
      );
      t.assertions.assert(
        report.changedFiles?.join(",") === ".genethub/workflow/prompts/coder.md",
        `evaluation escaped Workflow assets: ${JSON.stringify(report.changedFiles)}`,
      );
      t.assertions.assert(
        report.checks?.includes("candidate.remainsInactive"),
        "evaluation omitted the inactive-Candidate guard",
      );

      const runCountAfter = await fixture.opened.client.call({
        type: "workflow.history",
        payload: { workspaceId: fixture.projectId, limit: 20 },
      });
      t.assertions.assert(
        runCountAfter?.type === "workflowRuns" &&
          runCountBefore?.type === "workflowRuns" &&
          runCountAfter.data.length === runCountBefore.data.length,
        "WorkflowManager analysis created an undeclared Worker Run",
      );
      const sessionsAfterReply = await fixture.opened.client.call({
        type: "session.list",
        payload: { workspaceId: null, includeArchived: false },
      });
      t.assertions.assert(sessionsAfterReply?.type === "sessions", "session.list failed after analysis");
      const managedAfter =
        sessionsAfterReply?.type === "sessions"
          ? sessionsAfterReply.data.filter((session) => session.managed?.workflowRunId).length
          : -1;
      t.assertions.assert(managedAfter === managedBefore, "WorkflowManager created extra managed Workers");
      t.assertions.assert(git(fixture.projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `journey=workflow-improvement elapsedMs=${elapsedMs} baselineImplementationMs=${baseline.implementationMs} manager=${managerSessionId} active=${after.activeDigest} candidate=${after.candidateDigest} analyzedRun=${baseline.run.id}`,
      );
    } finally {
      await dispose(fixture);
    }
  },
);
