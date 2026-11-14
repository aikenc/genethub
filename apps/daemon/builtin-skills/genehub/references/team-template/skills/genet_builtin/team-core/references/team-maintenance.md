# 按需团队维护

仅处理相应维护或恢复问题时读取；日常依靠五个 task 入口。

- 命令前缀 `"$GENEHUB_PYTHON" <团队根>/tools/run.py`。directory/experts/me/看板读取只读；缺登记不自动 space open。用户移除团队后，遗留目录/会话不是恢复授权。整树移除遇运行或交互拒绝，不逐个绕过。
- 员工/工位：employee add/ls/retire 管岗位，worktree create/bind/ls 管独立写目录；task bind-directory 绑定实际写目录。原任务机器和返回来源固定。远程岗位只在该岗位 open.env 配 TEAM_MACHINE，再 employee sync；细节见 remote-targets.md，不手写安装脚本。
- 发布：publish release <源> --name <vX.Y> 归档 datas/releases/；publish report <源> --slug <名> 归档 datas/reports/；publish rollback 回滚 latest。board start/refresh 提供 datas/board/index.html，先有真实文件才链接。
- 临时区：temp new <slug> --task-id <taskId> --purpose TEXT 创建会话独立目录；temp ls/rm/clean 查清理。正式产物先归档，未收尾任务/暂停/在途回执以及 summary.md/evidence/ 引用不得清理。适配器私有 state 不是业务临时区。
- 留言：note --kind unhappy|preference|external|observation --quote TEXT；reflect now TEXT 提交反思信号；无动作只 notes done <编号> --result TEXT 结束原项，不写巡查报告。反馈维护见 team-reflect references/platform-feedback.md；feedback add/ls/verify 只写本队记录，不唤醒模型。
- 身份：改源后 sync-identity 或显式 SpaceBuilder build，不改生成物。自动刷新不执行 Space pre/post 或 Provider post；遇此配置保留上次身份，显式命令返回 SB018，发布 hook 只能显式构建运行。执行制品含 .spacebuilder/output-lock.json；只在唯一定义源改，完整构建后执行端 verify --artifacts-only，实际采用另核。
- 升级：反思沿原维护回执自行合并冲突，保留 Class、业务和历史；snapshot/drift 管差异，reset 仅用户明确要求时使用。旧 tools/team.py 查询自动打开项目的副作用迁移时去掉，不能假设平台更新会覆盖团队定制。扩展合同见 extensions.md。
- 原生查询：用绑定 "$GENEHUB_CLI"；已知会话 session get <id>。当前集合 session list --workspace <id> --active --include-archived 包含归档未完事项；历史 --limit 50，按 nextCursor 至 complete。unboundedQueryDisabled 要改原查询，失败不是空列表，不换号/重建任务/写锁。截断沿 ghref 取全文，不扫描全队历史。
- Timer hook 默认 fixed-delay：本轮执行和收尾后再等 every，运行不重入、不积压、冷却不占名额；失败也等待。interval 只适短幂等调用，时限不超过间隔15%，超时整组结束；不靠加频率掩盖慢查询。更新 hook 源再 build，核实际 hook/内核与回传；进程活着不等于本轮完成。
- 机制 health/report/watchdog 熔断留内部 notes；例行反思静默。真实交付与用户问题沿原路由。旧无 taskId 派单才沿原 spawn/send 回执兼容，不给新工作另造调度器。
