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
   、`maxConcurrentWorkSessions` 与 `llmRequestsRemaining`。该预算只属于本 PM Session 的任务 Run，
   不存在可被某个 Session 改写的项目级预算池；用户决策节点的等待时间由图状态触发暂停，不消耗执行
   时钟。一个 adapter 报告的 LLM round 粗略计为一次请求，Coordinator 汇总 PM、Worker 与 Reviewer
   已完成 TurnSummary 和运行中 TurnProgress；长回合已经发生的请求不会等到回合结束才计入预算，模型
   不能自报、延迟或重置。时间或请求预算到期、或进入
   `budgetExhausting/budgetExhausted` 后不得继续派工，
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
7. WorkPackage 进入 `Candidate` 后，由 PM 负责组建评审小队：对**原 WorkPackage id**在 Coordinator
   给出的独立 Review Space 中启动一个 Reviewer WorkSession。不要新建“Review WorkPackage”，也不要等待
   Coordinator 自己创建 Reviewer。Workflow 中 `review` 节点的 `actor: system` 只表示 Coordinator 负责
   校验 Reviewer 结果、推导 `review.*` 事实和推进图，不表示 Coordinator 负责选择 Agent 或创建会话。
   Supervisor 的 Candidate 事件会携带 `action=dispatch-independent-review`、`reviewSpace` 与
   `reviewWorkspace`；PM 必须使用该 workspace 和原包 id 执行 `genet agent run ... --work-package <包 id>
   --no-wait <评审合同>`。评审合同必须保持候选 worktree 只读：只用 Git 身份/diff 与候选自己的定向
   测试、build 取证，不得 checkout/revert/reset、复制候选后反演基线、写入或清理候选文件。若评审命令
   改动 tracked 文件或留下非忽略文件，Reviewer 必须返回 `review-fail`，不得自行清理后宣告通过。
   并行 fanout 的 Reviewer 还必须拒绝候选代码或测试依赖“兄弟包尚未合入”才成立的偶然绿色断言，例如
   把当前为空的 live registry、暂缺的导出或默认调用暂时返回 null 当成永久契约；包内语义使用
   注入 fixture，共享 live 状态只断言在兄弟包合入前后都成立的条件不变量。但不得反向误用这条：若最终组合
   门禁只因责任兄弟包尚未合入而暂时不可观测，不能据此把绑定切片判失败或要求它修改责任外路径；应用 fixture
   或动态探针评审本包边界，完整合流门禁留到 merged baseline。review-fail 必须指向由绑定候选造成的验收缺陷
   或明确的集成 seam，不能只报告“兄弟包不在”。这些判断属于 Reviewer，不得转交 PM 读代码补评。
   独立 Reviewer 的结构化 `review-pass` 由 Coordinator 绑定到精确候选并自动进入 `Accepted`；随后
   `actor: system` 的 `integrate` 节点串行完成受控本地 Git 集成，复验候选 commit/tree、Reviewer
   独立性与 verdict、干净 `main`、合并结果和祖先关系，并从持久证据推导 `baseline.integrated`。PM
   不执行评审、验收或 Git 合并。`review-fail` 进入 `review-triage`：PM 只依据验收影响与本 Run 剩余预算
   选择有边界返工，或升级给用户作范围/预算决策；不能覆盖 Reviewer verdict。集成冲突会记录
   `integration.blocked` 并进入恢复路径；
8. terminal 后确认 WorkSession 结束和 Space 已回收或隔离，再向用户报告交付。

### PM Activity 快速路径

`activity + actor: pm` 节点的语义输出由 PM 明确记录；它们不是 Coordinator 能从 Git、WorkSession 或
租约中自动推导的事实。不要用 `--help` 试探参数，也不要 grep/read GeneHub 产品源码来猜公共 CLI。
完整命令形态如下：

```text
genet pm project intent set --outcome <目标> --acceptance <标准> [--acceptance <标准> ...] [--constraint <约束> ...] [--out-of-scope <不做事项> ...]
genet pm project workflow transition --edge <当前 PM 出边> --fact <该活动声明且已经完成的 output>
genet pm project package put --id <稳定包 id> --title <用户可见职责> --outcome <可验证结果与证据> --repository <repositories 下直接子目录名> --branch <独立本地分支> --node <当前活动 workAgent 节点> [--space-tag <包级专业能力> ...]
genet pm project package transition --id <包 id> --to ready
genet agent run --agent <第三方 Agent id> --model <该 Agent 原生 model id> --workspace <Coordinator 选中 Space 的 workspace id> --work-package <包 id> --no-wait <完整工作合同>
```

候选评审复用最后一条命令，但 workspace 必须是 Supervisor/Coordinator 返回的独立 Review Space，
`--work-package` 仍是原 Candidate 包 id。该调用会原子完成 Candidate → Review 和 Review WorkSession 绑定；
PM 不执行 `package transition --to review`，也不注入 `review.pass/review.fail`。如果 Candidate 事件显示
`reviewTarget=unavailable`，先补建、修复或重新记录符合包级能力标签的 Review Space；不能只等 system 节点。

