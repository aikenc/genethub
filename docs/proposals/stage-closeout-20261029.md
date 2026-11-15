# dev-3 阶段性收尾（2026-10-29）

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

- 阶段目标：**退役层删除 + 已验证的局部简化 + 完整 Agent 权限合同对齐**。不宣称“全部审计整改完成”，也不作为发布验收。
- Open：`9e511f34`；Cloud：`023c7d1`
- 双仓工作树：收尾提交后干净
- 回滚点：本阶段每个提交都可单独 `git revert`；没有数据迁移，没有兼容开关

## 1. 本阶段交付

### 退役层删除
- 平台 PM：`project_control`、`COMPONENT_PM`、`project.approval.request`、PM 审批/绑定、前端 PM 选项。
- 旧 Rust SpaceBuilder：模块、9 个 `verify_space` 调用、`agentSpace.builder` RPC、`space builder` CLI、
  proto/bindings、workbench 控件、`builderPlans` 能力位、`builderLockDigest`/`pipeSpace.pm`。
- 废弃 UI：`packages/workbench/deprecated/workbench-v4`。
- Rust parity：84 `retired`、6 `release-only`、2 `suspended`；2 条 concurrency 行移入 `openGaps`，
  **不计入接管**。

### 局部简化 / 可靠性
- Session 删除死字段 `workSummary`，快照使用服务端 `interactionSummary`。
- `list_meta` 单次读取/解析；`live()` 不再持写锁做磁盘 IO；`scan_spaces` in-flight 守卫（RAII 复位）。
- PTY reader 非阻塞、close 后可退出；`Group::end` 有界；delete 顺序、stop_pump abort、shutdown 30s 总预算。
- 内置 Agent pid 暴露；shutdown 一次 census 只清 detached 后代，同组工具交给 Agent close。
- blob append fsync（实测约 0.57ms/次）；open trunk 30s 检查点，trunk index 按 index upsert。
- Files/Asset Preview 不能解析 `.genethub/sessions`；Fabric URL 与 client-debug URL 脱敏；
  损坏 `devices.json` 先备份、不可读时拒绝覆盖；启动恢复逐会话隔离。
- 测试浏览器始终组级 TERM→KILL 并释放租约；租约回收覆盖所有带标记前缀。

### 权限合同
- 按 Human 决策恢复“完整 Agent 连接 = 目标 OS 用户能力”，撤销本轮新增的跨项目拒绝。
- 保留真实 Session/设备/来源身份；保留 admission 过期、撤销、分享范围、OS 权限边界。
- 文档见 `docs/security-model.md#full-agent-authority` 与内置 `genehub` Skill。

## 2. 验证

| 检查 | 结果 |
|---|---|
| `cargo check --workspace` | 通过 |
| `cargo test --workspace --exclude genehub-testing --exclude genehub-host`（清 CLI 会话环境） | 通过，除 1 个在 `main` 同样失败的 `a_machine_that_answers_with_a_different_identity_is_refused` |
| `cargo test -p genet-daemon --lib` | 657/657 |
| workbench typecheck + vitest | 857/857 |
| `testctl governance check` | 6 项 ok；P01 备注 “2 legacy rows are open coverage gaps, not retired” |
| `testctl plan --gate change` | 通过 |
| `testctl run --gate merge` | **尝试过，未执行任何用例**：run `261029-2043-full-merge-86ef`，760 条全部 preflight blocked。原因：容器不允许 `unshare`（`GENEHUB_TEST_UNSHARE`）、无 `GENEHUB_NETWORK_REMOTE_*` 目标机、无带 aiohttp 的 Python 3.11（`GENEHUB_PREVIEW_MEDIA_PYTHON`）。2 条 openGap 出现在 `skipped`/`notExecuted` |
| 定向实跑 | `daemon-stops-active-sessions`、`pty-echo`、`deleted-session-stays-gone`、`cancel-restart`、`interrupted-session-recovers`、`round-ledger-on-disk`、`journey.expert.collaboration` 均通过 |

