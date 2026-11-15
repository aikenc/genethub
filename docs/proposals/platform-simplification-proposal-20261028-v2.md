# 平台层简化提案 v2（证据收敛版）

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

- 状态：**待评审**
- 日期：2026-10-28
- 槽位：`dev-3`
- 基线：Open `8e9300a4a4950641a65b34517cf0313e700e6d1e`、Cloud `cc0e6f0667a7d4082f352f349054c219e94bdfb5`
- 关系：本文件**取代** v1 `platform-simplification-proposal-20261028.md`；v1 保留为被复查草稿。
- 复查结论：v1 把“值得调查的迹象”写成了“已确认的问题”，并把删除、测试迁移、全平台拆分打包在一起。本版只保留有代码/测试证据的部分，拆成三个独立交付，不设行数/比例配额。

---

## 1. v1 已确认的错误（本版修正）

| v1 说法 | 实际证据 | v2 修正 |
|---|---|---|
| 旧 Rust builder 在每次 Space 打开时都运行 | `verify_space` 只在存在 `agent_spaces` 注册/项目控制关系时调用（`workspace.rs:638/665/727/736/864/868/996/1515`）；普通扫描注册的 Space 没有旧 digest 时跳过 | 先清理 PM/旧注册调用，再审计剩余职责；不默认新建 verifier |
| 按 lock digest 缓存验证结果 | 修改生成的 `AGENTS.md`/Skill/源描述时 lock 可不变；Python verifier 会检查输入与生成文件摘要 | 取消“lock digest 命中即有效”；要缓存就缓存输入+生成文件摘要，或每次校验 |
| Cloud `store.ts` 有 Agent 会话目录，构成三层重复 | `DeviceSessionRow` 是登录/设备认证会话（密钥摘要、信任期限、撤销），不是 Agent 对话会话；未找到 Agent 会话目录模型 | 撤回该论据；真实重复只在 daemon `session/store.rs` ↔ workbench `session/store.ts` |
| 46 个 journeys 有 TS ID，迁移基本完成 | TS ID 只代表映射，不代表断言等价。例：旧 concurrency 覆盖 10/20 workspace、4/8 浏览器观察者；TS `parallel-sessions` 只覆盖 2 workspace/2 session | 按“已覆盖/缺失/已失效”逐条分类，先补缺口，再谈退役 |
| 可以同时保留 Claude/Cursor release-only Rust、OpenCode suspended 源码，并最终删整个 crate | 这会自相矛盾。另有 2 条 required 无 TS 对端：Claude 子任务隔离、旧 harness 延迟统计 | 每条 row 写明最终去向；crate/adapter 只在所有 row 有去向（TS 接管/归档/删除）后才删 |
| 新建通用 parity runner | `rust-legacy` adapter 只返回 passed/failed/exit，不输出统一 reply/event/disk/git/process 证据 | 先复用现有 runner + 逐条断言核对；只有证明必要才加新命令 |
| 按 −20%/−30% 删除能力位/字段/常量；按行数验收；135 SQL 全改批量；diagnostics 四层合一；配置集中 | `serde(default)` ≠ 废弃；`transcribe.v2` 与 `partial.v1` 是不同能力；拆文件不改变状态/依赖；SQL 计数不证明 N+1；诊断层隐私边界不同；配置集中会造新 god module | 取消配额/行数/一刀切；只做逐项证明过的重复、慢查询、泄漏 |
| 全量门禁可降到 90 分钟 | 没有同机器、同预算、同覆盖的对照 | 作为待测目标，先修资源泄漏/隔离，再测 |

---

## 2. 交付 A：退役层删除（证据充分，独立可交付）

### A1 平台 PM 退役（保留团队模板）

**证据**
- `COMPONENT_PM = "pm"`（`agent_space.rs:23`）→ `agent_space_requires_project_control`（`router.rs:437`）→ 项目配置门禁。
- `project_control::Broker` 在 `state.rs` 初始化；`router.rs` 约 30 处引用；`cli_front/space.rs` 的 `project.approval.request`。
- 当前没有现存 Space 显式启用 `pm`；只有 `adopt_legacy_pipe_spaces` 的旧配置迁移。
- 团队样板 `team-template/tools/pm_board_server.py` 是用户空间团队看板（`team.py` 调用），**不是**平台 PM。

**动作**
1. 停止迁移/创建 `COMPONENT_PM`；`agent_space_requires_project_control` 删除。
2. `project.approval.request` 返回 `projectRetired`。
3. 删除 `project_control.rs`、PM 门禁、`agent_space_builder/management.rs` 的审批逻辑。
4. **保留** `team-template`、`team.py`、`pm_board_server.py`、`.pm/` 看板、`genehub-team` Skill。