`package put` 的必填字段就是 `id/title/outcome/repository/branch/node`；`--space-tag` 可重复但不是必填。
不要用 `responsibility`、`goal`、旧的 `space/worktree` 字段，也不要用 `--help` 或失败调用来发现它们。
若用户或结构化输入已经给出 Agent、原生 model id、包级能力和 workspace id，就把 Workflow 选择、Intent、
PM 边和当前 fanout 的全部派工放进一次内置 `genehub` 批量工具调用；不要再次执行 `agent list`，也不要
改用 shell。fanout 的命令必须严格分成三个连续阶段：先执行本节点**全部** `package put`，确认所有兄弟包
仍为 Planned；再执行本节点**全部** `package transition --to ready`；最后执行本节点**全部**
`agent run --no-wait`。禁止按单包交错成 `put A → ready A → run A → put B`，因为第一个 Ready 会封闭
节点实例并拒绝后续兄弟包。批量命令仍逐条经过 CLI、鉴权、Coordinator 和租约门禁，不是绕过内核。

内置 `feature` 图在需求已经明确时采用这条精确路径：

```text
genet pm project intent set --outcome <目标> --acceptance <标准> ...
genet pm project workflow transition --edge aligned --fact intent.aligned
genet pm project workflow transition --edge planned --fact plan.ready
```

同一次转换可以重复 `--fact` 记录多个已完成输出，但只能使用当前 PM 节点在 Workflow YAML 中声明的
`outputs`。`work.*`、`review.*`、`baseline.*`、`integration.*`、租约和 Space 状态均由 Coordinator
从持久证据推导，PM 不得注入。条件尚未满足时 CLI 会返回缺失的 PM output 及可直接执行的命令；按该公开
错误恢复，不要搜索实现源码。

带 `fanout.source` 的节点由 PM 在节点仍为 Planned 时一次性创建本次遍历的全部结果型 WorkPackage；该字段
只记录工作流来源，不执行任意表达式。任一工作包开始后 Coordinator 会封闭该节点实例的集合，后续不得悄悄
补包。`maxItems` 是硬上限。所有兄弟包结算后，Coordinator 才从持久状态推导 candidate/blocked
事实；PM 不能用 `--fact` 自述这些事实。返工保留旧包及评审证据，在新节点实例中使用新 WorkPackage id。

评审失败后选择返工时，保留旧包和 Reviewer 证据，在新节点实例创建新的 WorkPackage id。若 finding 属于原切片，
新包复用失败包的精确 `repository`、`branch` 与包级能力标签，Coordinator 只在同一 PM Session 内复用该分支
lineage。若结构化 finding 明确指向另一已声明责任包或集成 seam，PM 不读代码重判 verdict，但要按已知责任边界
把最小返工路由到拥有该边界的 `branch`/能力标签，不得强迫原切片修改责任外路径。禁止跨 Session 借用或把 Space
修复当作返工手段。

`Cancelled` 只表示 PM 在派发前撤回误建的 Planned 或尚未持租约的 Ready 包。Coordinator 保留原包和
Team Slot 历史、释放其 fanout 名额，并在同一活动节点允许用新 id 补位；一旦本包或任一兄弟包取得租约、
开始 WorkSession、形成候选或节点已经前进，就不得用取消规避证据，必须记录为 `Blocked` 并走恢复路径。

工作包按可观察结果划分，并由一个 WorkSession 自主推进到干净候选。WorkAgent 内部 checkpoint 不形成新的
DCG 节点，也不触发 PM 逐提交复核。Supervisor 会在短窗口内合并多个 WorkSession 状态变化；每次唤醒只读
一次项目投影、处理整批 candidate/blocked/failed 事项，不轮询仍在运行的会话。只有候选、真实阻塞、终止
失败、连续两次无新 checkpoint 的截断，或用户/合同变化，才重新进入包级管理决策。

拆包同时受结果完整性和 Run 请求预算约束。对于十分钟级、快速模型的交互 Run，初始规划应让单个 Worker
结果包大致能在 12-18 次 LLM 请求、且不超过剩余主动时间一半时形成首个干净候选，并为独立 Reviewer、
PM 处理 findings 与 Coordinator 集成保留请求和时间。该区间是依据同项目历史证据调整的估算，不是第二套
包级硬预算：若某类包历史上持续超出，就按互不重叠的文件所有权和独立验收面拆成结果包；不要把
engine、UI、build、persistence 等多个可独立验证子系统塞进一个包，也不要反向拆成单文件或 checkpoint 包。

请求预算按整个任务 Run 的实际参与者标定，而不是给每个包再建一套可漂移预算。三至四路 fanout 的十分钟
feature Run 需要覆盖 PM 编排、三至四个 Worker、对应的独立 Reviewer 和可能的一次有界 findings 处理；默认
128 次请求是该拓扑的硬上限。四路并行只用于互不重叠、可独立形成候选的结果包，不得把一个耦合任务机械
切成四份。Reviewer 合同应目标化并批量取证：通常用 6-12 次请求、最多三组只读合并
命令完成候选身份/范围检查、定向测试与构建，不逐个通读确定性生成的同构模块。Reviewer 不通过
checkout/revert/reset、候选复制或基线反演制造对照，不写入或清理候选；命令造成非干净 worktree 时必须
失败关闭。Reviewer 仍必须独立运行验收命令并给出 verdict，不能因为节省请求而让 PM 代评或只信任
Worker 自述。

十分钟内的 bugfix 图允许最多三个相互独立的结果型 WorkPackage 并行完成复现、根因证据、回归测试与修复；
migration 的切片也可以按图的 fanout 在多个 Space 并发。中间只读调查不是可交付候选，不单独占用独立
Review；每个最终候选仍必须经过另一个 Review Space。

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
