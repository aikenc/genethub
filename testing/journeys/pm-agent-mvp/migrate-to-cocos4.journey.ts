import { defineJourney } from "../../framework/public.ts";

import {
  SEQUENCE_ID,
  assertCleanMainRepositories,
  assertCocos4Migration,
  assertDailyChallenge,
  assertEffectiveProjectScale,
  assertNpmVerification,
  runRealPmDelivery,
} from "./support.ts";

defineJourney(
  {
    id: "journey.pm-agent-mvp.3-migrate-to-cocos4",
    title: "The retained PM migrates the accepted game from Three.js to pinned COCOS 4",
    oracle:
      "from the exact daily-challenge checkpoint, the real PM decomposes and reviews an engine migration to the official pinned COCOS 4 alpha while preserving behavior, saves, tests, and the H5 artifact",
    catches: [
      "Cocos Creator 3.x is substituted while reported as COCOS 4",
      "migration becomes a rewrite that drops accepted gameplay",
      "Three.js stays in the production runtime",
      "engine research or integration bypasses WorkAgent review",
    ],
    tags: ["pm-agent-mvp-real", "product-journey"],
    llm: { default: "real", realEligible: true },
    resources: { environments: 1, cpu: 6, memoryMb: 12288, io: 6, browser: 0, pool: "real-llm" },
    expectedDurationMs: 4 * 60 * 60_000,
    timeoutMs: 5.5 * 60 * 60_000,
    surfaces: ["daemon", "agent", "workbench-client", "git", "agent-space-builder"],
    productInterfaces: ["pm.session.create", "pm.project.status", "genet-cli", "workSession.create"],
    sequence: { id: SEQUENCE_ID, order: 3 },
  },
  async (t) => {
    const proof = await runRealPmDelivery(t, {
      timeoutMs: 5 * 60 * 60_000,
      requirePredecessorCheckpoint: true,
      requireConcurrentImplementationSpaces: 2,
      prompt: `把现有《Starport Defender》的生产渲染引擎从 Three.js 迁移为官方 COCOS 4。沿用同一个 PM 项目和前两次 accepted 证据；从 completed 恢复 active，记录新的 Intent revision，根据实际迁移图动态维护 Agent Space 和项目 Skill。

引擎目标已经由用户明确批准：固定官方 https://github.com/cocos/cocos4 的 4.0.0-alpha.30；它是 Alpha，必须在交付说明和风险中如实标注。不得用 Cocos Creator 3.x、名称伪装的自制 canvas renderer，或仍由 Three.js 驱动的兼容层冒充 COCOS 4。请在 repositories/game/engine.lock.json 记录 name、version、官方 source 和可验证的 tag/commit/artifact 身份。

验收要求：
- 保留已有普通模式、每日挑战、控制、HUD、触控、声音、本地存档与分数；旧存档可迁移，用户可见规则不倒退。
- 生产 dependency/import/bundle 不再使用 Three.js；领域/模拟层通过明确 adapter 接入 COCOS 4，H5 根 index.html 仍可启动构建产物。
- 对迁移前后的确定性玩法、存档、UI、性能预算和浏览器 smoke 做对等验证；npm test 与 npm run build 通过，项目自有有效源码仍在 35,000–65,000 行。
- 只能由 opencode + bailian-token-plan-personal/qwen3.8-flash WorkAgent 编写/迁移代码。按耦合拆分工作，在安全时让至少两个独立迁移包跨不同 Agent Space/分支/worktree 并发；PM 只管理、取证、答疑、合并。
- 所有候选绑定精确 commit/tree；最终由 --role review 的专用 Agent Space 独立评审，评审后再次确认候选干净且身份未变。通过后合入 repositories/game/main，两个仓库干净，新增包 accepted，本轮 lifecycle completed。不要停在调研报告；调研结论必须落到真实项目。`,
    });

    t.assertions.assert(
      proof.newPackages.filter((item) => item.status === "accepted").every((item) => item.branch !== "main"),
      "engine migration used main as a WorkAgent branch",
    );
    const game = assertCleanMainRepositories(t);
    assertNpmVerification(t, game);
    assertDailyChallenge(t, game);
    assertCocos4Migration(t, game);
    assertEffectiveProjectScale(t, game);
  },
);
