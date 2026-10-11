# 已废弃的部分

被标记为废弃的部分处于**冻结**状态：不加新功能，不增加新的依赖方，只修让现有内容继续运行的问题。标记不改变任何行为，也没有移动或删除代码；
真正的移除另行计划。

| 部分 | 位置 | 日期 | 说明 |
|---|---|---|---|
| Workflow 子系统 | `apps/daemon/src/workflow/`、`packages/workflow-engine/`，以及 `docs/` 下的 `pm-workflow-control`、`workflow-authoring`、`windows-workflow-audit`、`shareable-workflow-proposal`、`workflow-derigidify-proposal`、`workflow-executor-model` | 2026-10-10 | 退役中 |
| Agent Space 构建器（Rust 版 PipeBuilder 移植） | `apps/daemon/src/agent_space_builder/` | 2026-10-10 | 退役中；它按名字写死 4 个 Agent 的目录布局，不再改造成数据驱动 |

## 不属于平台、不在本表范围

- `genethub-spaces/skills/common/pipebuilder/pipebuilder.py`：开发平台的临时工具，不是产品的一部分，不受平台约束。

## 对其他工作的影响

- 平台里“不写死 Agent 名字”的后续整改（动作 `confirm` 字段、`needsModelCatalog` 能力位、防回退检查）不再包含上述废弃目录；
  防回退检查把它们列为白名单，移除后白名单随之删除。
- 仍引用这些部分的入口（工作台的 Workflow 界面、`genet` CLI 的 Workflow 命令、`workspace.rs` 对构建器的调用、内置 Skills `pm-project-bootstrap` / `project-manager`）
  尚未单独标记，也未改动行为；是否一并下线，由退役计划决定。
