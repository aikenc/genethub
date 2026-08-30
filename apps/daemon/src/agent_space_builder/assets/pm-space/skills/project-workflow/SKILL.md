---
name: project-workflow
description: 对齐用户需求，选择并执行项目 Workflow DCG，动态组织 WorkAgent 小队、收集类型化证据，并且只选择 Project Coordinator 接受的转换。用于此 PM Space 中的每个受管需求。
---

# 项目工作流

每个新 PM Session 从未选择 Workflow 的 `discussion` 状态开始。先对齐用户的目标、验收标准、约束和
不做什么，再读取 `catalog.yaml`，选择匹配的 Workflow。推荐图只是建议，纯答疑不需要选图。

Project Coordinator 是图版本、节点实例、合法边、AgentSpace 资源状态、租约和转换证据的事实来源。
AgentSpace 的状态机属于固定内核，不在 Workflow DCG 中定义，也不得通过提示词绕过。不得在 Coordinator
已接受状态之外虚构图、边、Space 租约、WorkSession 或转换。
项目 phase、lifecycle 和 AgentSpace 池是所有 PM Session 共享的项目级事实。项目初始化 Session 将拓扑推进
到 `active` 后，后续需求 Session 只维护自己的 Intent、Run 和 WorkPackage；不得重复初始化项目、推进共享
phase，或仅因 Session id 不同就重新注册、重建、重录已有 AgentSpace。

执行顺序：

1. `genet pm project workflow list` 查看项目 Workflow；
2. 需求明确后立即用 `genet pm project workflow select --graph <id>` 固定本 Session 的图版本和
   `executionBudget`；内核从此计时，提示词无权延长。每次派工前读取 `remainingMs`、`maxWorkSessions`
   与 `maxConcurrentWorkSessions`，预算到期或进入 `budgetExhausting/budgetExhausted` 后不得继续派工，
   也不得把预算耗尽报告成完成；派发保留会单调消耗总会话额度，provider/session 创建失败、清除绑定或
   重试都不会返还；
3. 正常需求推进只用一次 `genet pm project workflow status` 读取本 Session 的 Run、WorkPackage、精简
   AgentSpace 池和 `resourceCapacities`；不要在每次 Supervisor 唤醒时读取包含所有 Session 的
   `pm project show`。按节点的 `availableSlots`
   决定本轮可立即分配的基础并行度；`maxItems` 只是上限，不代表已有足够 Space，包级 `--space-tag`
   还可能进一步收窄匹配。容量不足时先补建并注册 Space 或缩小 cohort，不要用失败的 `package put` 探测容量；
4. 只为当前活动节点筹备输入、WorkPackage 和证据；每个 `package put` 必须用
   `--node <active-node>`，Coordinator 会把 WorkPackage 固定到本次遍历产生的节点实例，而不只是节点名；
5. 注册 AgentSpace 时按当前节点 `space.matchTags` 使用一个或多个 `space record --tag <tag>` 声明能力；
   `package put` 不指定物理 Space。若同一 fanout 含不同专业能力，用一个或多个
   `--space-tag <capability>` 声明该工作包独有的专业能力；不要重复当前节点的 `space.matchTags`，
   Coordinator 会单独应用节点基础标签与包级标签，并在创建时拒绝二者重叠。只有包级能力会固化为
   `requiredSpaceTags` 并用于选择对应能力的独立 Review Space。`package put` 只接收 `--repository` 与 `--branch`，并返回派生的
   `worktrees/<space>/<repository>`；PM 在该路径创建 worktree 后再推进 Ready，WorkSession 仍须使用
   返回的 Space。不得传旧的 `--space`/`--worktree` 参数；`--space-tag` 是能力而不是 Space 名；
6. 只从 Coordinator 返回的合法边中推进。唯一确定边由 Coordinator 自动处理；语义分叉才由 PM 选择；
7. terminal 后确认 WorkSession 结束和 Space 已回收或隔离，再向用户报告交付。

带 `fanout.source` 的节点由 PM 在节点仍为 Planned 时一次性创建本次遍历的全部结果型 WorkPackage；该字段
只记录工作流来源，不执行任意表达式。任一工作包开始后 Coordinator 会封闭该节点实例的集合，后续不得悄悄
补包。`maxItems` 是硬上限。所有兄弟包结算后，Coordinator 才从持久状态推导 candidate/blocked
事实；PM 不能用 `--fact` 自述这些事实。返工保留旧包及评审证据，在新节点实例中使用新 WorkPackage id。

`Cancelled` 只表示 PM 在派发前撤回误建的 Planned 或尚未持租约的 Ready 包。Coordinator 保留原包和
Team Slot 历史、释放其 fanout 名额，并在同一活动节点允许用新 id 补位；一旦本包或任一兄弟包取得租约、
开始 WorkSession、形成候选或节点已经前进，就不得用取消规避证据，必须记录为 `Blocked` 并走恢复路径。

工作包按可观察结果划分，并由一个 WorkSession 自主推进到干净候选。WorkAgent 内部 checkpoint 不形成新的
DCG 节点，也不触发 PM 逐提交复核。Supervisor 会在短窗口内合并多个 WorkSession 状态变化；每次唤醒只读
一次项目投影、处理整批 candidate/blocked/failed 事项，不轮询仍在运行的会话。只有候选、真实阻塞、终止
失败、连续两次无新 checkpoint 的截断，或用户/合同变化，才重新进入包级管理决策。

使用活动节点指定的提示词。PM 只能在 Coordinator 返回的合法边中决策，不能代替用户完成用户决策。
WorkAgent 目标只描述结果和证据合同，不固定 Agent runtime 或模型。

异常先进入 `prepare-recovery`。PM 只负责整理可信证据、必要时修复被隔离的 Space，并把图推进到 `recover`；
`recover` 的 `chooseBy: user` 选项必须由用户通过 Web/RPC 选择，不能由 PM CLI 冒充。作出选择前先结束相关
运行中 WorkSession；Coordinator 会保留 Accepted 兄弟包并结算旧尝试，重试后必须创建新的包和 WorkSession。

## 安全自举

执行中发现 Workflow 或 Prompt 问题时，先收集具体失败、用户反馈和可复现证据。候选只能写到
`skills/project-workflow/candidates/<candidate-id>/dcg/*.yaml` 或 `.../prompts/*.md`，不能直接改当前生效文件。

1. `genet pm project improvement propose --id <id> --target <dcg/x.yaml|prompts/x.md> --rationale <证据>`
   封存候选和当前版本摘要；
2. 派发独立 Review WorkSession，不得由提出候选的同一工作上下文自审；
3. 评审完成后执行
   `genet pm project improvement review --id <id> --session <work-session> --evidence <摘要> --pass`；
4. 等待用户在 PM Session 的“PM 自举改进”卡片明确批准。没有用户批准不得晋级；
5. 批准后执行 `genet pm project improvement promote --id <id>`。Coordinator 会复验候选摘要、当前版本摘要
   和完整 Workflow catalog；任一漂移或校验失败都会拒绝或回滚。

晋级只影响后续新建的 Run；已经固定图版本的 Session 不在运行中偷换 Workflow。失败候选保留为项目历史，
应以新 id 修正，不能覆盖证据链。
