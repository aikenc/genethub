# Workflow

本组文档描述当前源码的职责与运行契约。产品行为以实现为准；历史提案、某次测试结果和某个项目已安装的包版本分别查阅，不能相互代替。

| 要回答的问题 | 阅读入口 |
| --- | --- |
| PM、WM、WR、Worker、Executor、engine 和巡查各自负责什么？ | [角色与执行模型](model.md) |
| 消息、节点、Run、需求怎样完成？异常怎样恢复？ | [运行控制与恢复](runtime.md) |
| 包怎样发现、构建、激活、试验和更新？ | [包、候选与执行载体](packages.md) |
| 怎样编写和验证流程、角色、结构化输出及过程库？ | [编写与验证](authoring.md) |
| 持久状态实际放在哪？ | [存储规范](../storage-layout.md) |
| 纯控制流内核提供什么接口？ | [workflow-engine](../../packages/workflow-engine/README.md) |
| 内置包提供哪些业务方法？ | [game-delivery 包源](../../apps/daemon/workflow-packages/game-delivery/workflow.md) |
| 怎样选择和查阅验证？ | [测试入口](../testing.md) |

普通任务可直接复用已有 Workflow。维护方法时找 WM，审查方法时找 WR，业务产物由对应领域的 Worker/Reviewer 处理。PM 持续负责人的目标，执行与巡查由程序推进。

## 实现与证据索引

| 行为 | 主要实现 | 公共验证入口 |
| --- | --- | --- |
| Executor Session、Worker 归属、Run 与信息流 | `workflow/mod.rs`、`agent_space.rs` | `specialty.workflow.executor-session-flow` |
| 项目管理、异常兜底与退出 | `router.rs`、`workflow/requirement.rs` | `specialty.workflow.pm-exception-authority` |
| WM 管理角色与项目边界 | `router.rs` | `specialty.workflow.maintenance-authority.*` |
| 独立恢复 Run、PM 决定与后继 | `workflow/control.rs`、`workflow/recovery.rs` | `specialty.workflow.recovery-lifecycle`、`specialty.workflow.recovery-pm-gate` |
| 包物化和载体准备 | `workflow/package.rs`、`workflow/build.rs` | `specialty.agent-space.workflow-package-build` |
| WM/WR、候选试验与采用 | 包内 Skill、`workflow/mod.rs` | `journey.workflow.manager-improves-dcg-from-run` |
| 材料与正式目录隔离 | `workflow/mod.rs` | `specialty.workflow.trial-materials.*` |

上述 Rust 路径相对 `apps/daemon/src/`。case 名称是验证入口，是否在某个候选通过必须查该次 testctl Run，不能由本文推断。

## 历史资料

[可共享包提案](../shareable-workflow-proposal.md)、[流程去僵化提案](../workflow-derigidify-proposal.md)和 [Windows 审计](../windows-workflow-audit.md)保留当时的判断与证据。它们不是当前操作规范，尤其其中旧目录、Pack 路由、独立自动诊断和 `evidenceOnly` 描述已发生变化。Cloud 的 `docs/codesign-pm/README.md` 只索引协同设计历史，不再维护另一套当前角色定义。
