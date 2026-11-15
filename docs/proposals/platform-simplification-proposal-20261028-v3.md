# 平台层简化提案 v3（可执行收敛版）

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

> **2026-10-29 产品权限决策更新**：已认证且获准驱动完整 Agent 的连接，等价目标 OS 用户的完整能力。
> 本文中的旧 PM/受管特例、跨项目拒绝等权限建议不得反向扩建成产品需求；按
> [dev-3 实施建议](agent-authority-simplification-handoff-20261029.md) 与产品 `docs/security-model.md` 对齐。
> 当前代码未因本轮文档更新自动迁移；认证、撤销/过期、OS 权限和仅展示分享边界保留。

- 状态：**待评审**
- 日期：2026-10-28
- 槽位：`dev-3`
- 基线：Open `8e9300a4a4950641a65b34517cf0313e700e6d1e`、Cloud `cc0e6f0667a7d4082f352f349054c219e94bdfb5`
- 关系：本文件取代 v2（`platform-simplification-proposal-20261028-v2.md`）与 v1；两者保留为复查草稿。
- 目标不变：**平台 PM、旧 Workflow 残留彻底删除；旧 Rust builder 退出；Rust 业务测试全部由 TS 接管后删除；废弃 UI/兼容壳清除；团队机制、模板、Speech、CLI front 保留。**

本版只修正“删除是否真的完成”的工程条件，不缩小目标。

**实施进度（2026-10-28）**

| 交付 | 状态 |
|---|---|
| A1 平台 PM 退役 | **已落地**：删除 `project_control`、`COMPONENT_PM`、`project.approval.request`、PM 门禁与审批；前端 Component 选择中的 PM 选项也已移除；保留通用 authz/团队操作；daemon 单测通过 |
| A2 旧 Rust builder | **已落地**：删除 `apps/daemon/src/agent_space_builder/`、9 个 `verify_space` 调用点、`agentSpace.builder` RPC、`space builder` CLI、proto 类型、workbench 调用与能力位；`registration_at` 一并移除；`builderLockDigest`/`pipeSpace.pm` 遗留字段从 config、proto、plan digest 与测试夹具中删除；Python SpaceBuilder 为唯一构建器；开发 Space 未触碰。验证：`cargo check --workspace`、daemon 单测 661/661、workbench 851/851、`governance check`、component-instances / composition-boundary 两个专项通过 |
| A3 未构建旧 UI | **已落地**：删除 `packages/workbench/deprecated/workbench-v4`（6 文件 / 2,926 行）。`expert.py` 兼容壳保留：既有团队钩子与 2 个 journey 仍引用，删除会破坏已建团队的升级；按提案“确认无引用后再删”的条件未满足 |
| B Rust 测试退出 | **主体完成，验收未闭合**：92 行进入终态（84 retired、6 release-only、2 suspended），另有 2 条 concurrency 行移入 `openGaps`，不计入接管；`rust-legacy` runner/specialty 移除，源码归档。但 2 条 concurrency 行引用的 run `261028-2205` 记录 `inputDrift=true`、资格为 false，已从 `cases` 移入 `openGaps`；TS 10/20 workspace 覆盖已补（`specialty.concurrency.parallel-workspaces`，干净 run `261029-1532-change-41d3`），Rust 同 run 证据无法补齐；Claude 子任务隔离仍无 TS 对端（403 阻塞）。这两条已标记 `evidenceStatus: invalid`，B 不能按“全部接管完成”验收 |
| C 局部简化 | **已落地（2026-10-29）**：删除死字段 `workSummary` 及其 UI 分支；快照改用服务端 `interactionSummary`；`list_meta` 单次读取/解析；`live()` 不再持写锁做磁盘 IO；`scan_spaces` in-flight+结束后节流；测试浏览器进程组与租约回收；Fabric URL 与 client-debug URL 脱敏；删除无生产者的 `workflowPatrol*`。详见 `platform-audit-findings-20261029.md` |

---

## 1. 本版修正的 7 项

| # | v2 问题 | v3 修正 |
|---|---|---|
| 1 | “所有 row 有去向”被当成可删除条件，`ts-port` 只是计划 | 统一删除条件：TS 覆盖已补齐并验证、退役证据有效、暂停项已归档，才允许删 suite/crate |
| 2 | 退役证据缺输入身份 | `retirement` 必须绑定同一 open/cloud SHA、artifact hash、匹配的测试输入；从 run manifest 核对 |
| 3 | 退出类型没有可执行治理规则 | 分开定义 `ts-parity` / `delete-with-harness` / `archive-suspended` 的字段与校验 |
| 4 | C1 仍假设“两侧 store = 重复” | 改为列出具体重复定义/状态漂移；优先使用现有 proto `SessionSummary` |
| 5 | PM 删除验收太弱 | 明确删哪些 PM 分支、保留哪些通用权限检查，并验证团队操作/越权拒绝/Agent 权限 |
| 6 | A2 等实施后才分析 verifier 调用 | 现在就对 8 个调用点标注“随 PM 删除/团队需要/无消费者” |
| 7 | 只是专项方案，不是全面审计 | 五项平台审计列为并行 backlog，不阻塞 A/B，也不冒充已完成 |

