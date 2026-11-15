> 已被[完整简化重构提案](agent-authority-simplification-proposal-20261029.md)取代。本文保留前轮分析历史；其中“设备 grants 整体保留”、managed 仅作展示及工期估计不再作为实施依据。

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

# 下一步简化可行性分析（2026-10-29）

- 基线：Open `9e511f34`（已合入 main）、Cloud `023c7d1`
- 合同：`docs/security-model.md#full-agent-authority`——经认证、可驱动完整 Agent 的连接，等价目标 OS 用户能力；保留认证、撤销、过期、OS 权限与仅展示分享边界。
- 原则：先删没有当前消费者的授权分支，不新增角色/ACL；可靠性机制单独论证，不混进权限简化。

## 1. 候选清单与可行性

| # | 内容 | 位置 | 工作量 | 风险 | 结论 |
|---|---|---|---|---|---|
| A | 删除 `SessionController { ordinary }` 能力分级：所有已认证 SessionController 走全能力；`ordinary` 只保留为展示/来源字段或直接删除 | `authz.rs:194,242-252`；`transport/local.rs:301-307` | 0.5–1 天 | 中低：legacy Workflow managed 会话获得全能力，符合合同；需迁移拒绝测试 | **建议先做** |
| B | 删除 Workflow managed 授权特例：`authorize_session_request` 的 parent/readOnly 分支、`authorize_project_mutation` 的 wm/recovery-manager 分支、`authorize_agent_space_change` 的 managed 拒绝 | `router.rs:383-405`、`405-437`、`470-500`；`cli_front/project.rs:13` | 1–2 天 | 中：旧受管会话的只读/父约束消失；Workflow 已退役，无新数据 | **建议做，需迁移测试** |
| C | 删除普通连接的项目边界拒绝：`authorize_project_mutation` 的 `summary.workspace_id != workspace_id`、`authorize_agent_space_change` 的项目相等检查 | `router.rs:425-430`、`493-500` | 0.5 天 | 中低：保留 Session 存在/结构校验，去掉跨项目降权 | **建议做** |
| D | 删除 `PipeSpaceInfo` 兼容投影与 `LegacyPipeSpaceEntry` 迁移（pm/digest 已删，只剩 parent/workerRole/lifecycle） | `packages/proto/src/domain.rs`、`config.rs:300-395`、`agent_space.rs:360-372` | 0.5 天 | 低：无兼容窗口；旧配置的 workerRole 迁移可保留一版后再删 | **建议做** |
| E | 删除 Workflow proto/RPC/CLI 残留：`workflow.*` 请求、`Workflow*` 类型、`session.flow`、旧 run 状态 | `packages/proto/src/{rpc,domain}.rs`、`router.rs` 拒绝分支、`cli_front` | 3–5 天 | 高：跨 proto/CLI/workbench/testing，旧客户端会得到协议错误；需完整门禁 | **独立任务，先审计消费者** |
| F | 删除 `managed` 会话字段与旧来源分类 | `session/store.rs:305,430,476`、`cli_front`/workbench 显示 | 2–4 天 | 高：旧会话历史显示与 routing/sourceKind 受影响，需要数据迁移策略 | **不急，先保留只读展示** |
| G | 设备 grants 分级 | `authz.rs:120-180`、`devices.rs`、`router.rs:2390` | 不删 | 高：这是“谁能连接/能做什么”的真实边界，也是分享与窄权限邀请的基础 | **保留** |
| H | Files/PTY 打开任意 OS 路径 | `file_access.rs`、`files.rs` | 3–5 天 | 高：会把 RPC 变成文件系统浏览器，超出合同“目录映射/路径规范化保留”的边界 | **不建议** |
| I | admission 过期/撤销、分享范围 | `logical_registry.rs`、`preview_feedback.rs` | 不删 | — | **保留** |

## 2. 推荐顺序

1. **A + C**：去掉控制器内部分级和跨项目降权，改动集中、可单独回滚；用现有 `agent-session-control-parity`、团队 journey、越权拒绝测试迁移验证。
2. **B**：删除 managed 授权特例；先让 legacy managed 会话按普通 Session 处理，保留字段只作展示。
3. **D**：删除 `PipeSpaceInfo`/legacy 迁移；确认没有旧客户端读取 `pipeSpace`。
4. **E/F**：Workflow proto 删除与 `managed` 字段删除是大工程，另开任务，先列消费者和旧数据影响。
5. **G/H/I 不动**：属于真实边界或会扩大 RPC 面。

## 3. 验收口径

- A/B/C：同一已认证 SessionController 对同机其他项目执行 `session.send`、`workspace.*`、`agentSpace.configure` 成功；未认证、撤销、过期、分享身份仍拒绝；团队协作 journey 通过。
- D：旧配置仍能加载（workerRole 迁移一版），新写不再输出 `pipeSpace`；无客户端读取。
- 不以“测试不再报错”作为完成；每个删除项要有成功路径和真实外部拒绝路径。

## 4. 当前状态与限制

- `9e511f34` 已合入 main；CI run `40884536903` 仍在进行。
- 完整 merge gate 仍受容器 `unshare`/远端机/aiohttp 限制，未取得资格。
- 2 条 concurrency openGap 保留：业务 oracle 已由 TS 覆盖，缺同 run Rust 证据。
