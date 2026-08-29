import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { PmProjectStatus, SessionSummary } from "@genehub/proto";

import { BlockedError, type CaseContext } from "../../framework/public.ts";

export const PM_MODEL = "ali/qwen3.8-flash";
export const WORK_AGENT = "opencode";
export const SEQUENCE_ID = "pm-agent-starport-defender";
export const AUTONOMOUS_CANDIDATE_POLICY = `
执行效率与稳定性约束：
- 每个实现 WorkPackage 必须是结果型合同：一个 WorkSession 自主完成其全部 owned paths、检查和干净 candidate；不要把文件、单条测试或 checkpoint 拆成新的 PM 管理回合。
- checkpoint commit 只用于 WorkAgent 自恢复，不要求 PM 逐提交复核，也不因普通 checkpoint 唤醒或继续会话。
- Supervisor 批量事件到达时一次处理全部 candidate/blocked/failed 包；仍在运行的会话不轮询、不复跑。
- 只有候选、具体阻塞、终止失败、连续两次无新提交/新诊断的 turn cap，或用户/合同变化，才重新规划或续派。
- 候选报告必须是紧凑 evidence bundle：commit/tree、实际命令和退出码、产物摘要、已知限制、合同变化；独立 Review 再复验精确候选。`;

export interface DeliveryOptions {
  prompt: string;
  timeoutMs: number;
  requirePredecessorCheckpoint: boolean;
  requireConcurrentImplementationSpaces?: number;
  askStatusWhileRunning?: boolean;
}

export interface DeliveryProof {
  status: PmProjectStatus;
  previous: PmProjectStatus | undefined;
  newPackages: PmProjectStatus["workPackages"];
  maxConcurrentImplementationSpaces: number;
  workSessions: SessionSummary[];
  metrics: {
    elapsedMs: number;
    pmTerminalTurns: number;
    pmFailedTurns: number;
    supervisorDispatches: number;
    supervisorFailures: number;
    coalescedEvents: number;
  };
}

/**
 * Runs one user request through the real PM entry and waits only on the public
 * read-only project projection. Work is performed by the PM-selected public
 * WorkSession protocol; the test never edits PM state or dispatches a worker.
 */