## 2.1 合入复查后的修正（2026-10-29）

- **trunk index 读失败**：读不到索引时返回错误，不再当作空索引覆盖历史；仅 `NotFound` 视为空。
- **PTY 非阻塞影响写端**：改为对 reader fd 做 `poll`，不设置 `O_NONBLOCK`；close 后先 drain 内核缓冲再退出，最后一段输出不丢。
- **shutdown 总预算**：每个 `live.shutdown()` 也包在 deadline 内，不再只检查会话之间。
- **openGap 可见性**：`plan`/`run` 的 `skipped` 与 `notExecuted` 显式列出 2 条未退役行，不再从执行与跳过清单同时消失。
- **shutdown 后置回收**：被 deadline 放弃的会话，其已 watch 的 Agent group 会被直接关闭；不再只依赖 `kill_on_drop` 的 leader。
- **跨平台组杀**：WASM guest 在 Windows host 用 `taskkill.exe /T /F /PID`，Unix host 用 `kill -KILL -pgid`；失败返回错误并记录，不再吞掉。
- **关闭预算**：30s 会话 drain + 5s 强制组杀上限；组杀前用一次 census 复核 group 仍存在。
- **非 Unix PTY**：不再在 close 标志处提前退出，改为读到 EOF，ConPTY 管道尾部不会丢。
- **并发覆盖**：10/20 workspace specialty 增加 4/8 个 observer client，以及负载下的 `file.tree` canary；干净 run `261029-2042-change-6ccf` 通过。blocking canary 关联已有的 `slow-model-unrelated-reads` 与 `slow-git-unrelated-reads`（干净 run `261029-2102-change-68aa`）。
- 验证：`pty-echo`、`daemon-stops-active-sessions`、`round-ledger-on-disk`、`interrupted-agent-session-recovers` 全部通过（`runs/261029-1942-change-75f4`、`runs/261029-2041-change-4b93`）。

## 3. 明确未覆盖 / 未完成

1. **完整 merge gate 未取得资格**：已实际启动，但容器缺少 `unshare` 能力、远端测试机和带 aiohttp 的 Python，760 条在 preflight 全部 blocked，没有任何用例执行。需要在具备这些条件的 CI/机器上重跑；当前是“可合入候选”，不是 merge gate 已通过。
2. **2 条 concurrency openGap**：旧 Rust run `261028-2205` `inputDrift=true` 未获资格，runner/源码/旧 artifact
   均不存在，无法补同 run 证据。TS 已覆盖 10/20 workspace、4/8 observer client、`workspace.list`/`file.tree`
   响应；未复现的只剩 native resource count、真实 4/8 浏览器 fleet 与 poll timing（测量项）。仍不计为接管。
3. **Claude release-only**：真实账号 403，6 条按记录保留。
4. **未迁移的兼容壳**：`expert.py` 仍服务既有团队钩子；删除前需迁移钩子。
5. **未做的可靠性增强**：损坏 `meta.json` 自动恢复、Agent 退出仅靠 stdout EOF、模板覆盖前备份。
6. **权限合同其余迁移**：设备 grants、旧 managed 特例、按请求类型的 Human 检查仍按当前实现运行；
   完整 Agent 连接的成功路径与这些历史拒绝路径尚未逐项对齐，需后续任务按合同迁移测试。
7. **controller token** 仍绑定 session 而非 Agent 进程实例；未加固定过期（避免长会话失效）。

## 4. 合入口径

- 分支：`dev-3`；两仓均需 MR，人工验收后线性合入 `main`。
- 合并前建议：在 MR 上跑完整 `merge` gate；若接受当前定向证据，需在 MR 描述里引用本文件的失败项与未覆盖项。
- 回滚：按提交 revert；不存在新旧格式并在的兼容窗口。
