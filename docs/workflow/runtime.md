# 运行控制与恢复

[文档入口](README.md) · [角色模型](model.md) · [包与候选](packages.md)

本文描述 daemon 的机械契约。PM 的业务判断、WM 的修改方法、WR 的报告要求由对应 Skill 指导；包中的流程定义业务阶段与验收。

## 输入、回执与控制

支持 `session.input.v1` 的客户端通过 `session.send` 提交稳定 `messageId`。daemon 在 ACK 前持久化正文、附件与接收事实。同一 Session 的相同 ID 不能换正文、来源或任务引用；`taskRunId` 需要与 PM 的任务归属匹配。CLI 的接收回执不表示 Agent 已开始或已完成工作。

输入队列区分接收、排队、可能已发送与已处理。断线或执行中断后，先核对原始消息、native 上下文及 Run/action 回执，再决定后续动作。平台不保证第三方外部副作用恰好一次。

会话投递器在启动时恢复已接受输入，并独立调度各 Session。能够中断并原生续接的 adapter 可接续忙碌会话；其他 adapter 等待执行边界。缺少必要的续接句柄会保留可见失败，不以新会话冒充旧执行。

Human 请求保持自己的 ID、问题和明确答复。PM 对问题的咨询不能替代正式答复，也不能借项目管理权绕过授权。Workflow 通知经同一持久队列送回 PM，处理通知前仍需先核对新的用户要求。

停止 PM 当前回合会暂停其自动续接，已有小队继续执行；取消任务使用独立的 Workflow 控制入口。普通 Workflow 通知不会解除暂停。新的用户输入，或对仍待处理问题的明确答复，会恢复继续处理；重放同一答复不会覆盖后来发生的停止。前端 `workSummary` 汇总需求及 Run，PM 空闲但 Worker 仍在工作时，任务仍可显示执行中。

## 派发、节点与结果

普通派发由项目根普通会话调用 `workflow dispatch`。项目已有接管授权时，同项目其他普通 PM 会话也可委托；受管子会话和跨项目调用会被拒绝。正常派发以 PM Session 与 `taskId` 绑定幂等身份，相同委托返回原 Run，不同内容复用同键报冲突。

Run 固定候选、定义、输入和执行目录。`agent.session` 节点在实际派发时按角色标签选择可用 Agent/model，并创建绑定 Run、节点和尝试身份的 Worker。流程内条件、并行、循环及修复由声明控制，不需要 PM 充当第二个节点调度器。

`workflow complete` 只接受当前节点所属 Worker Session 提交，并校验 Run revision、状态、声明的 outcome、结果形状及所需证据。PM、WR 或另一个 Worker 不能代交他人的节点。结果先进入 `finishing`，宿主确认进程与资源收尾后才推进后继，取消优先于后继启动。

v1 按 `on` 边选择后继；v2 由结构化内核决定控制流。未处理的失败依相应定义与执行路径退出；宿主不通过业务节点名称猜测返工流程。结构正确、证据非空或脚本返回成功，都不自动证明业务检查真实充分。

Run 快照是节点和 FlowMessages 的权威记录；`session.flow`、`workflow get` 读取同一事实。旧组件局部 manifest/inbox/outbox 文件不是恢复输入。CLI 等待 Run 的状态与收尾，不以一个 Worker 回合结束推断流程完成。

## 巡查与状态补偿

daemon 每五秒触发 `control::maintain`。它枚举已登记项目的未结束需求，利用有效 `settled` 标记跳过已收敛历史的 Run 快照。巡查本身不逐会话调用模型。

同一维护循环承担：

1. 核对需求写入所有权，接管时隔离旧执行。
2. 完成节点收尾，驱动 v2 结构化流程并核对运行状态。
3. 路由恢复后续派未启动节点，保留已经提交的节点结果。
4. 核对预算、人工等待、取消和清理。
5. 按条件启动恢复流程、交付 Human 卡或补送 PM 通知。
6. 检查 PM 对原需求的交付决定，满足条件后标记收敛并释放写入者。

运行中的节点会记录 Session 状态、实际工具/模型活动和时间。没有 Session 的待派发节点，或无人接棒且未收敛的 Run，可以触发 180 秒进度期限。活跃工具数分钟没有新输出不自动等于故障；预算和节点声明的限制仍独立生效。

业务执行结束但需求未交付时，空闲或未接手 PM 有 180 秒处理窗口；实际处理该需求的 PM 有 30 分钟决定窗口。窗口属于需求，不能通过无关聊天、心跳或其他任务重置。有效未答 Human 卡保留责任并按较低频率核查，答复后继续处理。

巡查错误写入需求投影；反复失败会降低重试频率。超过单次巡查看门狗期限只记录故障，不能丢弃可能已经产生外部副作用但尚未提交的执行结果并盲目重放。

## 三种不同的恢复动作

| 动作 | 作用 | 保留什么 |
| --- | --- | --- |
| `workflow recover` | 对 `recoverable` Run 恢复受支持的 Worker 尝试 | 同一 Run、已完成节点；可续接时保持原 Session 与写租约 |
| 恢复 Workflow | 调查故障、等待 PM 决定、修复与复查 | 独立恢复 Run，通过 `handles` 引用业务 Run，归属同一需求 |
| `workflow dispatch --retry-of` | 为同一目标建立后继执行 | 需求归属与共享预算；新 Run 从所选流程入口开始，可能重做前面的工作 |

同 Run 恢复需要满足实际 `Recovery` 记录的条件；旧进程仍在运行或缺少必要 native 续接句柄时不能强行继续。无写租约的重路由尝试也可能有外部副作用，必须检查已有回执。恢复不重建项目文件，也不保证任意并行丢失都可自动续跑。

### 恢复 Workflow

