import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const TEAM_NAMES = ["workflow-manager", "workflow-reviewer", "executor", "coder", "reviewer"] as const;

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

interface DeliveryScript {
  workflow: "project" | "feature";
  task: string;
  userMarker: string;
  message: string;
  html: string;
  commitMessage: string;
  markers: string[];
  bootstrap: boolean;
}

interface UserDeliveryTiming {
  activeMs: number;
  wallMs: number;
  humanWaitMs: number;
}

type SessionEventLog = Awaited<ReturnType<CaseContext["flows"]["main"]["attachEventLog"]>>;

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

const PROJECT_DELIVERY: DeliveryScript = {
  workflow: "project",
  task: "stardust-garden",
  userMarker: "可玩的星尘花园",
  message: "完成一个可玩的星尘花园小游戏，保留十分钟主实现和十五分钟总交付预算",
  html: BASE_GAME_HTML,
  commitMessage: "build stardust garden",
  markers: ["<canvas", "ArrowLeft", "requestAnimationFrame", "星种"],
  bootstrap: true,
};

const FEATURE_DELIVERY: DeliveryScript = {
  workflow: "feature",
  task: "weather-expedition",
  userMarker: "复杂的气象远征",
  message: "在现有玩法上加入轮换天气、连击倍率、每日远征目标和本地最佳分数",
  html: FEATURE_GAME_HTML,
  commitMessage: "add weather expedition feature",
  markers: ["weather-system", "combo-meter", "dailyChallenge", "localStorage"],
  bootstrap: false,
};

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
): Promise<ProjectFixture> {
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  for (const [key, value] of [
    ["user.name", "Journey User"],
    ["user.email", "journey@example.com"],
    ["commit.gpgsign", "false"],
  ] as const) {
    const configured = spawnSync("git", ["config", "--global", key, value], {
      env: opened.daemon.env,
      encoding: "utf8",
    });
    if (configured.status !== 0) {
      throw new Error(`cannot configure the isolated developer identity: ${configured.stderr}`);
    }
  }
  const projectRoot = path.join(opened.workspaceRoot, name);
  mkdirSync(projectRoot, { recursive: true });

  const projectReply = await opened.client.call({
    type: "workspace.open",
    payload: { root: projectRoot },
  });
  t.assertions.assert(projectReply?.type === "workspace", "workspace.open did not return the project");
  const projectId = projectReply?.type === "workspace" ? projectReply.data.id : "";
  await t.flows.main.configureMockProvider(opened.client, opened.mock);
  return { opened, projectId, projectRoot };
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
  const candidates = [value, ...value.split("\n")];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const found = fieldFromRequest(parsed, field);
      if (found !== undefined) return found;
    } catch {
      // A tool result can contain prose around its JSON envelope.
    }
  }
  const quoted = value.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  if (quoted) return quoted[1];
  const numeric = value.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
  return numeric ? Number(numeric[1]) : undefined;
}

function deliveryForRequest(request: unknown, deliveries: DeliveryScript[]): DeliveryScript | undefined {
  const body = JSON.stringify(request);
  return [...deliveries].reverse().find(
    (delivery) => body.includes(delivery.task) || body.includes(delivery.userMarker),
  );
}