export async function runRealPmDelivery(
  t: CaseContext,
  options: DeliveryOptions,
): Promise<DeliveryProof> {
  const deliveryStartedAt = Date.now();
  const checkpoint = process.env.TESTCTL_SEQUENCE_CHECKPOINT_SHA256 ?? "";
  t.assertions.assert(
    process.env.TESTCTL_SEQUENCE_ID === SEQUENCE_ID,
    `unexpected sequence identity ${process.env.TESTCTL_SEQUENCE_ID}`,
  );
  t.assertions.assert(
    options.requirePredecessorCheckpoint ? /^[a-f0-9]{64}$/.test(checkpoint) : checkpoint === "",
    options.requirePredecessorCheckpoint
      ? "the journey did not receive a verified predecessor checkpoint"
      : "the first journey unexpectedly received predecessor state",
  );

  // Both configs are machine/user configuration and are written before the
  // daemon starts. No provider secret enters the project repository.
  t.flows.main.seedAliyunQwen38Flash(t.env);
  const workModel = t.flows.main.configureOpencodeQwen38Flash(t.env);
  const opened = await t.flows.main.openWorkspace({ openRoot: t.openRoot, lease: t.env });
  try {
    await t.flows.main.requireAgentReady(opened.client, WORK_AGENT);

    const previous = await projectStatus(opened.client, opened.workspaceId);
    const previousPackageIds = new Set(previous?.workPackages.map((item) => item.id) ?? []);
    const created = await opened.client.call({
      type: "pm.session.create",
      payload: {
        workspaceId: opened.workspaceId,
        modelId: PM_MODEL,
        modeId: null,
        effortId: "medium",
        title: "Starport Defender 项目经理",
      },
    });
    t.assertions.assert(created?.type === "session", `pm.session.create returned ${created?.type}`);
    if (created?.type !== "session") throw new Error("PM session was not created");
    const pm = created.data;
    t.assertions.assert(pm.kind === "pm", `project entry created ${pm.kind ?? "ordinary"} session`);
    t.assertions.assert(pm.modelId === PM_MODEL, `PM session used ${pm.modelId ?? "no model"}`);
    t.assertions.assert(pm.effortId === "medium", `PM session used ${pm.effortId ?? "no"} effort instead of medium`);
    const events = await t.flows.main.attachEventLog(opened.client, pm.id);
    const deliveryEventFloor = events.length;
    await t.flows.main.sendPrompt(opened.client, pm.id, options.prompt);

    const deadline = Date.now() + options.timeoutMs;
    let latest: PmProjectStatus | undefined;
    let maxConcurrentImplementationSpaces = 0;
    let questionSent = false;
    let questionTerminalFloor = 0;
    while (Date.now() < deadline) {
      const providerFailure = permanentProviderFailure(events.slice(deliveryEventFloor));
      if (providerFailure) {
        throw new BlockedError(
          `real PM provider prerequisite is unavailable; no mock or model substitution is allowed: ${providerFailure}`,
        );
      }
      latest = await projectStatus(opened.client, opened.workspaceId);
      if (latest) {
        const runningSpaces = new Set(
          latest.workPackages
            .filter((item) => item.status === "running")
            .map((item) => item.agentSpace),
        );
        maxConcurrentImplementationSpaces = Math.max(
          maxConcurrentImplementationSpaces,
          runningSpaces.size,
        );

        if (
          options.askStatusWhileRunning &&
          !questionSent &&
          runningSpaces.size >= (options.requireConcurrentImplementationSpaces ?? 2)
        ) {
          const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId: pm.id } });
          if (snapshot?.type === "snapshot" && snapshot.data.summary.status === "idle") {
            questionTerminalFloor = terminalTurns(events);
            try {
              await t.flows.main.sendPrompt(
                opened.client,
                pm.id,
                "不改变范围：请简要回答目前哪些工作包正在并行、各自交付什么，然后继续推进项目。",
              );
              questionSent = true;
            } catch {
              // A supervisor turn won the race. Retry on the next idle sample.
            }
          }
        }

        const currentPackages = latest.workPackages.filter(
          (item) => !previousPackageIds.has(item.id),
        );
        if (
          latest.lifecycle === "completed" &&
          currentPackages.length > 0 &&
          currentPackages.every((item) => item.status === "accepted" || item.status === "cancelled")
        ) {
          break;
        }
      }
      await sleep(2_000);
    }

    if (!latest || latest.lifecycle !== "completed") {
      throw new Error(
        `PM delivery did not complete in ${options.timeoutMs}ms; status=${JSON.stringify(latest)}; events=${JSON.stringify(events.slice(-30).map((item) => item.type))}`,
      );
    }
    const newPackages = latest.workPackages.filter((item) => !previousPackageIds.has(item.id));
    t.assertions.assert(newPackages.length > 0, "the PM completed without adding a delivery work package");
    t.assertions.assert(
      newPackages.some((item) => item.status === "accepted") &&
        newPackages.every((item) => item.status === "accepted" || item.status === "cancelled"),
      `new delivery packages were not terminal and usable: ${JSON.stringify(newPackages)}`,
    );
    const run = latest.workflowRuns.find((item) => item.controllerSessionId === pm.id);
    t.assertions.assert(Boolean(run?.graphId), "the PM Session completed without a selected Workflow Run");
    if (!run) throw new Error("the completed PM Session has no Workflow Run");
    for (const item of newPackages) {
      t.assertions.assert(
        item.workflowRunId === run?.id &&
          item.nodeInstanceId !== undefined &&
          run.nodeInstances.some((node) => node.id === item.nodeInstanceId) &&
          run.teamSlots.some((slot) => slot.workPackageId === item.id && slot.nodeInstanceId === item.nodeInstanceId),
        `WorkPackage ${item.id} is not completely bound to its DCG node instance and Team Slot`,
      );
    }
    if (previous) {
      t.assertions.assert(
        (latest.intent?.revision ?? 0) > (previous.intent?.revision ?? 0),
        "the new user request did not create a new Intent revision",
      );
    }
    if (options.requireConcurrentImplementationSpaces) {
      t.assertions.assert(
        maxConcurrentImplementationSpaces >= options.requireConcurrentImplementationSpaces,
        `observed only ${maxConcurrentImplementationSpaces} concurrent implementation Agent Spaces`,
      );
    }
    if (options.askStatusWhileRunning) {
      t.assertions.assert(questionSent, "the PM never became available for a mid-project user question");
      t.assertions.assert(
        terminalTurns(events) > questionTerminalFloor,
        "the PM did not finish the user's mid-project status answer",
      );
    }

    const reviewSpaceIds = new Set(
      latest.agentSpaces.filter((space) => space.role === "review").map((space) => space.workspaceId),
    );
    t.assertions.assert(reviewSpaceIds.size > 0, "the topology has no dedicated review-only Agent Space");
    const implementationSpaces = new Set(
      latest.agentSpaces
        .filter((space) => space.role === "implementation")
        .map((space) => space.name),
    );
    t.assertions.assert(
      newPackages
        .filter((item) => item.status === "accepted")
        .every((item) => implementationSpaces.has(item.agentSpace)),
      "an implementation package was assigned to a review-only Space",
    );

    const workSessions: SessionSummary[] = [];
    for (const item of newPackages.filter((package_) => package_.status === "accepted")) {
      t.assertions.assert(
        item.candidateCommit !== undefined && item.candidateTree !== undefined,
        `accepted package ${item.id} has no exact candidate identity`,
      );
      t.assertions.assert(
        item.reviewVerdict === "pass" && item.reviewSessionId !== undefined,
        `accepted package ${item.id} has no passing independent review`,
      );
      for (const sessionId of [item.workSessionId, item.reviewSessionId]) {
        t.assertions.assert(sessionId !== undefined, `package ${item.id} is missing a WorkSession`);
        if (!sessionId) continue;
        const snapshot = await opened.client.call({ type: "session.get", payload: { sessionId } });
        t.assertions.assert(snapshot?.type === "snapshot", `session.get returned ${snapshot?.type}`);
        if (snapshot?.type !== "snapshot") continue;
        const summary = snapshot.data.summary;
        workSessions.push(summary);
        t.assertions.assert(summary.kind === "work", `${sessionId} is not a WorkSession`);
        t.assertions.assert(summary.agentId === WORK_AGENT, `${sessionId} used ${summary.agentId}`);
        t.assertions.assert(
          summary.modelId === workModel,
          `${sessionId} used ${summary.modelId ?? "no model"}, expected ${workModel}`,
        );
        t.assertions.assert(
          summary.capabilities?.send === false &&
            summary.capabilities.interrupt === false &&
            summary.capabilities.delete === false &&
            summary.capabilities.fork === true,
          `${sessionId} is not user-read-only/forkable`,
        );
        if (sessionId === item.reviewSessionId) {
          t.assertions.assert(
            reviewSpaceIds.has(summary.workspaceId),
            `review ${sessionId} did not run in a review-only Agent Space`,
          );
        } else {
          t.assertions.assert(
            !reviewSpaceIds.has(summary.workspaceId),
            `implementation ${sessionId} ran in a review-only Agent Space`,
          );
        }
      }
    }
    const deliveryEvents = events.slice(deliveryEventFloor);
    const metrics = {
      elapsedMs: Date.now() - deliveryStartedAt,
      pmTerminalTurns: terminalTurns(deliveryEvents),
      pmFailedTurns: deliveryEvents.filter((item) => item.type === "turnFailed").length,
      supervisorDispatches: latest.supervisor.wakeDispatchCount ?? 0,
      supervisorFailures: latest.supervisor.wakeFailedCount ?? 0,
      coalescedEvents: latest.supervisor.coalescedEventCount ?? 0,
    };
    t.note(`pm-delivery-metrics ${JSON.stringify({
      ...metrics,
      maxConcurrentImplementationSpaces,
      acceptedPackages: newPackages.filter((item) => item.status === "accepted").length,
      workSessions: workSessions.length,
    })}`);
    return { status: latest, previous, newPackages, maxConcurrentImplementationSpaces, workSessions, metrics };
  } finally {
    opened.client.close();
    opened.daemon.stop();
    await opened.mock.stop();
  }
}