**验收**：新配置无平台 `pm`；`project_control` 引用为 0；团队看板功能不变。

### A2 旧 Rust SpaceBuilder：先清理调用，再判断剩余职责

**证据**
- `verify_pipe_space` 只在注册的 AgentSpace / 项目控制关系路径调用；不是每次打开任意 workspace。
- 旧 Rust builder 读 `.pipebuilder/lock.json`（`pipebuilder-lock.v1`）；产品 CLI 写 `.spacebuilder/lock.json`（`spacebuilder-lock.v1`）。

**动作**
1. 随 A1 删除 PM/旧注册调用后，重新列出剩余 `verify_space` 调用点。
2. 对剩余调用，判断是否仍需要 builder 语义：
   - 需要：daemon 依赖 Python SpaceBuilder CLI 的 lock 契约；**校验输入与生成文件摘要**，不能只按 lock digest 缓存。
   - 不需要：直接删除调用。
3. 只有确认剩余职责后，才删除 Rust 模块；不默认新建“读 lock + 调 CLI + 缓存”的 verifier。
4. 受管 Space 的 `.pipebuilder → .spacebuilder` 迁移由 Space 工具链负责，本提案不管理；本提案只删除 daemon 侧失去用途的调用。

**验收**：A1 后 `verify_space` 调用点清单；每个点有“保留/删除”理由；daemon 无 agent 名硬编码；不再存在第二套 builder 实现。

### A3 未参与构建的旧 UI
- 删除 `packages/workbench/deprecated/workbench-v4`（2,926 行，`tsconfig` 未 include `src` 之外）。
- 验收：构建/测试不变；grep 无引用。

### A4 兼容壳
- `expert.py → team.py` 等只在确认无模板/团队引用后删除；不打包进 A1/A2。

---

## 3. 交付 B：Rust 测试退出（逐条去向，不打包）

### B1 现状（已核对）

- `testing/migration/rust-parity.json`：93 行；89 `ts-owned`、4 `source-retained`；91 `required`、2 `suspended`。
- 46 个 journeys 全部 `ts-owned`，但 **ts-owned 只代表有 TS 映射**；断言/负载/观察面不一定等价。
- 4 条 `source-retained`：
  - `rust.claude.a_sub_agents_work_stays_inside_the_call_that_dispatched_it`（required，无 TS）
  - `rust.concurrency.latency_summary_counts_only_operations_strictly_over_three_seconds`（required，无 TS）
  - `rust.opencode.*` ×2（suspended，无 TS）

### B2 每条 row 必须有且只有一个最终去向

| 去向 | 含义 | 处理 |
|---|---|---|
| `ts-parity` | TS 对端已存在，且断言/负载/故障覆盖已逐条核对 | 记录证据，标 `retired`，从默认 gate 移除 |
| `ts-port` | TS 对端缺失或覆盖不足 | 先补 TS 测试与断言，再转 `ts-parity` |
| `release-only` | 真实外部 Agent/模型的 canary | 由 TS release-only 用例接管；Rust row 在 TS 可运行后退役 |
| `archive-suspended` | 能力已由 Human 决定下线 | 保留源码与 row 到归档位置（可以移出活动 crate），不参与 gate |
| `delete-with-harness` | 旧 harness 自测（如延迟统计） | 随旧 harness 一起删除 |

**关键约束**：`testing/deprecated/rust/` 和 `rust-legacy` adapter 只有在**所有 row 都有去向**后才删除；不能在还有 required/suspended row 时宣称“整个 crate 删除”。

### B3 退役方法（复用现有工具，不先造新框架）

1. **先补覆盖，再判 parity**：按 suite 列出“已覆盖 / 缺失 / 已失效”，以旧测试的负载、观察者、断言为准。例：concurrency 的 10/20 workspace、4/8 浏览器观察面必须先补 TS 或明确降级理由。
2. **逐条核对断言**：TS case 的实际断言 vs 旧 Rust case 的 `assertionDelta`；不能只因为两边都 pass 就判等价。
3. **复用现有 runner**：
   - TS：`testctl run --case <tsId>`，保存 run dir 与断言输出。
   - Rust：现有 `rust-legacy` adapter 的 pass/fail + 退出状态；必要时保存失败摘录。
   - 记录 `tsRunId`、`rustRunId`、`assertionDelta`、`fault`（适用时）到 `retirement` 证据。
4. **故障覆盖按 suite 决定**，不假设都是网络：
   - install：损坏制品/签名；
   - authorization：撤销/越权；
   - concurrency：取消/竞争；
   - network：`startFaultLink` / `startShapedTcpProxy`。
5. **只有证明现有 runner 不足时**，才新增证据采集；不新建通用 parity 命令/框架。

### B4 退休机制（最小改动）