function scriptProductJourney(
  mock: JourneyMock,
  projectRoot: string,
  deliveries: DeliveryScript[],
  managerPromptPath?: string,
): void {
  const pmStages = new Map<string, number>();
  const coderStages = new Map<string, number>();
  const reviewerStages = new Map<string, number>();
  let managerStage = 0;
  let improvementDispatched = false;
  let improvementRetried = false;
  let reviewDispatched = false;
  let qualityStage = 0;
  let trialPmStage = 0;
  let trialCoderStage = 0;
  let trialReviewerStage = 0;
  const root = shellArg(projectRoot);

  const respond = (request: unknown): Omit<Parameters<JourneyMock["script"]>[number], "respond"> => {
    const body = JSON.stringify(request);
    const delivery = deliveryForRequest(request, deliveries);

    if (managerPromptPath && body.includes("实验运行 J3")) {
      const trialRoot = path.join(projectRoot, "experiments", "v2");
      if (body.includes("你是小游戏项目的 Coder")) {
        if (trialCoderStage++ === 0) return { tool: { name: "write", arguments: { path: path.join(trialRoot, "index.html"), content: "<!doctype html><title>Experimental game</title><p>trial-only-result</p>" } } };
        if (trialCoderStage === 2) return { tool: { name: "bash", arguments: { command: `cd ${shellArg(trialRoot)} && git add index.html && git commit -m "experiment result" && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks=experimental-artifact-check` } } };
        return { text: "实验实现完成。" };
      }
      if (body.includes("你是小游戏项目的 Reviewer")) {
        if (trialReviewerStage++ === 0) return { tool: { name: "bash", arguments: { command: `cd ${shellArg(trialRoot)} && grep -q trial-only-result index.html && "$GENEHUB_CLI" workflow complete --evidence review=approved --evidence checks=experimental-artifact-check` } } };
        return { text: "实验节点验收完成。" };
      }
      const stage = trialPmStage++;
      if (stage === 0) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow inspect' } } };
      if (stage === 1) {
        const digest = fieldFromRequest(request, "candidateDigest");
        if (typeof digest !== "string") throw new Error("trial has no compiled candidate digest");
        return { tool: { name: "bash", arguments: { command: `"$GENEHUB_CLI" workflow dispatch --workflow game-feature --candidate ${shellArg(digest)} --task workflow-trial-j3 --no-wait --message "实验运行 J3，仅操作独立实验目录，验证最小产物。"` } } };
      }
      return { text: "实验结果已回到 PM；正式流程保持原版本。" };
    }
    if (managerPromptPath && body.includes("You are the workflow-reviewer specialist")) {
      const stage = qualityStage++;
      if (stage === 0) return { tool: { name: "bash", arguments: { command: `touch ${shellArg(path.join(projectRoot, "review-shell-escape"))}` } } };
      if (stage === 1) return { tool: { name: "write", arguments: { path: path.join(projectRoot, "review-write-escape"), content: "unauthorized" } } };
      if (stage === 2) return { tool: { name: "genet", arguments: { args: ["session", "context", "s_outside_scope"] } } };
      const source = body.match(/来源 PM Session：(s_[A-Za-z0-9]+)/)?.[1];
      if (!source) throw new Error("managed review omitted its real source PM Session");
      if (stage === 3) return { tool: { name: "genet", arguments: { args: ["session", "context", source, "--budget-tokens", "6000"] } } };
      if (stage === 4) return { tool: { name: "read", arguments: { path: path.join(projectRoot, "index.html") } } };
      if (stage === 5) {
        const refs = [...new Set(body.match(/ghref:[A-Za-z0-9_:.-]+/g) ?? [])];
        if (!refs.length) throw new Error("review did not obtain a real ghref from source context");
        return { tool: { name: "genet", arguments: { args: ["workflow", "complete", "--evidence", `report=${JSON.stringify({
          schema: "genehub.workflow-review.v1", target: { sourceSessionId: source },
          coverage: "partial", missingEvidence: ["interactive playability has not been independently exercised"],
          findings: [{ criterion: "playable result", verdict: "unverifiable", critical: true, evidenceRefs: refs, observedOutcome: "HTML artifact exists; interactive behavior needs verification" }],
          recommendation: "inconclusive",
        })}`] } } };
      }
      return { text: "评审已返回 PM；证据不完整，不能判定通过。" };
    }
    if (managerPromptPath && body.includes("独立评审 J3")) {
      if (reviewDispatched) return { text: "已收到独立评审，当前证据不足；未修改或激活工作流。" };
      reviewDispatched = true;
      return { tool: { name: "bash", arguments: { command: '\"$GENEHUB_CLI\" workflow dispatch --kind workflow --complexity review --task workflow-review-j3 --no-wait --message "独立评审 J3，检查交付是否满足要求，缺失证据不判通过。"' } } };
    }
    if (managerPromptPath && body.includes("分析 J1/J2") && !body.includes("You are the workflow-manager specialist")) {
      if (improvementDispatched && improvementRetried) return { text: "已委托并跟进流程改进；候选保持未激活。" };
      if (improvementDispatched) improvementRetried = true;
      improvementDispatched = true;
      return { tool: { name: "bash", arguments: { command: '\"$GENEHUB_CLI\" workflow dispatch --kind workflow --complexity improvement --task workflow-improvement-j3 --no-wait --message "分析 J1/J2，改进检查质量，评估但不激活。"' } } };
    }
    if (managerPromptPath && body.includes("分析 J1/J2")) {
      const stage = managerStage++;
      if (stage === 0) {
        return {
          tool: {
            name: "bash",
            arguments: { command: '"$GENEHUB_CLI" workflow history --limit 20' },
          },
        };
      }
      if (stage === 1) {
        return {
          tool: {
            name: "edit",
            arguments: {
              path: managerPromptPath,
              edits: [
                {
                  oldText: "完成后运行真实检查并提交到当前租约 ref。",
                  newText:
                    "完成后先运行与变更相关的静态检查和最小玩法回归，再提交到当前租约 ref。",
                },
              ],
            },
          },
        };
      }
      if (stage === 2) {
        return {
          tool: {
            name: "bash",
            arguments: { command: "node skills/workflow-manager/scripts/evaluate.mjs" },
          },
        };
      }
      if (stage === 3) {
        return {
          tool: {
            name: "bash",
            arguments: {
              command: `git -C ${root} add .genethub/workflow/prompts/coder.md && git -C ${root} commit -m "improve game delivery workflow"`,
            },
          },
        };
      }
      if (stage === 4) return { tool: { name: "bash", arguments: { command: '"$GENEHUB_CLI" workflow complete --evidence report="Inactive candidate evaluated from J1/J2; see the specialist evaluation artifact."' } } };
      return {
        text: "已基于 J1/J2 的结构化 Run 和 Executor 流程记录形成并评估新 Candidate；它保持未激活，可由用户审阅后决定是否晋级。",
      };
    }

    if (!delivery) {
      return { text: `未识别测试请求：${body.slice(-800)}` };
    }

    if (body.includes("你是小游戏项目的 Coder")) {
      const stage = coderStages.get(delivery.task) ?? 0;
      coderStages.set(delivery.task, stage + 1);
      if (stage === 0) {
        return {
          tool: {
            name: "write",
            arguments: { path: path.join(projectRoot, "index.html"), content: delivery.html },
          },
        };
      }
      if (stage === 1) {
        return {
          tool: {
            name: "bash",
            arguments: {
              command: `cd ${root} && git add index.html && git commit -m ${shellArg(
                delivery.commitMessage,
              )} && commit=$(git rev-parse HEAD) && "$GENEHUB_CLI" workflow complete --evidence commit="$commit" --evidence checks=${shellArg(
                "html5-static-game-smoke",
              )}`,
            },
          },
        };
      }
      return { text: "实现节点已完成并提交。" };
    }

    if (body.includes("你是小游戏项目的 Reviewer")) {
      const stage = reviewerStages.get(delivery.task) ?? 0;
      reviewerStages.set(delivery.task, stage + 1);
      if (stage === 0) {
        return {
          tool: {
            name: "bash",
            arguments: {
              command: `cd ${root} && sleep 2 && test -s index.html && ${delivery.markers
                .map((marker) => `grep -q ${shellArg(marker)} index.html`)
                .join(" && ")} && "$GENEHUB_CLI" workflow complete --evidence review=approved --evidence checks=${shellArg(
                "playability-and-regression-smoke",
              )}`,
            },
          },
        };
      }
      return { text: "Reviewer 已完成独立验收。" };
    }

    const stage = pmStages.get(delivery.task) ?? 0;
    pmStages.set(delivery.task, stage + 1);
    if (delivery.bootstrap && stage === 0) {
      return {
        tool: {
          name: "bash",
          arguments: { command: '"$GENEHUB_CLI" space inspect' },
        },
      };
    }
    if (delivery.bootstrap && stage === 1) {
      return {
        tool: {
          name: "bash",
          arguments: { command: '"$GENEHUB_CLI" space bootstrap list' },
        },
      };
    }
    if (delivery.bootstrap && stage === 2) {
      return {
        tool: {
          name: "bash",
          arguments: {
            command: '"$GENEHUB_CLI" space bootstrap plan --pack game-delivery-v1',
          },
        },
      };
    }
    if (delivery.bootstrap && stage === 3) {
      const challengeId = fieldFromRequest(request, "challengeId");
      if (typeof challengeId !== "string") {
        throw new Error(`PM did not receive a daemon challenge: ${body.slice(-4000)}`);
      }
      return {
        tool: {
          name: "request_user_input",
          arguments: {
            questions: [
              {
                id: challengeId,
                header: "项目接管",
                question: "是否按此计划转换为 PM 驱动项目？",
                options: [
                  { label: "确认", description: "仅批准这一份计划执行一次。" },
                  { label: "暂不", description: "保持目录不变。" },
                ],
              },
            ],
          },
        },
      };
    }
    if (delivery.bootstrap && stage === 4) {
      const planDigest = fieldFromRequest(request, "planDigest");
      const expectedRevision = fieldFromRequest(request, "expectedRevision");
      if (typeof planDigest !== "string" || typeof expectedRevision !== "number") {
        throw new Error(`approved PM turn lost its fixed plan: ${body.slice(-5000)}`);
      }
      return {
        tool: {
          name: "bash",
          arguments: {
            command: `"$GENEHUB_CLI" space bootstrap apply --pack ${PACK_ID} --plan-digest ${shellArg(
              planDigest,
            )} --expected-revision ${expectedRevision} --action-id bootstrap-${delivery.task} && cat .pipebuilder/skills/project-manager/SKILL.md && "$GENEHUB_CLI" workflow dispatch --kind game --complexity project --task ${shellArg(
              delivery.task,
            )} --no-wait --message ${shellArg(delivery.message)}`,
          },
        },
      };
    }
    if (!delivery.bootstrap && stage === 0) {
      return {
        tool: {
          name: "bash",
          arguments: {
            command: `"$GENEHUB_CLI" space inspect && cat .pipebuilder/skills/project-manager/SKILL.md && "$GENEHUB_CLI" workflow dispatch --kind feature --complexity complex --task ${shellArg(
              delivery.task,
            )} --no-wait --message ${shellArg(delivery.message)}`,
          },
        },
      };
    }
    if (stage === (delivery.bootstrap ? 5 : 1)) {
      return { text: "Executor 已接收目标，Coder 与 Reviewer 将按项目 DCG 推进。" };
    }
    return { text: "目标已由 Executor 推进完成；Coder 提交和 Reviewer 验收均已记录。" };
  };

  mock.script(...Array.from({ length: 80 }, () => ({ respond })));
}