async function projectStatus(
  client: Parameters<typeof requestProjectStatus>[0],
  workspaceId: string,
): Promise<PmProjectStatus | undefined> {
  try {
    return await requestProjectStatus(client, workspaceId);
  } catch (error) {
    if (/not.?found|not initialized/i.test(error instanceof Error ? error.message : String(error))) {
      return undefined;
    }
    throw error;
  }
}

async function requestProjectStatus(
  client: CaseContext["flows"]["main"] extends never ? never : Awaited<ReturnType<CaseContext["flows"]["main"]["openWorkspace"]>>["client"],
  workspaceId: string,
): Promise<PmProjectStatus | undefined> {
  const reply = await client.call({ type: "pm.project.status", payload: { workspaceId } });
  if (reply?.type !== "projectStatus") {
    throw new Error(`pm.project.status returned ${reply?.type}`);
  }
  return reply.data;
}

function terminalTurns(events: Array<{ type?: string }>): number {
  return events.filter((item) =>
    ["turnCompleted", "turnFailed", "turnCanceled"].includes(item.type ?? ""),
  ).length;
}

function permanentProviderFailure(events: Array<{ type?: string; raw: unknown }>): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type !== "turnFailed") continue;
    const evidence = JSON.stringify(event.raw);
    if (
      /\b(?:401|402|403)\b|payment required|insufficient (?:balance|credit|quota)|billing|invalid api key|unauthori[sz]ed|forbidden/i.test(
        evidence,
      )
    ) {
      return evidence.slice(0, 2_000);
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertCleanMainRepositories(t: CaseContext): string {
  const outer = git(t.env.workspace, ["status", "--porcelain"]);
  t.assertions.assert(outer === "", `outer Agent Space repository is dirty: ${outer}`);
  t.assertions.assert(git(t.env.workspace, ["branch", "--show-current"]) === "main", "outer repository is not on main");

  const game = path.join(t.env.workspace, "repositories", "game");
  t.assertions.assert(existsSync(path.join(game, ".git")), "repositories/game is not a local Git repository");
  const dirty = git(game, ["status", "--porcelain"]);
  t.assertions.assert(dirty === "", `game repository is dirty: ${dirty}`);
  t.assertions.assert(git(game, ["branch", "--show-current"]) === "main", "accepted game is not integrated to main");
  t.assertions.assert(/^[a-f0-9]{40,64}$/.test(git(game, ["rev-parse", "HEAD"])), "game has no immutable HEAD");
  return game;
}

export function assertNpmVerification(t: CaseContext, game: string): void {
  const manifest = JSON.parse(readFileSync(path.join(game, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const script of ["test", "build"]) {
    t.assertions.assert(typeof manifest.scripts?.[script] === "string", `package.json has no ${script} script`);
    const result = spawnSync("npm", ["run", script], {
      cwd: game,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      timeout: 15 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    t.assertions.assert(
      result.status === 0,
      `npm run ${script} failed: ${(result.stderr || result.stdout || "no output").slice(-8_000)}`,
    );
  }
  t.assertions.assert(existsSync(path.join(game, "index.html")), "game has no root H5 entry index.html");
}

export function assertEffectiveProjectScale(t: CaseContext, game: string): number {
  const lines = effectiveSourceLines(game);
  t.assertions.assert(
    lines >= 35_000 && lines <= 65_000,
    `effective project-owned source is ${lines} lines, expected 35k-65k`,
  );
  return lines;
}

export function assertThreeJsBaseline(t: CaseContext, game: string): void {
  const manifest = JSON.parse(readFileSync(path.join(game, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version = manifest.dependencies?.three ?? manifest.devDependencies?.three;
  t.assertions.assert(typeof version === "string" && version.length > 0, "initial delivery is not pinned to Three.js");
}

export function assertDailyChallenge(t: CaseContext, game: string): void {
  const production = productionText(game);
  t.assertions.assert(/daily[\s_-]*challenge/i.test(production), "daily challenge feature is absent from production source");
  t.assertions.assert(/utc|date|seed/i.test(production), "daily challenge has no deterministic date/seed contract");
}

export function assertCocos4Migration(t: CaseContext, game: string): void {
  const lockPath = path.join(game, "engine.lock.json");
  t.assertions.assert(existsSync(lockPath), "migration has no machine-readable engine.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  const identity = JSON.stringify(lock);
  t.assertions.assert(/COCOS 4/i.test(identity), `engine lock does not identify COCOS 4: ${identity}`);
  t.assertions.assert(identity.includes("4.0.0-alpha.30"), `engine lock is not pinned to 4.0.0-alpha.30: ${identity}`);
  t.assertions.assert(identity.includes("github.com/cocos/cocos4"), "engine lock does not name the official COCOS 4 source");

  const manifest = JSON.parse(readFileSync(path.join(game, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  t.assertions.assert(
    manifest.dependencies?.three === undefined && manifest.devDependencies?.three === undefined,
    "Three.js remains in the runtime dependency graph",
  );
  const production = productionText(game);
  t.assertions.assert(
    !/(?:from|import\s*\()\s*["']three(?:[\/"'])/i.test(production),
    "production source still imports Three.js",
  );
  t.assertions.assert(/cocos/i.test(production), "production source has no COCOS runtime integration");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function productionText(root: string): string {
  const chunks: string[] = [];
  walkSource(root, (file) => {
    if (!/(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)/i.test(file)) {
      chunks.push(readFileSync(file, "utf8"));
    }
  });
  return chunks.join("\n");
}

function effectiveSourceLines(root: string): number {
  let total = 0;
  walkSource(root, (file) => {
    let inBlock = false;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) continue;
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        continue;
      }
      if (line.startsWith("/*")) {
        if (!line.includes("*/", 2)) inBlock = true;
        continue;
      }
      if (line.startsWith("//") || line.startsWith("<!--") || line.startsWith("*")) continue;
      total += 1;
    }
  });
  return total;
}

function walkSource(root: string, visit: (file: string) => void): void {
  const excluded = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "generated",
    "vendor",
    "third_party",
    "third-party",
    ".cache",
  ]);
  const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html", ".glsl", ".vert", ".frag"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()) && statSync(full).size <= 2_000_000) {
        visit(full);
      }
    }
  };
  walk(root);
}