**实施前补齐（第三轮复查）**：9 个 builder 调用点（workspace 8 + `router.rs:244`）、`session_may_manage_project` 的 PM/权限拆分、B6 工具接线清单、`delete-with-harness` 同提交删除顺序。

---

## 2. 交付 A：退役层删除

### A1 平台 PM 退役（保留团队机制）

**删除的 PM 专属分支**
- `project_control::Broker`（`state.rs` 初始化与字段）
- `agent_space_requires_project_control`
- `rebind_project_control_if_pm` / `move_binding_off_archived_session`
- `session_may_manage_project` 中的 **PM binding 检查**（`project_control.has_binding`）；函数其余判断不能整段删除，见下方“从 `session_may_manage_project` 拆出的保留判断”
- `project_control.revoke_session` / `mutation_lock` / `issue_management` / `completed_action` / `binding_snapshot` / `remove_binding` / `revoke_workspace`
- `cli_front/space.rs` 的 `RequestApproval` / `project.approval.request`
- `COMPONENT_PM` 的创建与 `adopt_legacy_pipe_spaces` 迁移
- `agent_space_builder/management.rs` 的审批逻辑

**必须保留的通用检查**
- `crate::authz::required` 与 `Principal` 校验（`LocalUser` / `SessionController` / `PreviewShare`）
- workspace 归属、越权修改拒绝、Agent 权限请求（`agent.requests`）
- 团队机制：`genehub-team` Skill、`team-template`、`team.py`、`pm_board_server.py`、`.pm/` 看板

**从 `session_may_manage_project` 拆出的保留判断**
- 调用会话存在（`sessions.summary(session_id)`）
- 受管 Worker/子会话不能改组项目（`summary.managed.is_some()`）
- 会话属于目标项目（`workspaces.project_root(summary.workspace_id) == project_id`）

删除 PM binding 后，`authorize_agent_space_change` 的允许条件改为“会话属于目标 Space/项目且不是受管子会话”，不再接受“有项目控制绑定”的路径。验收：正常团队操作通过；跨 workspace 未授权修改仍被拒绝；受管 Worker 不能改组。

**验收（业务级）**
1. 正常团队会话：创建/发送/中断/查看/归档可工作。
2. 跨 workspace 的未授权修改仍被拒绝（不是“引用为 0”）。
3. 通用 Agent 权限请求仍正常（允许与拒绝两条路径）。
4. 团队看板与 `team.py` 功能不变。
5. `project.approval.request` 返回 `projectRetired`。

### A2 旧 Rust SpaceBuilder：先完成调用点依赖分析

**现在就对 8 个 `verify_space` 调用点标注**（`workspace.rs:638/665/727/736/864/868/996/1515`）：

| 调用点 | 当前用途 | 标注 |
|---|---|---|
| L638 | 项目 DCG 入口校验 | 随 PM/旧注册清理评估 |
| L665 | 注册漂移检查 | 团队当前是否需要？ |
| L727/L736 | SetParent 关系校验 | 随 PM/旧注册清理评估 |
| L864/L868 | Executor/Worker 组件关系校验 | 团队当前是否需要？ |
| L996 | Worker 关系校验 | 团队当前是否需要？ |
| L1515 | builderLockDrift 诊断 | 无消费者则删除 |
| `router.rs:244` | prepared Space open 校验 | 随旧 builder 评估；若保留，走 CLI 契约 |

**规则**
- 标注“随 PM 删除”的，随 A1 删除。
- 标注“团队当前需要”的，保留最小校验：依赖 Python SpaceBuilder CLI 的 lock 契约，**校验输入与生成文件摘要**；不能只按 lock digest 缓存。
- 标注“无消费者”的，直接删除。
- 只有清单完成后，才删除 Rust builder；不默认新建 verifier。
- 受管 Space 的 `.pipebuilder → .spacebuilder` 迁移由 Space 工具链负责，不在本提案。

**旧 AgentSpaceBuilder 其他表面**
- proto：`AgentSpaceBuilderOperation` / `AgentSpaceBuilderPlan` / `AgentSpaceBuilderReport` / `AgentSpaceBuilderDiagnostic`
- CLI：`space init|check|explain|build|verify|clean`（`cli_front/space.rs`）
- RPC：`Request::AgentSpaceBuilder`（`router.rs:2912`）
- 能力位：`agentSpace.builderPlans.v1`（`router.rs:918`）