async function completedRun(
  fixture: ProjectFixture,
  taskId: string,
): Promise<WorkflowRunStatus | undefined> {
  const reply = await fixture.opened.client.call({
    type: "workflow.history",
    payload: { workspaceId: fixture.projectId, limit: 20 },
  });
  return reply?.type === "workflowRuns"
    ? reply.data.find((candidate) => candidate.taskId === taskId && candidate.status === "completed")
    : undefined;
}

async function runningRun(
  fixture: ProjectFixture,
  taskId: string,
): Promise<WorkflowRunStatus | undefined> {
  const reply = await fixture.opened.client.call({
    type: "workflow.history",
    payload: { workspaceId: fixture.projectId, limit: 20 },
  });
  return reply?.type === "workflowRuns"
    ? reply.data.find((candidate) => candidate.taskId === taskId && candidate.status === "running")
    : undefined;
}

async function assertActiveRunGuardsTeam(
  t: CaseContext,
  fixture: ProjectFixture,
  taskId: string,
): Promise<void> {
  await t.tools.waitUntil(async () => Boolean(await runningRun(fixture, taskId)), 120_000);
  const manager = teamByName(await listSpaces(fixture)).get("workflow-manager");
  if (!manager?.agentSpace) throw new Error("active Run has no WorkflowManager AgentSpace");
  let rejected = "";
  try {
    await fixture.opened.client.call({
      type: "agentSpace.configure",
      payload: {
        workspaceId: manager.id,
        expectedRevision: manager.agentSpace.revision,
        operation: { kind: "setLifecycle", lifecycle: "pooled" },
      },
    });
  } catch (error) {
    rejected = String(error);
  }
  t.assertions.assert(
    rejected.includes("activeRunConflict"),
    `destructive tree change was not rejected by the active Run guard: ${rejected}`,
  );
  const unchanged = teamByName(await listSpaces(fixture)).get("workflow-manager");
  t.assertions.assert(
    unchanged?.agentSpace?.lifecycle === "persistent" &&
      unchanged.agentSpace.revision === manager.agentSpace.revision,
    "a rejected active-Run mutation changed the WorkflowManager",
  );
}

