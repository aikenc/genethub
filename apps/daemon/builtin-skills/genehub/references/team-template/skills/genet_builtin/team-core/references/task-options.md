# 按需任务参数与恢复

仅在派单、报错、调整额度或控制时查本页，不作为日常岗位整段必读。命令统一以 `"$GENEHUB_PYTHON" <团队根>/tools/run.py` 开头。

## 原任务命令与回执

- `task start --space ROLE --desc TEXT --request-id ID [--directory ABS] [--machine MACHINE] [--tier T|--model MODEL] GOAL`：前台建立任务与 Owner。重试读取同一编号原结果，不同内容拒绝；创建未知不换号重派。
- `task support TASK --space ROLE --desc TEXT --request-id ID ... GOAL`：Owner/子负责人请求支持，结果回精确请求会话，不自动改投前台。可同时派多项，派出后结束本轮。
- `task status TASK --summary`：先读有界收尾摘要。`ownWork` 只指本会话；Owner 的 `taskConclusion`、全任务的 `supports` 不能代替自己的收尾。跨机响应截断时保持未知，完整历史按需不带 `--summary` 查。
- `task send TASK --request-id ID TEXT`：追加原意图给精确 Owner。accepted 仅表示受理，不等于恢复、读入或完成；已结论任务另核原控制回执与 `recordedOutcome`、`capacityBudgetView`。
- `task bind-directory TASK --directory ABS`：本会话认领独立写工位。原生 cwd 可能是岗位 Space，实际操作明确业务路径；远端认领在原执行端完成，源端不创建同名目录。
- `task finish TASK --outcome success|failed|blocked EVIDENCE`：提交本会话真实结论。产物、验证和必要传输先就绪，不能先记结论再做十多分钟验证或拷贝。普通中间回复、支持成功和阶段结算不代表长期目标达成或 QA 通过。
- 整合结论可重复用 `--uses <子派单operationId>` 引用自己请求、已结论且实际读入的同任务产物；中途整合可在原生已完成回复单独写 `采用：ghref:item:...` 的精确结果引用。引用可省略，不另做逐项审批；只是有界整合声明，不冒称 Git 合入或真实用户验收。
- `task pause|resume|cancel TASK --request-id ID --expected-revision N [原话]`：按真实用户要求控制原任务树，原输入、暂停来源、支持与资源回执保留。发送成功不等于已停，查实际回执；普通通知不解除暂停。
- `task handover TASK --session SID --request-id ID --expected-revision N`：旧执行停止、资源核对后沿原任务交接，不重跑副作用。本版仅同机独立会话；跨机请求先拒绝，迁移须先交接真实产物和执行资源。

旧 failed/blocked 是真实阶段结论，持续授权未撤回不意味着原目标完成；但普通 send 不解除收尾门槛。用户明确继续时按实际控制归属用原 Task 显式 resume，完整旧结论保留 `conclusionHistory`，独立暂停的支持和失败输入不自动重试。来源未知的暂停不擅自恢复；新意图、阶段结论和 Human 控制分别保留。

## 调度额度

`task budget TASK` 读实际额度、累计用量、budget revision 与阻塞原因。当前 Owner 或原前台核目标手记余额后，可用 `task budget TASK --max-sessions N --expires-at-ms MS --request-id ID --expected-budget-revision REV --reason TEXT`。同一编号重试参数一致；控制 revision 与 budget revision 分开。默认环境项 TEAM_MAX_ACTIVE_SESSIONS=64、TEAM_TASK_MAX_SESSIONS=32、TEAM_TASK_MAX_AGE_SECONDS=7200；不得据此扩大用户预算或清历史。

旧 `--unit-of`/`--unit-stage` 仅兼容原记录；新业务不另建评分单元。`--follows OP` 声明真正返工，正常 QA 不按返工；长期常驻支持可按原合同用 `--standing`。其余 `--creation-id`、`--prepare-only` 与恢复参数只在对应命令帮助或报错指引需要时使用，不因字段存在另加登记或审批。

## 后台、派单与资源证据

有界构建、测试或安装用 `task job register TASK --job-id ID --pid PID --kind build|test|install|work --max-seconds N`，N为1至86400。PID 来自当前渠道原生 `genet process list`、属于本会话并排除预览服务，不用命名空间里的猜测 PID；登记不启动/终止进程。相同编号重试保留原登记，参数变化拒绝。

`task job status TASK --job-id ID` 读取实际状态；进程退出后 `task job finish TASK --job-id ID --exit-code N` 结算，仍运行时拒绝。只有原生身份与运行年龄可核且未超期限才延续工时；缺读数、进程消失或身份变化都不猜最后退出时间。退出码不是业务验收。

`registered-native-execution-union/2` 使证实的后台并入正式 R6，并从 R4 停滞区间扣除；回合与作业重叠不重复，暂停扣除，退出后不增长。`quality execution --snapshot FILE` 仍是独立诊断，不保存正式卡。

资源义务来自真实工位/写锁或远端租约，Agent 常驻进程本身不制造归还义务；有义务且原生进程仍在就仍占用，结论后超时继续判 R5。结果入队、读入、业务结论与资源归还分别核对，不因一项成功替代另一项。

## 质量只读与诊断

`quality card`、`quality history`、`quality describe` 只读；`quality card --snapshot FILE` 回放冻结事实，不保存官方采用卡。`quality facts` 即时诊断，`quality execution --snapshot FILE` 独立后台诊断；`quality triage INSTANCE --attribution SOURCE --evidence TEXT` 仅更正原归因并保留旧依据，不人工解除红线。
