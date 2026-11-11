# Task Owner：会话协作与 timer 接力

所有 task 子命令属于团队工具，不是新的内核 Workflow。原生执行 status 不被协作等待覆盖，timer 从派单、收件箱和任务引用推导 `.genethub/session-coordination.json`，工作台读取摘要显示等待与待处理。源事实损坏应报告待核对，不按空闲处理。

## 命令

- `task start --space ROLE --desc TEXT --request-id ID [--directory ABS] [--machine MACHINE] [--tier T|--model MODEL] GOAL`：前台建立稳定任务及 Owner 会话。重复 ID 和原参数读取原结果；不同内容拒绝。
- `task support TASK --space ROLE --desc TEXT --request-id ID ... GOAL`：Owner/子负责人发出支持请求，结果回到精确请求会话。默认等待本组必需支持全部结算；失败结算不等于成功。
- `task status TASK`：核对当前 Owner、版本、协作与控制回执。
- `task send TASK --request-id ID TEXT`：把追加要求投给该任务的精确 Owner。
- `task bind-directory TASK --directory ABS`：当前 Owner 或协作者为自己的执行会话认领写工位，不独占整个 Space；远端路径由原接单回执指向的执行端认领，源端不创建同名目录。
- `task finish TASK --outcome success|failed|blocked EVIDENCE`：提交本会话负责工作的明确结论；尚有未结算支持时不得宣称 success。
- `task pause|resume|cancel TASK --request-id ID --expected-revision N [用户原话]`：前台转达明确用户要求，保留原操作与协作树。暂停/取消发送成功不等于全部执行已停止，查询实际回执。
- `task handover TASK --session SID --request-id ID --expected-revision N`：原执行停止、资源核对后接手同一个任务；不重发已完成副作用。本版仅支持同机独立会话接手；跨机请求在中断旧Owner前拒绝，迁移需先显式交接产物和执行端资源。

## 长任务的并行默认与决策信息

预计超过30分钟的任务，Owner先识别互不依赖的部分；可拆时一次派出多项支持，目标在途5、最少2，每项说明独立写目录、输入、产物和验收。短任务直接完成；真实依赖或预算不允许时说明事实，不制造空转或拆碎工作凑数。只协调但尚未结算的会话也属于账本在途，暂停和等待用户不计。

前台可为同一用户目标中互不依赖的子目标分别选择Owner；每个任务保留自己的整合责任。写目录不能重叠，共享集成或发布资源仅在实际操作时串行。

`task start/support/status` 返回 `parallelism`，初始任务说明与结果唤醒附带相同口径的提示：最近120秒内可读、未暂停且未等待用户的未结算会话计入已知在途；创建中、过期或读取失败计未知。提示包括目标5和最少2，只提供决策信息，不硬性拦截任务或代替Owner拆分。这个瞬时账本数包含协调等待，与R6按原生执行区间累计的Agent工时不同。

## 跨机与部署

定义源和权威任务账本留在项目指定的 dev 主机。远端使用岗位 `TEAM_MACHINE` 声明、`employee sync` 安装的完整执行制品及实际本机模型；配置了 WORKTREE_DIR 时按固定工位串行，未配置时可准备同岗位多个独立会话，实际写项目之前各自 bind-directory；不 clone 团队定义源、不另起前台/timer。

日常只按岗位发任务。原接单回执保存来源机器／Space 与返回命令；远端 task 操作使用本会话的原回执返回源账本，修改安装默认不会改投在途任务。`.genethub/task-source.json` 由 build post 生成，仅作安装默认及旧任务兼容；Agent 不手填。它是路由与单源目录约定，不是平台 ACL。

协作摘要只有一个源、一个文件：发布版本递增，接收端拒绝异源和旧版，用接收时的本机时间判断新鲜度；读取缓存不会续期。摘要失效显示未知，不改变原生执行状态或任务结算。

内置模板发布不自动覆盖用户团队。合并定制后在源端构建，部署完整 tools/岗位/身份制品，目标 artifacts-only 验证并记录实际采用。升级前盘点在途回执；旧记录继续可读，未确认操作不换编号重派。

