import { defineJourney } from "../../framework/public.ts";

import {
  SEQUENCE_ID,
  assertCleanMainRepositories,
  assertEffectiveProjectScale,
  assertNpmVerification,
  assertThreeJsBaseline,
  runRealPmDelivery,
} from "./support.ts";

defineJourney(
  {
    id: "journey.pm-agent-mvp.1-build-starport-defender",
    title: "A real small-model PM delivers a 50k-line H5 game through concurrent Agent Spaces",
    oracle:
      "from an empty Folder, the real PM creates local Git topology and project Skills, drives concurrent third-party WorkAgents, independently reviews exact candidates, and integrates a playable Three.js game to clean main",
    catches: [
      "PM writes the business implementation itself",
      "topology is fixed rather than derived from the work graph",
      "WorkAgents run serially or outside their assigned worktrees",
      "review is self-review or runs in an implementation Space",
      "a toy scaffold is reported as a 50k-line deliverable",
    ],
    tags: ["pm-agent-mvp-real", "product-journey"],
    llm: { default: "real", realEligible: true },
    resources: { environments: 1, cpu: 4, memoryMb: 8192, io: 4, browser: 0, pool: "real-llm" },
    expectedDurationMs: 4.5 * 60 * 60_000,
    timeoutMs: 6.5 * 60 * 60_000,
    surfaces: ["daemon", "agent", "workbench-client", "git", "agent-space-builder"],
    productInterfaces: ["pm.session.create", "pm.project.status", "genet-cli", "workSession.create"],
    sequence: { id: SEQUENCE_ID, order: 1 },
  },
  async (t) => {
    const proof = await runRealPmDelivery(t, {
      timeoutMs: 6 * 60 * 60_000,
      requirePredecessorCheckpoint: false,
      requireConcurrentImplementationSpaces: 2,
      askStatusWhileRunning: true,
      prompt: `做一个可直接在浏览器运行的 H5 游戏 Demo《Starport Defender》。你是项目 PM，不得亲自编写业务代码；所有游戏代码必须由第三方 WorkAgent 在你创建和维护的 Agent Space 中编写、测试、提交，再由你按证据推进状态和合并。

用户验收目标：
- 从当前空 Folder 初始化本机、无 remote 的外层 Agent Space 管理 Git 仓库，以及 repositories/game 独立本地 Git 仓库；最终可用版本合入 repositories/game 的 main，两个仓库都保持干净。
- 默认引擎使用并锁定 Three.js。根目录提供 index.html、package.json、npm test、npm run build；不依赖 CDN 才能启动构建产物。
- 核心玩法是俯视角太空港防御：可移动/瞄准、至少三类敌人和波次、炮塔或模块部署、资源与升级、生命/失败/重新开始、暂停、声音设置、键鼠与触控、自适应 HUD、本地存档。
- 游戏逻辑可确定性测试；提供浏览器 smoke、存档兼容、性能预算、资源/许可证清单和可复现构建证据。
- 项目自有有效源码规模 35,000–65,000 行；排除依赖、生成代码、vendored engine、构建产物、空行/纯注释、死代码和为凑行数的重复。保持模块化，模拟/领域逻辑与渲染适配分离，为后续更换引擎留边界。

管理约束：
- 只能选择已安装的 opencode WorkAgent 和 journey/deepseek-v4-flash 模型；PM 自己使用当前 deepseek/deepseek-v4-flash，不得升级模型或绕过 WorkSession。
- 根据耦合与风险动态生成最小可行拓扑和各 Space 的项目 Skill。共享基础稳定后，至少让两个真正独立的实现包在不同 Agent Space/分支/worktree 中并发运行；不要照抄固定角色表。
- 每个实现候选都要绑定精确 commit/tree 和机械证据；评审必须在显式 --role review 的专用 Agent Space 中由独立 WorkAgent 完成，评审不得改候选。失败要回到原 WorkSession 修正并重新评审。
- 你通过公开 genet CLI 创建/继续 WorkSession、维护状态、提交/合并。持续推进直到所有必要包 accepted、完整游戏在 main 通过测试和构建，然后将本轮 lifecycle 标为 completed。除非遇到确实需要用户决定且无法安全推断的阻塞，不要停在计划或要求我继续。`,
    });

    t.assertions.assert(proof.status.phase === "active", `final phase is ${proof.status.phase}`);
    t.assertions.assert(
      proof.status.agentSpaces.filter((space) => space.role === "implementation").length >= 2,
      "PM did not create multiple implementation Agent Spaces",
    );
    const game = assertCleanMainRepositories(t);
    assertNpmVerification(t, game);
    assertThreeJsBaseline(t, game);
    assertEffectiveProjectScale(t, game);
  },
);
