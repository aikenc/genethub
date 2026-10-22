# 已废弃的部分

被标记为废弃的部分处于**冻结**状态：不加新功能，不增加新的依赖方，只修让现有内容继续运行的问题。标记不改变任何行为，也没有移动或删除代码；
真正的移除另行计划。多会话协作的现行机制是团队，见 [teams.md](./teams.md)。

| 部分 | 位置 | 日期 | 说明 |
|---|---|---|---|
| Workflow 子系统 | `apps/daemon/src/workflow/`、`packages/workflow-engine/`，以及 `docs/` 下的 `pm-workflow-control`、`workflow-authoring`、`windows-workflow-audit`、`shareable-workflow-proposal`、`workflow-derigidify-proposal`、`workflow-executor-model` | 2026-10-10 | 退役中 |
| Agent Space 构建器（Rust 版 PipeBuilder 移植） | `apps/daemon/src/agent_space_builder/` | 2026-10-10 | 退役中；它按名字写死 4 个 Agent 的目录布局，不再改造成数据驱动 |
| 单人专家形态 | 团队样板 `team-template` 的旧用法：一个专家 = 前台 + 研究 + 工作 + 反思 | 2026-10-19 | 已废弃；每次 `init` 都建 1+N 团队，`init --team` 保留但无作用 |
| 团队样板的旧名 | `tools/expert.py`、`EXPERT_*`、`.genethub/expert/`、`expert` 标签、样板 Skill `expert-*`、`--expert` 参数、`posts/` | 2026-10-19 起 | 兼容中：`expert.py` 是转发到 `team.py` 的壳，旧变量、目录、标签与 Skill 名由 `team.py` 读取或迁移，`--expert` 是 `--team` 的别名，`posts/` 不再创建但保留；已有团队的钩子迁完前不删 |

## 不属于平台、不在本表范围

- `genethub-spaces/skills/common/pipebuilder/pipebuilder.py`：开发平台的临时工具，不是产品的一部分，不受平台约束。

## 对其他工作的影响

- 平台里“不写死 Agent 名字”的后续整改（动作 `confirm` 字段、`needsModelCatalog` 能力位、防回退检查）不再包含上述废弃目录；
  防回退检查把它们列为白名单，移除后白名单随之删除。
- 仍引用这些部分的入口（工作台的 Workflow 界面、`genet` CLI 的 Workflow 命令、`workspace.rs` 对构建器的调用）
  尚未单独标记，也未改动行为；是否一并下线，由退役计划决定。
- 内置 Skills `pm-project-bootstrap` / `project-manager` 已下线，其 Workflow 入口能力不再随产品分发；
  Workflow 的测试 case 与 fixture 仍保留，供退役计划核对。
