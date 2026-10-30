# 已废弃的部分

被标记为废弃的部分处于**冻结**状态：不加新功能，不增加新的依赖方，只修让现有内容继续运行的问题。标记不改变任何行为，也没有移动或删除代码；
除下表注明已移除者外，真正的移除另行计划。多会话协作的现行机制是团队，见 [teams.md](./teams.md)。

| 部分 | 位置 | 日期 | 说明 |
|---|---|---|---|
| Workflow 子系统 | 原 `apps/daemon/src/workflow/`、`packages/workflow-engine/` | 2026-10-24 | 已按用户决定彻底退役：引擎、后台巡查、CLI 命令、UI、内置包及专属测试移除。旧协议请求仅返回 `workflowRetired`；历史磁盘文件及会话保留，不执行或自动迁移。 |
| Agent Space 构建器（Rust 版 PipeBuilder 移植） | 原 `apps/daemon/src/agent_space_builder/` | 2026-10-10 | 已移除（2026-10-28）：构建职责归 Python SpaceBuilder；daemon 不再提供 `agentSpace.builder` RPC、`space builder` CLI 或 lock 校验 |
| 单人专家形态 | 团队样板 `team-template` 的旧用法：一个专家 = 前台 + 研究 + 工作 + 反思 | 2026-10-19 | 已废弃；每次 `init` 都建 1+N 团队，`init --team` 保留但无作用 |
| 团队样板的旧名 | `tools/expert.py`、`EXPERT_*`、`.genethub/expert/`、`expert` 标签、样板 Skill `expert-*`、`--expert` 参数、`posts/` | 2026-10-19 起 | 兼容中：`expert.py` 是转发到 `team.py` 的壳，旧变量、目录、标签与 Skill 名由 `team.py` 读取或迁移，`--expert` 是 `--team` 的别名，`posts/` 不再创建但保留；已有团队的钩子迁完前不删 |

## 不属于平台、不在本表范围

- `genethub-spaces/skills/common/pipebuilder/pipebuilder.py`：开发平台的临时工具，不是产品的一部分，不受平台约束。

## 对其他工作的影响

- 平台里“不写死 Agent 名字”的后续整改（动作 `confirm` 字段、`needsModelCatalog` 能力位、防回退检查）不再包含上述废弃目录；
  防回退检查把它们列为白名单，移除后白名单随之删除。
- 产品不再提供 Workflow 界面、`genet workflow`、`session flow` 或 Workflow 包物化/调度。
- 内置 Skills `pm-project-bootstrap` / `project-manager` 已下线；多会话协作使用团队 Skill。
- 用户已有 Workflow 目录和会话记录保持原样。旧 wire 数据类型仅用于历史兼容，未保留执行引擎。
- 仓库 CI 的 GitHub Actions workflows 和开发任务记录工具不是产品 Workflow 子系统，继续使用。
