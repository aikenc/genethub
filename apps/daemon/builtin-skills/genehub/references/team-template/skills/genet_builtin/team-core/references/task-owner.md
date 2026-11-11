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

定义源和权威任务账本留在项目指定的 dev 主机。远端使用岗位 `TEAM_MACHINE` 声明、`employee sync` 安装的完整执行制品及实际本机模型；新 Task 按会话准备，同岗位可同时有多个独立会话，不因岗位 WORKTREE_DIR 默认占用固定目录。实际写项目前各自在执行端准备独立工位并 bind-directory；也可派单时用 --directory 指定执行端已存在的绝对目录，由接单端认领，源端不解析或创建该路径。需要共用的集成、发布目录只在实际认领期间保持单写者；旧 spawn 和未升级的旧派单仍沿原绑定收尾。执行端缺少会话工位协议时会在创建前拒绝，按原意图同步升级后重试；不 clone 团队定义源、不另起前台/timer。

日常只按岗位发任务。原接单回执保存来源机器／Space 与返回命令；远端 task 操作使用本会话的原回执返回源账本，修改安装默认不会改投在途任务。`.genethub/task-source.json` 由 build post 生成，仅作安装默认及旧任务兼容；Agent 不手填。它是路由与单源目录约定，不是平台 ACL。

协作摘要只有一个源、一个文件：发布版本递增，接收端拒绝异源和旧版，用接收时的本机时间判断新鲜度；读取缓存不会续期。摘要失效显示未知，不改变原生执行状态或任务结算。

内置模板发布不自动覆盖用户团队。合并定制后在源端构建，部署完整 tools/岗位/身份制品，目标 artifacts-only 验证并记录实际采用。升级前盘点在途回执；旧记录继续可读，未确认操作不换编号重派。

## 材料和恢复

适配器私有 `.genethub/sessions/SID/state` 不作为业务临时区。`temp new NAME --task-id TASK` 以当前会话身份分配独立目录；活动任务、等待/暂停、在途派单和未消费收件箱仍引用的材料不按 mtime 清理。正式产物存 datas 或项目工位。执行环境未收尾不释放目录、端口和设备。

创建使用可协商的 `--creation-id` 和 `--prepare-only`：先准备 SID，源端保存归属和反向依赖，再投递第一条业务。丢回执只重试原准备身份，原生消息稳定编号去重；旧端不支持时保留意图且不开始业务。

派单共享预算默认64个团队活动会话、单任务累计32个会话、任务年龄7200秒；对应 TEAM_MAX_ACTIVE_SESSIONS、TEAM_TASK_MAX_SESSIONS、TEAM_TASK_MAX_AGE_SECONDS。达到限额保存成果并报阻塞，不换编号绕过。

机制故障默认记录供反思处理，真实成果/业务阻塞回原 Owner；恢复操作人不是结果接收方。原 operation 已释放的旧工位不得再碰新租约，未知冲突只阻塞对应项。