- `rust-parity.json`：新增 `legacyExecution: "retired"` + `retirement { evidence, tsId, tsRunId, rustRunId, assertionDelta, coverageDelta, reviewedIn }`。
- `governance.ts` / `gates.ts` / `required.specialty.ts` / `parity-batch.specialty.ts` / `rust-oracle-class.specialty.ts`：允许 retired 并校验证据；`required` 默认不变。
- `suspended` 仍按 L13 记录 Human 批准（approvedBy/date/reason/resumeWhen）；`retired` 不需要产品签字，走 PR review。
- 每个 suite 的 row 全部有去向后再删除该 suite 的 Rust 文件。

### B5 验收

- 每条 row 有且只有一个去向，并在 `rust-parity.json` 可查。
- 没有 `ts-owned` 行在没有断言/覆盖核对的情况下被标 `retired`。
- Rust required 行下降只发生在有 `retirement` 证据的行上。
- 最终删除 crate/adapter 前，suspended 行已归档、required 行已 TS 接管或删除。
- 当前业务覆盖不下降；缺失/降级项有清单。

---

## 4. 交付 C：有证据的局部简化（不做大范围）

### C1 Session 模型
- 修正：真实重复是 daemon `session/store.rs` ↔ workbench `session/store.ts`；Cloud `DeviceSessionRow` 是认证会话，不合并。
- 动作：定义一份权威字段/状态契约 + 两侧 contract test；只消除已证明的字段/状态 drift。
- 不打包“三层统一”。

### C2 慢查询
- 只在具体请求路径上测量（查询次数、耗时、事务/授权语义），证明 N+1 后再优化。
- 不按“135 条 SQL / 20 处循环”批量改。

### C3 资源泄漏
- 只处理已观测到的泄漏：Chrome/probe 残留、进程/端口/临时目录。
- 验收：同一路径的泄漏计数下降；有复现和清理证据。

### C4 诊断与配置
- 诊断：只共享真正相同的信封/限制/脱敏工具；保留服务端控制诊断、页面采集、用户主动上传会话内容的边界。Console 的完整会话叙述只在用户选择并确认上传时采集。
- 配置：各域保留自己的配置，只合并重复且语义一致的项；不造统一 policy god module。

---

## 5. 范围与守卫

- **dev-2**：拥有传输/流控/恢复/RTC/列表瘦身、`packages/workbench/src/protocol/client.ts`、`session/store.ts` 的暂停/恢复、`router.rs`/`cli_front/query.rs` 的 WIP。本提案**不安排拆 `client.ts`**；冲突按职责/语义判断，不用“<50 行”判安全。
- **不管理**：16 个 Space 的迁移、旧客户端更新提示、PM Space 迁移提示。这些不出现在 P0/验收/恢复章节。
- **不设兼容窗口**：删除旧路径/旧格式/旧协议；回滚依靠 Git 提交和匹配制品，不在新版本保留旧实现/开关。
- **不设产品签字**：`retired` 走证据 + PR review；只有 `suspended` 按 L13 记录 Human 批准。
- **审计缺口（明确未完成）**：
  - Agent 子进程退出/取消
  - 权限与凭证边界
  - 会话持久化
  - 文件/终端资源生命周期
  - 内置模板分发
  这些只作为后续审计项，不以行数盘点代替。

---

## 6. 验收口径

从“删够多少行”改为：

1. **旧机制彻底消失**：平台 PM、旧 Rust builder 的失效调用、未构建旧 UI、已退役的 Rust row。
2. **当前业务完整保留**：每条 Rust row 有去向；TS 覆盖缺口有清单；真实 Agent canary 有承接。
3. **可测量**：列表延迟、控制 p95、查询次数、泄漏计数；没有测量就不宣称改善。
4. **可回滚**：Git 提交 + 匹配制品；不依赖新版本内的旧实现。

---

## 7. 未决问题（技术项）

1. A1 后剩余的 `verify_space` 调用点清单：哪些仍需 builder 语义？
2. 4 条 `source-retained` 的最终去向（Claude 子任务隔离、旧 harness 延迟统计、OpenCode ×2）。
3. concurrency 等 suite 的覆盖缺口补法：补 TS 负载/观察者，还是明确降级并记录？
4. 真实 Agent canary 的 TS 承接方式（production client 能驱动到什么程度）。
5. 审计缺口五项的责任人和时间。

---

## 附录：concurrency 覆盖差距（示例）

- 旧 Rust `concurrency.rs` profiles：10 workspace/1 analysis/4 browsers；20/2/8；20/3/8；20/3/0；20/3/8。
- TS `specialty.concurrency.parallel-sessions`：2 workspace、2 session、无浏览器观察者、无延迟统计。
- 结论：该 row 不能仅凭“ts-owned + 两边 pass”判 parity；需补负载/观察面或记录降级。
