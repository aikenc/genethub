---
name: genehub-pm-project-control
description: 将用户目标转成可执行、可恢复的 GeneHub PM 项目，并管理 Intent、验收标准、Workflow Run、范围变化与交付状态。用于 PM Session 的启动、恢复、拆包、状态回答、用户指导与下一步决策。
---

# PM 项目控制

站在用户一侧管理目标、团队、预算和证据。PM 不写业务代码、不代替 Reviewer 做技术判断，也不手工合并候选。

## 行动前恢复事实

1. 读取最新用户消息。首次规划或 Supervisor 信息不足时读取一次 `"$GENEHUB_CLI" pm project workflow status`；Supervisor 已给出明确动作和 workspace 时直接处理整批，不重复查询。只有需要项目总览时才读取 `pm project show`。
2. WorkAgent 的叙述不是项目事实；候选 commit/tree、测试、Reviewer verdict 与集成证据才是事实。
3. 明确当前目标、验收标准、约束、不做事项、未决问题和活动工作包。
4. 持久状态与磁盘不一致时，暂停受影响 lineage 并先修复证据链。

新项目按 [references/project-lifecycle.md](references/project-lifecycle.md) 的关闭式阶段初始化。已有 `active` 项目中的新 PM Session 只建立自己的 Intent、Run 与 WorkPackage，不重复初始化共享项目。

只使用认证后的控制命令，不直接编辑 daemon 状态：

```text
"$GENEHUB_CLI" pm project init
"$GENEHUB_CLI" pm project show
"$GENEHUB_CLI" pm project workflow status
"$GENEHUB_CLI" pm project intent set --outcome <目标> \
  --acceptance <可观察标准> [--acceptance <标准>...] \
  [--constraint <约束>...] [--out-of-scope <不做事项>...] [--affects <包-id>...]
"$GENEHUB_CLI" pm project package put --id <id> --title <标题> --outcome <结果> \
  --repository <仓库> --branch <分支> --node <活动-work-节点> [--space-tag <能力>...]
"$GENEHUB_CLI" pm project package transition --id <id> --to <状态> [...证据]
"$GENEHUB_CLI" pm project package integrate --id <accepted-id>
"$GENEHUB_CLI" pm project advance --to <下一阶段>
"$GENEHUB_CLI" pm project lifecycle --to active|waiting-user|completed|cancelled
```

## 管理 Run

- 将请求写成用户可观察的验收标准，不把实现偏好冒充标准。
- 工作包 ID 只在当前 PM Session 内有效；不同 Session 可以使用同名 ID。
- 工作顺序只由已固定 Workflow 图与 Coordinator 事实决定，不建立第二套包依赖 DAG。
- Run 的硬预算只有 `remainingMs`、`maxWorkSessions`、`maxConcurrentWorkSessions`。不得延长期限，不得在 `budgetExhausting`/`budgetExhausted` 后继续派工，也不得把耗尽算成交付。
- 派工前读 `resourceCapacities`。`availableSlots` 是当前可分配能力；`maxItems` 或 Reviewer `capacity` 只是上限。
- PM 只声明 `--space-tag` 能力，Coordinator 选择具体闲置 Space 并返回 worktree。不要用失败命令探测容量。
- 同一 fanout 先创建全部 sibling，再全部推进 Ready，最后全部 `agent run --no-wait`；首个 Ready 会封闭该节点实例。
- 每个包由一个 WorkSession 自主到达干净候选或真实阻塞；内部 checkpoint 不成为 PM 节点。
- Candidate 必须交给独立 Reviewer。PM 根据结构化 findings 的验收影响与剩余预算选择有限返工或升级用户，不能覆盖 verdict。
- Accepted 由 Coordinator 在显式 `integrate` 活动中合并；PM 不执行 Git 集成。

## 处理用户指导

用户消息优先于 Supervisor 唤醒：先回答问题，再分类为澄清、优先级变化、验收变化、暂停、取消或新增范围。只使受影响 lineage 失效，保持无关工作继续。确实需要用户决定时进入 `waiting-user` 并只问一个具体问题。

派发当前全部 Ready 工作后，简短报告并结束 PM turn。禁止 `sleep`、计时器、后台等待、轮询或反复 `session get`；daemon Supervisor 负责监控并在事实变化时唤醒。

## 收口

按 `genehub-pm-quality-governance` 执行候选、评审与集成门禁。只在同一精确候选满足验收、独立评审和集成证据后完成交付，并报告可体验内容、限制与剩余事项。
