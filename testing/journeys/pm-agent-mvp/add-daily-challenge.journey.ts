import { defineJourney } from "../../framework/public.ts";

import {
  SEQUENCE_ID,
  assertCleanMainRepositories,
  assertDailyChallenge,
  assertEffectiveProjectScale,
  assertNpmVerification,
  assertThreeJsBaseline,
  runRealPmDelivery,
} from "./support.ts";

defineJourney(
  {
    id: "journey.pm-agent-mvp.2-add-daily-challenge",
    title: "The retained PM adds a reviewed feature on a suitable local branch",
    oracle:
      "from the exact accepted game checkpoint, the same PM reopens the project, revises Intent, chooses a safe local branch/topology, and integrates a deterministic daily challenge without regressing the game",
    catches: [
      "completed projects cannot accept later user scope",
      "the feature is written on main or in the wrong worktree",
      "the PM discards earlier topology/session lineage",
      "daily behavior is date-random and untestable",
    ],
    tags: ["pm-agent-mvp-real", "product-journey"],
    llm: { default: "real", realEligible: true },
    resources: { environments: 1, cpu: 4, memoryMb: 8192, io: 4, browser: 0, pool: "real-llm" },
    expectedDurationMs: 2 * 60 * 60_000,
    timeoutMs: 3 * 60 * 60_000,
    surfaces: ["daemon", "agent", "workbench-client", "git", "agent-space-builder"],
    productInterfaces: ["pm.session.create", "pm.project.status", "genet-cli", "workSession.create"],
    sequence: { id: SEQUENCE_ID, order: 2 },
  },
  async (t) => {
    const proof = await runRealPmDelivery(t, {
      timeoutMs: 2.5 * 60 * 60_000,
      requirePredecessorCheckpoint: true,
      prompt: `在现有《Starport Defender》项目上新增“每日挑战”特性。沿用同一个 PM 项目、外层 Git、repositories/game 和已有 Agent Space/WorkSession 证据；这是新的用户交付，请从 completed 显式恢复 active、记录新的 Intent revision，并根据影响范围复用、调整或新增最小拓扑，不要重建项目。

验收要求：
- 每个 UTC 日期有确定性的关卡 seed、敌人组合和限制条件；同一天同版本可复现，测试可注入日期/seed，不依赖真实时钟随机性。
- 首页/HUD 能查看今日规则、开始挑战、查看当日最佳分数和完成状态；普通模式保持不变，旧存档可升级且不丢失。
- 为核心规则、跨日、时区边界、存档迁移和 UI 流程增加测试；现有 npm test、npm run build 和浏览器 smoke 全部通过。
- 自己根据当前 accepted main 选择合适的非 main 分支与隔离 worktree。实现仍只能由 opencode + bailian-token-plan-personal/qwen3.8-flash WorkAgent 完成。
- 候选必须经过 review-only Agent Space 的独立评审并绑定同一 commit/tree；通过后合入 repositories/game/main，仓库干净，Three.js 仍为锁定的默认引擎。
- 持续推进到新增包 accepted 并把本轮 lifecycle 标为 completed；不要停在建议或计划。`,
    });

    t.assertions.assert(
      proof.newPackages.filter((item) => item.status === "accepted").every((item) => item.branch !== "main"),
      "daily challenge implementation used main as its work branch",
    );
    const game = assertCleanMainRepositories(t);
    assertNpmVerification(t, game);
    assertThreeJsBaseline(t, game);
    assertDailyChallenge(t, game);
    assertEffectiveProjectScale(t, game);
  },
);