包的 `workflow.md` 可选择恢复流程，默认 `builtin`；当前自定义恢复契约接受 v1 图，不接受 v2 结构化恢复定义。巡查或 PM 的 `workflow recovery start` 进入同一路径。PM 主动请求处理仍在运行的业务 Run 时，先停止与清理，再启动恢复。每个包同时只允许一个活跃恢复 Run。

内置恢复使用独立角色：

```text
recovery-reviewer 复查 → 等待持久 PM 决定
  repair → recovery-manager 修复 → recovery-acceptor 验收 → 受控后继或待办
  resume / successor → 返回受控继续建议
  human / cancel → 明确交给相应处置
```

内置图允许有限返工，具体边以 [builtin-recovery.yaml](../../apps/daemon/src/workflow/builtin-recovery.yaml) 为准。review 节点的五类决策必须与已保存的 PM 问题答复相符；聊天中的“批准”不替代该受控答复。

这些专家是项目 Workspace 中新建的受管会话，不依赖项目 WM/WR Space 或旧 `diagnostic` 组件。自定义恢复使用正常包载体；当候选或恢复定义不可用时，宿主可进入内置兜底并记录降级原因。恢复 Worker 仍是图节点，须通过 `workflow complete` 提交结果。

内置 `recovery-reviewer` 完成复查后使用 `workflow consult --reason <复查报告与建议>`。该入口只接受当前运行的内置恢复 review Worker，由 daemon 创建持久化五选项问题并暂停 Worker，不依赖 Agent 原生提问工具的选项数量或格式。报告最多 16 KiB，作为来源数据展示。控制者 PM 先用 `session get <Worker Session>` 读取问题中的报告，再用 `session respond <Worker Session> --request <requestId> --choose <repair|resume|successor|human|cancel>` 答复；Worker 恢复后按已记录的决定调用 `workflow complete`。PM 不能替 Worker 提交，真实 Human 授权也不能由这次 PM 决策替代。旧的原生问题答复校验保留，重复 consult 不创建第二张问题卡。

PM 任务摘要分别提供需求状态、`runStatus` 和 `recovery`：恢复审查在后台运行、等待 PM、执行受阻都应可见，不能把恢复 Run 结束显示为原目标已经交付。

恢复结束不会自动交付用户目标。PM 继续判断交付、原定义后继、新定义后继或真实人工待办；失败恢复不能靠无限递归诊断掩盖问题。

## 预算与人工出口

业务需求默认共享 3 次 Run、7200 秒执行时间和 256 次已观察 LLM 调用；后继不能用新任务键重置同一目标的预算。Human 等待和已结束执行的间隔按记录排除；一个已准入 Run 不会因 `remainingRuns=0` 被撤回，要看 `currentRunCanExecute` 与剩余执行时间/调用数。

恢复使用独立有限预算，默认 3 个恢复 Run、200 次 LLM 调用、3600 秒。增加恢复额度需要真实 Human 决定。业务预算修订由 PM 根据已有授权和 Skill 执行，不能把 Skill 的常设额度策略误写成内核自动授权。所有修改仍受 revision 与 daemon 上限检查。

`request.budget` 是图内只读宿主能力，输出固定时点的预算事实，不预留未来额度、不授权扩容，也不把实时系统变量引入纯内核。

持久人工出口由 `workflow human` 等现有入口产生：a 业务额度、b 目标范围、c 恢复额度、d 平台反馈、e 安装/登录依赖、f 真人验收。应先读已有卡和答案；反馈答完不代表批准预算，也不代表原目标已经交付。

## 取消与需求交付

取消先保存取消事实，后停止相关执行、隔离会话并确认已知子进程及租约清理。清理未确认时保持 `cancelling` 并显示原因，不能提前宣称取消完成。产物和历史保留。

Agent 取消执行仍把原目标留给 PM 处置；直接 Human 取消或明确撤销选择才能取消目标。已取消需求只能由取消之后的新用户输入配合 `--resume-cancelled` 重开，旧问题的迟到答复不能重开。

需求状态为 `in_progress`、`completing`、`completed`、`cancelled`。PM 对照原目标和后续要求，读取业务 Reviewer 证据后，用 `workflow deliver --run <business-run> --revision <requirement.revision> --reason <conclusion> --evidence delivery=<reference>` 记录交付。平台检查归属、版本、活跃执行、清理和未答决定，业务验收质量由 PM/Reviewer 判断。

只有需求结束、执行收敛、通知处理完毕，才满足 settled 与写入者释放条件。`accepted`、`handled`、报告非空或恢复完成均不能替代这些事实。

## 权限与持久化边界

项目普通 PM 在已接管项目内具有常规管理能力；具体 Builder/组件操作仍校验计划、当前 revision、稳定 action ID 和目标范围。发生未结束故障时，`exception_authority` 从 Run 事实派生额外处置能力，允许项目 PM 接管相关会话；真实 Human 决定不因异常权限被代答。

维护角色可通过已有 Workflow 生命周期入口操作本项目，具体范围见[角色模型](model.md)。节点交卷、需求交付、受管会话控制及 Builder 各自还有进一步检查，不能将某一层通过当成全部授权。

会话、需求、Run 的格式版本及迁移接受范围以源码反序列化检查为准。不得手改私有记录，或把旧 daemon 能忽略未知字段当成迁移保证。目录与旧数据兼容范围见[存储规范](../storage-layout.md)。

实现：[输入调度](../../apps/daemon/src/session/manager.rs)、[控制循环](../../apps/daemon/src/workflow/control.rs)、[监督](../../apps/daemon/src/workflow/supervision.rs)、[恢复](../../apps/daemon/src/workflow/recovery.rs)、[需求](../../apps/daemon/src/workflow/requirement.rs)。