async function runPmDelivery(
  t: CaseContext,
  fixture: ProjectFixture,
  sessionId: string,
  prompt: string,
  taskId: string,
  expectApproval: boolean,
  existingEvents?: SessionEventLog,
  verifyActiveRunGuard = false,
): Promise<UserDeliveryTiming> {
  const events =
    existingEvents ?? (await t.flows.main.attachEventLog(fixture.opened.client, sessionId));
  const completedBefore = events.filter((event) => event.type === "turnCompleted").length;
  const failedBefore = events.filter((event) => event.type === "turnFailed").length;
  const startedAt = Date.now();
  let humanWaitMs = 0;
  await t.flows.main.sendPrompt(fixture.opened.client, sessionId, prompt);

  if (expectApproval) {
    await t.tools.waitUntil(
      () =>
        events.some((event) => {
          const inner = t.flows.main.sessionEventOf(event);
          const request = inner?.request as { kind?: string } | undefined;
          return inner?.type === "permissionRequested" && request?.kind === "planApproval";
        }) || events.some((event) => event.type === "turnFailed"),
      120_000,
    );
    t.assertions.assert(!existsSync(path.join(fixture.projectRoot, ".git")), "planning created Git before approval");
    t.assertions.assert(
      !existsSync(path.join(fixture.projectRoot, "pipespace.json")) &&
        !existsSync(path.join(fixture.projectRoot, "spaces")),
      "planning materialized AgentSpaces before approval",
    );
    const asked = events.find((event) => {
      const inner = t.flows.main.sessionEventOf(event);
      const request = inner?.request as { kind?: string } | undefined;
      return inner?.type === "permissionRequested" && request?.kind === "planApproval";
    });
    const request = asked ? t.flows.main.sessionEventOf(asked)?.request : undefined;
    const requestId = (request as { id?: string } | undefined)?.id;
    if (!requestId) {
      throw new Error(
        `PlanApproval has no request id: ${JSON.stringify(
          events.slice(-16).map((event) => event.raw),
        ).slice(-12000)}`,
      );
    }
    const humanStartedAt = Date.now();
    const reply = await fixture.opened.client.call({
      type: "session.respondPermission",
      payload: {
        sessionId,
        requestId,
        outcome: { outcome: "selected", optionId: "approve-once" },
      },
    });
    humanWaitMs += Date.now() - humanStartedAt;
    t.assertions.assert(reply?.type === "ack", `Human approval failed: ${JSON.stringify(reply)}`);
  }

  if (verifyActiveRunGuard) {
    await assertActiveRunGuardsTeam(t, fixture, taskId);
  }

  await t.tools.waitUntil(async () => Boolean(await completedRun(fixture, taskId)), FIFTEEN_MINUTES_MS);
  await t.tools.waitUntil(
    () => events.filter((event) => event.type === "turnCompleted").length >= completedBefore + 2,
    120_000,
  );
  const wallMs = Date.now() - startedAt;
  const activeMs = wallMs - humanWaitMs;
  t.assertions.assert(
    events.filter((event) => event.type === "turnFailed").length === failedBefore,
    `PM journey failed: ${JSON.stringify(events.slice(-16).map((event) => event.raw)).slice(-12000)}`,
  );
  t.assertions.assert(
    activeMs <= FIFTEEN_MINUTES_MS,
    `user-visible journey took ${activeMs}ms active (${wallMs}ms wall, ${humanWaitMs}ms Human wait)`,
  );
  return { activeMs, wallMs, humanWaitMs };
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
  for (const worker of [manager, team.get("workflow-reviewer")!, coder, reviewer]) {
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

async function createExperimentalSquad(t: CaseContext, fixture: ProjectFixture): Promise<{ root: string; executorId: string }> {
  const root = path.join(fixture.projectRoot, "experiments", "v2");
  mkdirSync(path.dirname(root), { recursive: true });
  writeFileSync(path.join(fixture.projectRoot, ".git", "info", "exclude"), "experiments/\n", { flag: "a" });
  git(fixture.projectRoot, ["clone", "--local", "--no-hardlinks", fixture.projectRoot, root]);
  git(root, ["config", "user.name", "Workflow Experiment"]);
  git(root, ["config", "user.email", "experiment@example.invalid"]);
  const original = teamByName(await listSpaces(fixture));
  const members = new Map<string, WorkspaceInfo>();
  for (const name of ["executor", "coder", "reviewer", "workflow-manager", "workflow-reviewer"]) {
    const source = path.join(fixture.projectRoot, "spaces", name);
    const target = path.join(fixture.projectRoot, "spaces", `${name}-v2`);
    mkdirSync(target);
    cpSync(path.join(source, "skills"), path.join(target, "skills"), { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(source, "pipespace.json"), "utf8"));
    manifest.name = `${name}-v2`;
    writeFileSync(path.join(target, "pipespace.json"), JSON.stringify(manifest));
    const workspace = JSON.parse(readFileSync(path.join(source, `${name}.code-workspace`), "utf8"));
    for (const folder of workspace.folders) if (folder.path === "../..") folder.path = "../../experiments/v2";
    const entry = path.join(target, `${name}-v2.code-workspace`);
    writeFileSync(entry, JSON.stringify(workspace));
    const opened = await fixture.opened.client.call({ type: "workspace.open", payload: { root: entry } });
    if (opened?.type !== "workspace") throw new Error("experiment Space did not open");
    const built = await fixture.opened.client.call({ type: "agentSpace.builder", payload: {
      workspaceId: fixture.projectId, targetWorkspaceId: opened.data.id, spaceName: `${name}-v2`,
      operation: { kind: "build", dryRun: false, requireNoPostCommands: true },
    } });
    t.assertions.assert(built?.type === "agentSpaceBuilder" && built.data.status === "ok", "experiment Space was not Builder verified");
    let current = opened.data;
    const parent = await fixture.opened.client.call({ type: "agentSpace.configure", payload: {
      workspaceId: current.id, expectedRevision: current.agentSpace?.revision ?? 0,
      operation: { kind: "setParent", parentWorkspaceId: name === "executor" ? fixture.projectId : members.get("executor")!.id },
    } });
    if (parent?.type !== "workspace") throw new Error("experiment team did not attach");
    current = parent.data;
    for (const component of [...original.get(name)!.agentSpace!.components].sort((left, right) => Number(right.componentId === "worker") - Number(left.componentId === "worker"))) {
      const configured = await fixture.opened.client.call({ type: "agentSpace.configure", payload: {
        workspaceId: current.id, expectedRevision: current.agentSpace?.revision ?? 0,
        operation: { kind: "setComponent", componentId: component.componentId, enabled: component.enabled, role: component.role ?? null },
      } });
      if (configured?.type !== "workspace") throw new Error("experiment component did not register");
      current = configured.data;
    }
    members.set(name, current);
  }
  const config = path.join(fixture.projectRoot, ".genethub", "workflow", "project.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("executorPath: spaces/executor", "executorPath: spaces/executor-v2").replace("root: .", "root: experiments/v2"));
  git(fixture.projectRoot, ["add", ".genethub/workflow/project.yaml", ...[...members.keys()].map((name) => `spaces/${name}-v2`)]);
  git(fixture.projectRoot, ["commit", "-m", "configure isolated experimental squad"]);
  return { root, executorId: members.get("executor")!.id };
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
  t.assertions.assert(existsSync(path.join(flowRoot, "snapshots", `run-${completed.id}.json`)), "Executor Run snapshot is missing");
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
    title: "One PM request builds a PM team with five expert Spaces and a playable game",
    oracle:
      "one user message makes PM discover and apply a Bootstrap Pack, create WorkflowManager/WorkflowReviewer/Executor/Coder/Reviewer AgentSpaces, and finish a playable HTML5 game through a zero-turn Executor and independent review within 15 minutes",
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
      scriptProductJourney(fixture.opened.mock, fixture.projectRoot, [PROJECT_DELIVERY]);
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const timing = await runPmDelivery(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内搭好小游戏团队并交付一个可玩的星尘花园；主实现按十分钟控制。",
        PROJECT_DELIVERY.task,
        true,
        undefined,
        true,
      );
      const delivery = await assertDelivery(t, fixture, PROJECT_DELIVERY.task, timing.activeMs);
      const html = readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8");
      for (const marker of ["<canvas", "ArrowLeft", "requestAnimationFrame", "score", "restart"]) {
        t.assertions.assert(html.includes(marker), `playable game omitted ${marker}`);
      }
      t.assertions.assert(!/https?:\/\//.test(html), "game depends on a remote asset instead of local preview files");
      t.assertions.assert(git(fixture.projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      t.note(
        `journey=game-project activeMs=${timing.activeMs} wallMs=${timing.wallMs} humanWaitMs=${timing.humanWaitMs} implementationMs=${delivery.implementationMs} pm=${pmSessionId} executor=${delivery.run.executorSessionId} run=${delivery.run.id} preview=${path.join(
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
      "given the game and five-Space team from the first journey, one user message reuses the same Executor/Coder/Reviewer AgentSpaces to add a cohesive weather, combo, persistence, and daily-mission feature within 15 minutes",
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
    const fixture = await createProject(t, "stardust-expedition");
    try {
      scriptProductJourney(fixture.opened.mock, fixture.projectRoot, [
        PROJECT_DELIVERY,
        FEATURE_DELIVERY,
      ]);
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const pmEvents = await t.flows.main.attachEventLog(fixture.opened.client, pmSessionId);
      const projectTiming = await runPmDelivery(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内搭好小游戏团队并交付一个可玩的星尘花园；主实现按十分钟控制。",
        PROJECT_DELIVERY.task,
        true,
        pmEvents,
      );
      const projectDelivery = await assertDelivery(
        t,
        fixture,
        PROJECT_DELIVERY.task,
        projectTiming.activeMs,
      );
      const before = assertTeam(t, fixture, projectDelivery.spaces);
      const beforeIdentity = TEAM_NAMES.map((name) => {
        const space = before.get(name)!;
        return `${name}:${space.id}:${space.agentSpace?.revision}`;
      });
      const timing = await runPmDelivery(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内给现有小游戏增加一套复杂的气象远征：天气轮换、连击、每日目标和本地最佳分数；主实现按十分钟控制。",
        FEATURE_DELIVERY.task,
        false,
        pmEvents,
      );
      const delivery = await assertDelivery(t, fixture, FEATURE_DELIVERY.task, timing.activeMs);
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
        `journey=game-feature activeMs=${timing.activeMs} wallMs=${timing.wallMs} humanWaitMs=${timing.humanWaitMs} implementationMs=${delivery.implementationMs} pm=${pmSessionId} executorSpace=${delivery.run.executorWorkspaceId} executorSession=${delivery.run.executorSessionId} run=${delivery.run.id}`,
      );
    } finally {
      await dispose(fixture);
    }
  },
);

defineJourney(
  {
    id: "journey.workflow.manager-improves-dcg-from-run",
    title: "PM delegates improvement and independent review, receives both results and preserves the active workflow",
    oracle:
      "one PM conversation delegates to WorkflowManager and WorkflowReviewer, gets an inactive candidate and bounded evidence report back, and the reviewer cannot mutate artifacts or read unrelated sessions",
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
    const fixture = await createProject(t, "stardust-workflow-lab");
    try {
      const promptPath = path.join(
        fixture.projectRoot,
        ".genethub",
        "workflow",
        "prompts",
        "coder.md",
      );
      scriptProductJourney(
        fixture.opened.mock,
        fixture.projectRoot,
        [PROJECT_DELIVERY, FEATURE_DELIVERY],
        promptPath,
      );
      const pmSessionId = await t.flows.main.createBuiltinSession(fixture.opened.client, fixture.projectId);
      const pmEvents = await t.flows.main.attachEventLog(fixture.opened.client, pmSessionId);
      const projectTiming = await runPmDelivery(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内搭好小游戏团队并交付一个可玩的星尘花园；主实现按十分钟控制。",
        PROJECT_DELIVERY.task,
        true,
        pmEvents,
      );
      const projectDelivery = await assertDelivery(
        t,
        fixture,
        PROJECT_DELIVERY.task,
        projectTiming.activeMs,
      );
      const featureTiming = await runPmDelivery(
        t,
        fixture,
        pmSessionId,
        "请在十五分钟内给现有小游戏增加一套复杂的气象远征：天气轮换、连击、每日目标和本地最佳分数；主实现按十分钟控制。",
        FEATURE_DELIVERY.task,
        false,
        pmEvents,
      );
      const baseline = await assertDelivery(
        t,
        fixture,
        FEATURE_DELIVERY.task,
        featureTiming.activeMs,
      );
      const before = await inspectProject(fixture);
      const runCountBefore = (await fixture.opened.client.call({
        type: "workflow.history",
        payload: { workspaceId: fixture.projectId, limit: 20 },
      }));
      t.assertions.assert(runCountBefore?.type === "workflowRuns", "baseline history is unavailable");
      const managedBefore = baseline.sessions.filter((session) => session.managed?.workflowRunId).length;

      const team = assertTeam(t, fixture, baseline.spaces);
      const managerSpace = team.get("workflow-manager")!;
      const improvementTiming = await runPmDelivery(
        t, fixture, pmSessionId,
        "请分析 J1/J2 的 Workflow 执行记录，改进下一次交付的检查质量；完成评估但不要激活，十五分钟内给我结果。",
        "workflow-improvement-j3", false, pmEvents,
      );
      const elapsedMs = improvementTiming.activeMs;
      const improvement = await completedRun(fixture, "workflow-improvement-j3");
      t.assertions.assert(improvement?.parentSessionId === pmSessionId, "improvement did not return to originating PM");
      const managerSessionId = improvement?.nodes.find((node) => node.id === "specialist")?.sessionId;
      if (!managerSessionId) throw new Error("PM did not delegate a real WorkflowManager Session");
      const managerReply = await fixture.opened.client.call({ type: "session.get", payload: { sessionId: managerSessionId } });
      t.assertions.assert(managerReply?.type === "snapshot" && managerReply.data.summary.workspaceId === managerSpace.id, "improvement used the wrong expert Space");

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
        report.analyzedRuns?.includes(projectDelivery.run.id) &&
          report.analyzedRuns?.includes(baseline.run.id) &&
          (report.analyzedMessages ?? 0) >= baseline.flow.messages.length,
        "evaluation report is not based on both completed structured Runs",
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
          runCountAfter.data.length === runCountBefore.data.length + 1,
        "PM improvement did not create exactly one specialist Run",
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
      t.assertions.assert(managedAfter === managedBefore + 1, "PM improvement did not create exactly one managed specialist");
      t.assertions.assert(git(fixture.projectRoot, ["status", "--porcelain"]) === "", "project is dirty");
      const artifactBeforeReview = readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8");
      await runPmDelivery(t, fixture, pmSessionId, "独立评审 J3，检查交付是否满足要求，缺失证据不判通过。", "workflow-review-j3", false, pmEvents);
      const reviewed = await completedRun(fixture, "workflow-review-j3");
      t.assertions.assert(reviewed?.parentSessionId === pmSessionId, "review returned to another Session");
      const reviewNode = reviewed?.nodes.find((node) => node.id === "specialist");
      const qualityReport = JSON.parse(reviewNode?.evidence.report ?? "null");
      t.assertions.assert(qualityReport?.recommendation === "inconclusive" && qualityReport?.coverage === "partial", "missing evidence was converted to approval");
      t.assertions.assert(qualityReport?.findings[0]?.evidenceRefs?.length > 0, "review omitted source references");
      t.assertions.assert(!existsSync(path.join(fixture.projectRoot, "review-shell-escape")) && !existsSync(path.join(fixture.projectRoot, "review-write-escape")), "reviewer changed the evaluated project");
      t.assertions.assert(readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8") === artifactBeforeReview, "reviewer modified the delivery artifact");
      const reviewRequests = fixture.opened.mock.requests.filter((request) => JSON.stringify(request).includes("You are the workflow-reviewer specialist"));
      t.assertions.assert(reviewRequests.some((request) => JSON.stringify(request).includes("Session is outside the granted evidence set")), "review did not enforce the source Session scope");
      t.assertions.assert((await inspectProject(fixture)).activeDigest === before.activeDigest, "independent review changed active workflow");
      const experiment = await createExperimentalSquad(t, fixture);
      const formalHead = git(fixture.projectRoot, ["rev-parse", "HEAD"]);
      await runPmDelivery(t, fixture, pmSessionId, "实验运行 J3，仅操作独立实验目录，验证最小产物。", "workflow-trial-j3", false, pmEvents);
      const trial = await completedRun(fixture, "workflow-trial-j3");
      t.assertions.assert(trial?.experimental === true && trial.executorWorkspaceId === experiment.executorId && trial.executionRoot === experiment.root, "trial lost its explicit candidate/team/environment binding");
      t.assertions.assert(trial?.activationRevision == null && trial?.parentSessionId === pmSessionId, "trial pretended to be an activated run or changed its result recipient");
      t.assertions.assert(git(fixture.projectRoot, ["rev-parse", "HEAD"]) === formalHead && readFileSync(path.join(fixture.projectRoot, "index.html"), "utf8") === artifactBeforeReview, "trial wrote into the formal delivery");
      t.assertions.assert((await inspectProject(fixture)).activeDigest === before.activeDigest, "trial activated itself");
      // Human activation exercises the binding CAS, not a quality-acceptance oracle.
      const adopted = await fixture.opened.client.call({ type: "workflow.activate", payload: { workspaceId: fixture.projectId, candidateDigest: trial!.dcgDigest, expectedRevision: before.activationRevision } });
      t.assertions.assert(adopted?.type === "workflowProject" && adopted.data.activeDigest === trial!.dcgDigest, "adoption did not switch the complete candidate");
      const rollback = await fixture.opened.client.call({ type: "workflow.activate", payload: { workspaceId: fixture.projectId, candidateDigest: before.activeDigest ?? null, expectedRevision: before.activationRevision + 1 } });
      t.assertions.assert(rollback?.type === "workflowProject" && rollback.data.activeDigest === before.activeDigest, "rollback did not restore the previous complete binding");
      const historicalTrial = await completedRun(fixture, "workflow-trial-j3");
      t.assertions.assert(historicalTrial?.dcgDigest === trial?.dcgDigest && historicalTrial?.executorWorkspaceId === experiment.executorId, "activation rewrote historical trial facts");
      t.note(
        `journey=workflow-improvement elapsedMs=${elapsedMs} j1ImplementationMs=${projectDelivery.implementationMs} j2ImplementationMs=${baseline.implementationMs} manager=${managerSessionId} active=${after.activeDigest} candidate=${after.candidateDigest} analyzedRuns=${projectDelivery.run.id},${baseline.run.id}`,
      );
    } finally {
      await dispose(fixture);
    }
  },
);