去向：构建职责交给 Python SpaceBuilder CLI；daemon 只保留当前业务需要的 open/verify 入口；上述 RPC/CLI/types 若确认无消费者，随旧 builder 删除；若 CLI 仍需要报告形状，保留最小类型并改为调用 CLI。

**验收**：9 个调用点（workspace 8 + router 1）都有标注和去向；旧 AgentSpaceBuilder 的 RPC/CLI/types 有去向；删除后 daemon 无 agent 名硬编码；没有第二套 builder。

### A3 废弃 UI / 兼容壳
- 删除 `packages/workbench/deprecated/workbench-v4`（未参与构建）。
- `expert.py` 等仅在确认无模板/团队引用后删除。

---

## 3. 交付 B：Rust 测试退出

### B1 现状

- 93 行：89 `ts-owned`、4 `source-retained`；91 `required`、2 `suspended`。
- 46 journeys 有 TS 映射，但 `ts-owned` **不代表断言/负载/观察面等价**。
- 4 条 source-retained：
  - Claude 子任务隔离（required）
  - 旧 harness 延迟统计（required）
  - OpenCode ×2（suspended）
- 示例覆盖差距：旧 concurrency 覆盖 10/20 workspace、4/8 浏览器观察者；TS `parallel-sessions` 只有 2 workspace/2 session。

### B2 五种退出类型（每种有独立治理规则）

| 类型 | 适用 | 必填证据 | 何时可删 Rust |
|---|---|---|---|
| `ts-parity` | TS 对端已存在且覆盖等价 | tsId、tsRunId、rustRunId、openSha、cloudSha、artifactSha、tsInputs、rustInputs、assertionDelta、coverageDelta | 覆盖验证通过 + 证据匹配 |
| `ts-port` | TS 对端缺失/覆盖不足 | 缺口清单、补测计划 | **先补 TS 并验证，再转 `ts-parity`；未完成不得删** |
| `release-only` | 真实外部 Agent/模型 canary | TS release-only case + 运行证据 | TS 能稳定运行后退役 Rust row |
| `archive-suspended` | 能力已由 Human 决定下线 | L13 批准人/日期/原因/恢复条件、归档位置、未执行记录 | 源码归档后可删活动 crate；归档位置保留 |
| `delete-with-harness` | 旧 harness 自测 | 依赖对象已删除的证明、删除理由 | 与依赖对象**同一提交**删除；无需等待其他 suite；无 tsId |

### B3 退役方法（复用现有工具）

1. 先按 suite 列“已覆盖 / 缺失 / 已失效”，以旧测试的负载、观察者、断言为准。
2. 逐条核对 TS 断言 vs 旧 Rust `assertionDelta`；两边 pass 不等于等价。
3. 复用现有 runner：
   - TS：`testctl run --case <tsId>`，保存 run dir/manifest。
   - Rust：现有 `rust-legacy` adapter 的 pass/fail + 退出状态。
   - 从 manifest 核对 `open.sha`、`cloud.sha`、`artifact.hash`、测试输入是否一致；不一致不接受退役。
4. 故障按 suite：install 坏制品/签名；auth 撤销/越权；concurrency 取消/竞争；network `startFaultLink`/`startShapedTcpProxy`。
5. 只有证明现有 runner 不足时，才新增证据采集；不先造通用 parity 框架。

### B4 删除条件（统一）

**“有去向”只是计划完成，不是删除条件。** 只有同时满足才允许删除对应 suite：

1. 该 suite 的所有 row 已经处于：
   - `ts-parity` 且覆盖验证通过 + 证据匹配；或
   - `release-only` 且 TS release-only case 已稳定运行；或
   - `archive-suspended` 且源码已归档、记录完整；或
   - `delete-with-harness` 且依赖对象已删除。
2. `governance check` 通过。
3. 默认 gate 不再包含该 suite 的 required row。

**crate/adapter 删除**：只有所有 suite 都满足上述条件后才删除 `testing/deprecated/rust/` 和 `rust-legacy` adapter。

### B5 治理字段

- `retirement`：`type, tsId?, tsRunId?, rustRunId?, openSha, cloudSha, artifactSha, tsInputs, rustInputs, assertionDelta?, coverageDelta?, fault?, archivedAt?, deletedDependency?, reviewedIn`。
- `archive-suspended`：沿用 L13 `suspension { approvedBy, approvedAt, reason, resumeWhen }` + `archive { path, record }`；`required.specialty.ts` / `parity-batch` 在归档后不再要求原测试文件存在。
- `delete-with-harness`：允许无 `tsId`，但必须有 `deletedDependency` 和理由。

### B6 工具接线清单（不新增 runner）