## 材料和恢复

适配器私有 `.genethub/sessions/SID/state` 不作为业务临时区。`temp new NAME --task-id TASK` 以当前会话身份分配独立目录；活动任务、等待/暂停、在途派单和未消费收件箱仍引用的材料不按 mtime 清理。正式产物存 datas 或项目工位。执行环境未收尾不释放目录、端口和设备。

创建使用可协商的 `--creation-id` 和 `--prepare-only`：先准备 SID，源端保存归属和反向依赖，再投递第一条业务。丢回执只重试原准备身份，原生消息稳定编号去重；旧端不支持时保留意图且不开始业务。

派单调度预算默认64个团队活动会话、单任务累计32个会话、任务年龄7200秒；对应 TEAM_MAX_ACTIVE_SESSIONS、TEAM_TASK_MAX_SESSIONS、TEAM_TASK_MAX_AGE_SECONDS。`task budget TASK` 和 `task status` 显示派单实际采用的限额、累计用量及各自阻塞原因；完成的支持不退还累计用量。

长目标到达任务限额时保留原编号和成果，由原前台在用户已给定的范围内明确决定，不自动增加限额或换编号绕过。原前台可用 `task budget TASK --max-sessions N --expires-at-ms MS --request-id ID --expected-budget-revision REV --reason "理由"` 显式调整本任务调度配额；按需只给一个限额。REV 取刚查询的预算 revision，与任务控制 revision 分开。重试复用原编号和参数；旧决定重放不续期，新决定必须核对当前 revision。

这只调整本任务的新派单容量，不改变用户目标、用户预算或用户截止，也不提高全队活动上限；原创建时间、历史用量、未完成支持、暂停与租约均保留。原前台会话归属用于协作一致性，不是新的 OS 权限层；该决策不代表 Human 新批准。私有看板的旧推算不能替代派单实际采用的预算视图。

机制故障默认记录供反思处理，真实成果/业务阻塞回原 Owner；恢复操作人不是结果接收方。原 operation 已释放的旧工位不得再碰新租约，未知冲突只阻塞对应项。

## 就绪结果与读入

子结果就绪后独立排入精确请求方的原生输入队列，不等待请求方回合结束或同批其他子项。
资源归还与结果入队分别对账；系统投递保留用户暂停。入队不等于 Agent 已读，已登记后台进程未归还时仍保持原资源保护。
成功收尾前必须读入必需子结果和已排队的追加输入；用原生 deliveredAtMs（Agent 已确认接收，非排队接受）核对，不凭 done 或资源已释放判断。

明确以 `blocked` / `failed` 收尾时，仍须读入已经投递的追加输入与结果，但不硬等尚无结果的支持。
结论的 `unresolvedWork` 保留这些原派单及准备中的操作；它们的原输入、执行、资源和晚到结果继续有效，
收尾不会取消支持、解除暂停、释放写锁或把支持标成完成。成功仍受完整读入保护。
原生支持会话失败时，timer 会送达一次明确的执行失败结果；它不是业务成功或业务结论，
不会自动续接失败会话。Owner 据此如实决定继续、受阻或失败，不能将未完成支持说成通过。
# 收尾合同的兼容更新

`task status` 的 `conclusionPolicy` 明示当前收尾能力。成功仍须必需支持完成并实际读入；`blocked/failed` 可以如实记录业务结论，同时把未决支持保存在 `finished.unresolvedWork`，不会取消子工作、恢复失败输入或解除其写资源。已送达的追加输入和结果仍须读入。

旧结果投递无法核实而支持原生执行已失败时，timer 会向空闲原 Owner 发一次 `task-settlement/2` 状态提示，帮助在途会话发现兼容更新；它不替代原业务结果、原生消费回执或用户验收，也不是新目标、续期或强制收尾。
提示先按稳定身份持久入收件箱，再由原投递器按原生回执核对；本地入队不等于送达或读入。其他未完成支持不会拦住这条状态提示，原暂停和待用户输入仍保留。
