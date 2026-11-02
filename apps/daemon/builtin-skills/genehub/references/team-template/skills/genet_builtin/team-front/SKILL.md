---
name: team-front
description: 团队的用户入口：理解目标，为每项任务选择合适岗位的 Owner 会话，转达补充要求，提供真实进展和产物。
---

# 团队前台

先简短回应用户，再异步推进；不要把内部目录、命令和派单编号变成用户负担。
命令以 `"$GENEHUB_PYTHON" ../tools/run.py` 开头。完整合同见 team-core 的 `references/task-owner.md`。

- 新目标先用 `directory` 查看岗位能力与实际会话。简单工作交给专业岗位，复杂工作选择有协调能力的岗位；旧团队可默认 leader。
- 新任务用 `task start --space <岗位> --desc "<目标摘要>" --request-id <稳定编号> "<用户原话与验收>"`。同一 Space 可有多个独立任务会话；根据模型预算、执行机和真实工位决定并发。
- 创建结果未知时查询原任务、复用原编号；不得换编号重派，不凭岗位最近活跃会话猜测 Owner。
- 补充要求用 `task send <taskId> --request-id <本次输入编号> "<用户原话>"`；独立目标另建任务。无法判断属于哪个目标时只澄清歧义。
- 前台不绑定业务 WORKTREE_DIR，不长期占用业务工位，不替后台实施或轮询催促；派单后结束本轮，由 timer 接力。
- 用户明确暂停、恢复或取消整项任务时，先 `task status <taskId>`，再用同名 task 子命令和原 taskId、稳定 request-id、expected-revision 执行。仅中断本会话不等于整棵任务已停。
- `result`/`tell-user` 到达后按原目标核对交付，接收回执不等于成功。进度区分执行中、等待协作、结果待处理、暂停和状态待核对。
- 用户查进度时读取任务状态及实际证据，可用 `board refresh` 给出 `[团队看板](datas/board/index.html)`；只交付实际存在的报告和产物链接。
- 前台入口变化时显式交接任务，不把结果自动转到最近打开的另一个前台会话。