| 退出类型 | `legacyExecution` | 注册器 | gate | 治理检查 |
|---|---|---|---|---|
| `ts-parity` | `retired` | `required.specialty.ts` 不再注册该 row | `gates.ts` 排除 `legacy-retired` | `governance.ts` 校验 retirement 证据；`parity-batch` 允许 retired |
| `ts-port` | 保持 `required` | 继续注册 | 继续执行 | 直到 TS 覆盖完成 |
| `release-only` | `retired`（TS release-only 接管） | 不再注册 Rust row | Rust 不执行；TS release-only 用例进入 beta/stable | 证据含 release-only run |
| `archive-suspended` | `suspended` | 不再注册（或列入未执行清单） | 列入未执行 | `suspension` + `archive` 记录；`required.specialty.ts` / `parity-batch` 在归档后不要求原文件存在 |
| `delete-with-harness` | `retired`（无 tsId） | 不再注册 | 排除 | `deletedDependency` + 理由 |

**验收**：同一变更里同时证明 **旧 Rust case 已退出** 和 **对应 TS case 已进入应有 gate**；不新增 runner。

**`delete-with-harness` 的顺序**：旧延迟统计实现（`concurrency.rs` 内的 `LatencySummary`）、其自测和 `concurrency.rs` 在同一提交中删除；不要要求“先删依赖对象、再删 suite”，否则会循环等待。删除后检查无剩余依赖。

---

## 4. 交付 C：有证据的局部简化（调查项）

### C1 Session 模型
- **不再假设“两侧 store = 重复”**：daemon store 负责持久化，workbench store 负责页面状态；两侧都已使用 `genehub_proto` / `@genehub/proto` 的 `SessionSummary`。
- 动作：列出具体的重复定义、状态漂移或双重解析；优先修正现有契约的使用。没有发现就不改。
- 不新增“权威契约”，除非证明现有 proto 不够。

### C2 慢查询
- 只在具体请求路径测量查询次数/耗时/事务与授权语义；证明 N+1 再优化。不按 SQL/循环总数批量改。

### C3 资源泄漏
- 只处理已观测泄漏：Chrome/probe 残留、进程/端口/临时目录；有复现和清理证据。

### C4 诊断与配置
- 诊断：只共享相同的信封/限制/脱敏工具；保留服务端控制诊断、页面采集、用户确认上传会话内容（Console 完整会话叙述需用户选择并确认）的边界。
- 配置：各域保留自己的配置，只合并重复且语义一致的项。

---

## 5. 范围与守卫

- **dev-2**：拥有传输/流控/恢复/RTC/列表瘦身、`packages/workbench/src/protocol/client.ts`、`session/store.ts` 的暂停/恢复、`router.rs`/`cli_front/query.rs` 的 WIP。本提案不安排拆 `client.ts`；冲突按职责/语义判断，尤其 `router.rs` 要细化到函数级。
- **不管理**：16 个 Space 迁移、旧客户端更新提示、PM Space 迁移提示。
- **不设兼容窗口**：删除旧路径/旧格式/旧协议；回滚依靠 Git 提交和匹配制品，不在新版本保留旧实现/开关。
- **不设产品签字**：`retired` 走证据 + PR review；`suspended` 按 L13 记录 Human 批准。

---

## 6. 平台审计 backlog（并行，不阻塞 A/B）

以下五项是你最初要求全面检查的平台核心；本版**不宣称已完成审计**：

| 领域 | 当前状态 | 下一步 |
|---|---|---|
| Agent 子进程退出/取消 | **已审计（2026-10-29）**，13 项发现 | 独立任务：pid 暴露、重启核对、组杀策略、PTY join、end 超时 |
| 权限与凭证边界 | **已审计**，8 项发现 | 独立任务：models.json 越界、LocalUser 伪造、邀请全权限、Permission 自批 |
| 会话持久化 | **已审计**，7 项发现 | 独立任务：工具调用检查点、trunk/blob fsync、启动恢复隔离 |
| 文件/终端资源生命周期 | **已审计**，与进程审计重叠 | 并入进程/终端任务 |
| 内置模板分发 | **已审计**，5 项发现 | 独立任务：原子覆盖、失败隔离、用户编辑保留 |

发现清单见 `docs/platform-audit-findings-20261029.md`；本次不实施，避免把高风险改动混入简化交付。

这些审计的发现另行建任务；不把新发现全部塞进本实施任务。

---

## 7. 验收口径

1. **旧机制彻底消失**：平台 PM、旧 builder 的失效调用、未构建旧 UI、已退役 Rust row。
2. **业务完整保留**：团队操作/越权拒绝/Agent 权限通过；Rust row 每条有可执行去向；TS 覆盖缺口有清单。
3. **证据可追溯**：退役证据绑定同一 SHA/artifact/输入；归档有记录。
4. **可测量**：列表延迟、控制 p95、查询次数、泄漏计数；没有测量不宣称改善。
5. **可回滚**：Git + 匹配制品；不依赖新版本内旧实现。
