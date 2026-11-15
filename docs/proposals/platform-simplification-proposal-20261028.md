# 平台层简化提案（汇总）

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

- 状态：**待评审**
- 日期：2026-10-28（修订 3）
- 槽位：`dev-3`
- 基线：Open `8e9300a4a4950641a65b34517cf0313e700e6d1e`、Cloud `cc0e6f0667a7d4082f352f349054c219e94bdfb5`（主干）
- 槽位状态：`dev-3` 当前 Open `37798d85` / Cloud `4a6d5a52`，落后主干 45 个提交、双仓干净、无本地未提交；提案只落盘文档，实施前先把该槽同步到主干。
- 与 dev-2 的关系：dev-2 正在做传输层减法（network-transport-refactor-proposal（工作区资料：`spaces/dev-2/docs/network-transport-refactor-proposal-20261028.md`，未纳入本仓））。本提案**不重复** dev-2 的传输/流控/恢复/RTC/列表瘦身方案；少量文件冲突允许，大规模冲突避免，边界与阈值见 §8。
- 事实口径：行数、文件数和提交数取自主干 `8e9300a4`/`cc0e6f0` 附近的只读统计；grep 计数是量级证据，实施前需在 P0 重新精确测量。

---

## 0. 本轮用户决策（修订依据）

| # | 决策 | 对提案的影响 |
|---|---|---|
| 1 | daemon 应依赖 SpaceBuilder CLI 约定 | P0.1 改成“CLI 单一实现 + daemon 消费 lock 契约”；Space 迁移由 Space 工具链处理，本提案不管理（§5.2） |
| 2 | **本次重构不考虑兼容窗口，优先简洁** | 删除旧路径/旧格式/旧协议；旧客户端更新由发布侧处理，本提案不管理（§5.1） |
| 3 | Speech、CLI front 保留；CLI front 给 Agent 用 | 只做内部拆分/去重，不删除（§5.4） |
| 4 | 需要解释多 lane | 保留已上线的 lane 0/1；dev-2 落地后再评估 >1（§5.1） |
| 5 | project_control 是否依赖要分析；Workflow PM 确定退役；**团队机制和内置模板需要保留；PM Space 不需要** | 直接退役平台 PM；保留团队样板（含 PM board）（§5.3） |
| 6 | legacy 用例是否都要清理 | 逐文件分类；46 个 journeys 已由本提案完成分类（§5.5、附录 A） |
| 7 | dev-2 少量冲突可接受，避免大规模冲突 | 放宽冲突矩阵，定义“小/大冲突”阈值，允许并行（§8）；dev-2 本身不归本提案管理 |
| 8 | dev-2 / 更新策略 / Space 迁移不由本提案管理 | 只保留边界和接口，不设协调问题、不替它们做决策 |
| 9 | 测试工程不得有 Rust 测试层；46 个 journeys 需按 parity 退役 | 46 个 journeys 均已 `ts-owned`，但 `legacyExecution` 仍 required；新增退役路径与治理缺口（§5.6） |

---

## 1. 摘要与建议

平台层的问题不止网络。过去两个月的故障修复主要落在传输层，但同样的演化方式已经扩散到会话、Agent 运行时、Space 构建、云端控制面和测试平台：

1. **废弃但仍在关键路径**：`agent_space_builder` 已在 2026-10-10 标注退役，3,935 行仍被 `workspace.rs` 的 8 处和 `router.rs` 的 init/build 调用，并且按名字写死 4 个 Agent，直接违反架构 B1。
2. **god module**：`session/manager.rs` 13,760 行 / 57 个公开方法；`client.ts` 2,680 行 / 133 个方法；`workbench/session/store.ts` 3,956 行；`cloud/store.ts` 约 2,789 行 / 135 条 SQL。
3. **跨层重复模型**：session、workspace、diagnostics/feedback 在 daemon、workbench、cloud 至少各有三份表示。
4. **兼容层只加不删**：181 个 RPC 变体、151 个 domain 类型、约 241 个可选字段、20+ 个版本化能力位，全平台只有 5 处 deprecated 标记。本次重构**不设兼容窗口**，直接按“当前版本自洽”删除。
5. **业务保留项内部的复杂度**：Speech（daemon 4,990 行）与 CLI front（11,422 行）是业务面，保留；`project_control`（1,461 行）是已确定退役的平台 PM，专项删除；团队机制和内置模板（含 PM board）保留。
6. **测试被复杂度绑架**：852 个用例、全量约 3 小时、22 个 exclusive 文件、`testing/deprecated` 仍有约 91 例 / 6,553 行。

**建议**：采用“删除优先 + 单一事实来源 + 当前版本自洽”的平台简化计划，分 P0–P4。P0（删除退役层、SpaceBuilder 迁移、平台 PM 退役）、P1（云端收敛）可以与 dev-2 并行；P2（拆 god module）在 dev-2 当前 WIP 提交后即可开始，允许小冲突。验收不看新增能力，看**净删除行数、机制数下降、协议/配置面收缩和门禁时间**。

---

## 2. 背景与用户场景

**场景 A：打开/校验一个 Space 时跑着已决定退役的逻辑。**
用户在自己的数据目录里打开一个团队 Space。daemon 在 `workspace.rs` 的打开、列表漂移检查、加锁、父子校验等 8 个位置调用 `agent_space_builder::verify_space`；`router.rs` 的 `init`/`build` 也调用它。这个模块 2026-10-10 已宣布退役，但它按 `["codex","cursor","codebuddy","claude-code"]` 写死布局。用户感知是“打开 Space 有时慢/行为不一致”，工程上是“热路径上跑着不再维护的代码”。

**场景 B：一个列表字段要改三层。**
`session.list` 的字段、状态和分页语义同时存在于 daemon `session/store.rs`、workbench `session/store.ts`、cloud `store.ts` 的目录投影里。dev-2 这次做 lean 投影，必须同时改 daemon 和浏览器；任何一层漏改，就是“列表缺字段/摘要不对/离线判断错误”。

**场景 C：一个平台修复要改五个入口。**
Fabric admission 的 ticket/route/peer 回复在 `app-api.ts`、`enrollment.ts`、`workspace-catalog.ts`、`workspaces.ts` 和 relay `remote-fabric-authority.ts` 都有路径。本候选刚把回复形状抽到 `fabric-ticket.ts`，说明重复确实存在；安全修复仍需逐入口核对。

**场景 D：为了防御已删除的机制，测试门禁越来越长。**
全量 852 例、约 3 小时，22 个 exclusive 用例独占调度器；`testing/deprecated` 的约 91 个 legacy 用例仍在门禁里。结果是每次候选收尾都要付一次 3 小时，而其中一部分是在为退役/兼容路径背书。

**场景 E：平台 PM 已决定退役，但代码还在。**
`project_control` 仍挂在 daemon 启动、会话生命周期、项目配置门禁和 `project.approval.request` 上；当前没有任何现存 Space 显式启用 `pm` 组件，只有 `adopt_legacy_pipe_spaces` 的旧配置迁移路径。用户感知不到它，但它在会话/项目路径上持续增加条件分支。

---

## 3. 现状与证据

### 3.1 规模

| 部件 | 行数（主干附近） | 备注 |
|---|---:|---|
| `apps/daemon` | 91,641 | session 22,413、cli_front 11,422、adapter 7,985、dataplane 7,028、speech 4,990、agent_space_builder 3,935、router 3,949、workspace 3,231 |
| `packages/workbench` | 74,719 | session 25,803、preview 10,785、protocol 4,548、dataplane 4,357、deprecated 2,926 |
| `genethub-cloud/server` | 10,587 | `store.ts` 约 2.8k、`app-api.ts` 1,353、config 644 |
| `genethub-cloud/console` | 5,926 | `diagnostics.ts` 1,539、`Feedback.tsx` 513 |
| `apps/agent` | 11,777 | 内置 Agent 运行时 + provider（anthropic 841、openai 767） |
| `apps/host` / `apps/cli` / `apps/relay` | 5,835 / 3,318 / 3,492 | 原生宿主、薄 CLI、Relay |
| `packages/proto` | 8,682 | domain 3,126、rpc 1,555、resume 833 |
| 开发/编排平台 | 20,403 行 Skill + 16 个 Space + 757GB worktree | 与产品仓分开计 |

### 3.2 churn（最近 90 天，主干）

- `apps/daemon/src/session` 175 个提交、`packages/proto` 149、`workbench/session` 128、`daemon/dataplane` 97、`daemon/transport` 38、`workbench/protocol` 35、`relay` 17。
- 其中 `fix(network|fabric|dataplane|relay)` 19 个。
- 最热的平台文件：`endpoint.rs` 52 次、`client.ts` 30 次、`fabric.rs` 23 次、`uplink_pace.rs` 13 次。

### 3.3 事故与发布节奏

- 2026-10-24 到 10-28 四天内 4 个网络/稳定性反馈（连接稳定性、RTC 续期、35 秒心跳、805 会话 17.7 秒），期间发了 3 次 Beta。
- 这不证明所有问题都来自平台，但说明平台的边际修复成本已经高到影响发布节奏。

### 3.4 具体热点

- `agent_space_builder/mod.rs`：3,935 行；`manifest.rs:10` `AGENTS = ["codex","cursor","codebuddy","claude-code"]`；`planner.rs` 按 agent 名分支；`workspace.rs` 8 处调用；`router.rs` init/build 调用。
- `session/manager.rs`：13,760 行、57 个公开方法（create/fork/import/artifact/list/snapshot/inspect/narrative/round…）。
- `client.ts`：2,680 行、133 个方法（dial、handshake、heartbeat、reconnect、bulk lane、RTC、subscriptions、preview、shell、queue、diagnostics）。
- `cloud/store.ts`：约 2,789 行、135 条 `prepare`、21 张表、20 处逐行循环；`app-api.ts` 1,353 行、14 个 handler。
- diagnostics/feedback：daemon 186 + `preview_feedback.rs` 1,009；workbench 27；cloud server 218；console 1,539 + `Feedback.tsx` 513。
- `packages/workbench/deprecated/workbench-v4`：6 个文件、2,926 行；`tsconfig` 只 include `src`，不参与构建，但仍在仓库。
- `testing/deprecated/rust`：9 个测试文件、6,553 行、约 91 个可执行用例，仍进入全量门禁。

---

## 4. 目标与范围

**目标**

- 平台机制数量下降，而不是继续增加。
- 退役代码离开热路径并最终删除。
- 每个域只有一个事实来源，其他层是明确投影。
- 本次重构不设兼容窗口：删除旧路径/旧格式/旧协议，旧客户端必须更新。
- 测试门禁从“全量 3 小时”变成“受影响面分钟级 + 夜间全量”。

**本期包括**

- 已退役/废弃层的删除。
- SpaceBuilder 的 CLI 契约迁移：一次性迁移受管 Space，删除 `.pipebuilder` 与 Rust builder。
- 平台 PM（`project_control`）的退役。
- 跨层模型收敛（session、workspace、diagnostics/feedback）。
- god module 拆分。
- 协议/能力位/配置的直接收缩（无兼容窗口）。
- 测试与发布门禁分层。

**本期不包括（dev-2 拥有）**

- 传输/流控：`apps/daemon/src/dataplane/*`、`apps/daemon/src/transport/*`、`apps/relay/src/*`、`packages/workbench/src/dataplane/*`、`packages/workbench/src/protocol/client.ts`。
- 恢复/journal/resume、`session.list` lean、自适应轮询、RTC gather、载波切换。
- `packages/proto` 中与传输/恢复相关的字段和 `packages/workbench/src/session/store.ts` 的暂停/恢复逻辑。
- `testing/specialties/connectivity/*` 的网络用例。

**本期保留（用户已决策）**

- **Speech 保留**：daemon 4,990 行 + workbench 语音 UI 是业务面；只做内部拆分/去重，不删除。
- **CLI front 保留**：11,422 行是 Agent 使用的接口；只做 god module 拆分和重复逻辑收敛，不删除。
- **团队机制与内置模板保留**：`genehub-team` Skill、`team-template`、`tools/team.py`、`tools/pm_board_server.py`、`.pm/` 看板全部保留；平台 PM 的删除不影响它们。
- **多 lane 保留**：已随 `8e9300a4` 发布的 lane 0/1 不删；dev-2 的每流调度落地后再评估 >1 lane。

---

## 5. 术语与关键分析

### 5.1 兼容策略与多 lane

**兼容策略：本次重构不设兼容窗口**

用户已明确：这次重构优先简洁，不考虑兼容窗口。因此：

- 不保留长期双读、旧协议分支、旧能力位、旧客户端路径；到删除点就直接删除。
- 受管 Space 的 `.pipebuilder` 迁移由 **Space 工具链**处理，本提案不管理；本提案只定义 daemon 侧 verifier 和删除顺序（§5.2）。
- 旧 web / 旧 guest / 旧 App 客户端的更新提示与最低版本门槛由**发布侧**处理，本提案不管理。
- 协议字段/能力位的删除以“当前版本自洽”为准；不再按“最近 N 个版本”保留。
- dev-2 的传输能力协商归 dev-2 的提案决定，本提案不替它设窗口，也不管理 dev-2。

**多 lane 是什么**

- lane 是**同一机器的独立物理载体**：lane 0 = 控制/主通道；lane 1 = 正文/数据通道。
- 云端：`fabric_endpoints` 增加 `lane`（0/1），`nodeChannelCount=2`；daemon 的 `remote.rs` `channel_count` 支持 1–4 条 node uplink；浏览器 `bulk` 是第二条载体。
- 目的：大传输不阻塞小 RPC；200 成员规模；控制/正文分离。
- 现状：已随 `8e9300a4` 发布，不是本提案的删除目标。
- 建议：保留已上线的 lane 0/1；dev-2 的传输减法（传输层背压 + 每流队列）落地后，再评估 >1 lane 是否仍有必要。不要在本提案中删除。

### 5.2 SpaceBuilder：daemon 依赖 CLI 契约，一次性迁移

**现状：两套实现、两种 lock 格式**

| 实现 | lock 路径 | schema | 使用者 |
|---|---|---|---|
| Rust `agent_space_builder` | `.pipebuilder/lock.json` | `pipebuilder-lock.v1` | 当前 16 个受管 dev Spaces（全部是这种） |
| Python SpaceBuilder CLI | `.spacebuilder/lock.json` | `spacebuilder-lock.v1` | 产品内置 Skill 的 team Space |

**用户决策**：daemon 依赖 CLI 约定。实施方式：

1. **单一实现**：Python SpaceBuilder CLI（`spacebuilder.py check|build|verify|clean`）负责生成和完整校验；daemon 不再按 agent 名写死布局。
2. **daemon 消费 lock 契约**：只读 `.spacebuilder/lock.json` 的 schema、ownership、digest，做快速完整性检查；需要完整校验时调用 `spacebuilder.py verify`（结果按 lock digest 缓存），不在每次 open 都跑完整构建。
3. **Space 迁移由 Space 工具链处理，本提案不管理**：本提案只定义 daemon 侧 verifier 和删除顺序；先确认工具链已将受管 Space 迁到 `.spacebuilder`，再删除 `.pipebuilder` 读取和 Rust 模块。迁移的验收与回退由 Space 工具链负责。
4. **B1**：daemon 代码里不出现 agent 名分支；agent 布局属于 CLI 的输入/输出。

**验收**：daemon 无 `AGENTS = [...]` 硬编码；16 个受管 Space 迁移后 open/list/lock/init/build 行为不变；`spacebuilder.py verify` 通过；净删除 ≥3.9k 行。
**风险**：两种 lock schema 不同；迁移脚本需要覆盖 16 个 Space 和未来新建 Space；迁移失败要有 git 回退。

### 5.3 project_control 依赖分析、平台 PM 退役、团队模板保留

**依赖链（已核对）**

- `COMPONENT_PM = "pm"`（`agent_space.rs:23`）→ `agent_space_requires_project_control`（`router.rs:437`）→ 项目配置/管理门禁。
- `project_control::Broker` 在 `state.rs` 初始化；`router.rs` 约 30 处引用：`rebind`、`revoke_session`、`mutation_lock`、`issue_management`、`has_binding`、`binding_snapshot`、`remove_binding`、`revoke_workspace`。
- `agent_space_builder/management.rs` 使用 `mutation_lock`、`issue_management`、`completed_action`。
- `cli_front/space.rs` 的 `RequestApproval` → `project.approval.request`；proto 有 `ProjectApprovalRequest` 和 `BootstrapApprovalChallenge`。
- workbench 侧没有引用。
- 当前**没有现存 Space 显式启用 `pm`**；只有 `config.rs::adopt_legacy_pipe_spaces` 把旧 `pipespace` 的 `pm` 字段迁移成组件。

**团队样板 PM board 是什么（保留）**

`team-template/tools/pm_board_server.py` 是**团队样板**里的“实时团队作战看板服务”，不是平台 `project_control`：

- 生成 `<team-root>/datas/board/index.html`（H5 看板）和 `live.json`（1+N 空间、会话、worktree、里程碑、人类指导、可玩版本、QA 报告等聚合状态）。
- 由 `team.py` 的 `ensure_team_board` 调用，按 `TEAM_BOARD_PORT` 启停。
- 由 `soul.md`、`team-core`、`team-reflect` 声明为团队自有、可演进的工具。
- 属于 **M3 团队机制/内置模板**，用户已明确保留。

**退役路径（平台 PM）**

1. 停止迁移/创建 `COMPONENT_PM`；`agent_space_requires_project_control` 返回 false 或删除。
2. `project.approval.request` 返回 `projectRetired`（与 `workflowRetired` 同样的处理方式）。
3. 删除 `project_control.rs`、PM 门禁、`agent_space_builder/management.rs` 的审批逻辑；清理 `router.rs` 的约 30 处引用。
4. **PM Space 不需要保留**：直接删除平台 PM，不做 PM Space 的兼容/迁移提示；不删除用户 `.pm/` 数据；团队看板不受影响。
5. **保留** `team-template/tools/pm_board_server.py`、`team.py`、`.pm/` 看板、`genehub-team` Skill。

**验收**：新配置/模板无平台 `pm` 组件；`project.approval.request` 返回 retired；`project_control` 引用为 0；团队看板与 `team.py` 功能不变。

### 5.4 业务保留项：Speech 与 CLI front

这两项保留，但仍有内部复杂度需要处理：

- **Speech**：daemon 4,990 行 + workbench UI。建议只做模块边界整理（`mod.rs` 1,975 行拆分）、与 proto `speech.rs` 的契约收敛；不删除、不改变功能。
- **CLI front**：11,422 行，是 Agent 使用的接口。建议按命令域拆分 `query.rs`（2,643）、`converse.rs`（1,962）、`file.rs`、`space.rs` 等；保留 CLI 语义，不把 daemon 的 CLI 实现迁走。
- 验收：功能与命令行为不变；单文件规模下降；Agent 调用路径的测试保持通过。

### 5.5 legacy 用例分类（不是全部清理）

| 文件 | 注解数 | 性质 | 建议 |
|---|---:|---|---|
| `authorization.rs` | 6 | 鉴权/安全 | **保留默认门禁** |
| `command.rs` | 17 | 核心命令/进程行为 | **保留** |
| `concurrency.rs` | 4 | 真实并发/调度 | **保留** |
| `install.rs` | 7 | 安装/发布契约 | **保留** |
| `supply_chain.rs` | 5 | 供应链/签名 | **保留** |
| `claude.rs` | 6 | 真实外部 LLM（403 余额） | 移到 **release-only / canary** |
| `cursor.rs` | 2 | 真实外部 Agent | 移到 **release-only** |
| `opencode.rs` | 2 | 已暂停的 parity | **删除/标记 suspended** |
| `journeys.rs` | 46 | 业务旅程 | **本提案已逐项分类**：44 个当前业务旅程保留；1 个真实 provider 移到 release-only；1 个旧 thinking 别名测试随别名删除（附录 A） |

- 结论：46 个 journeys **全部已有 TS 对端**（`ts-owned` + tsId 全部存在），业务覆盖不应丢失；问题不是“保留 Rust”，而是“按 per-case parity 退役 Rust 行”。退役路径见 §5.6。
- 注意：`testing/deprecated` 的 “deprecated” 指的是**冻结的 Rust 测试实现**；TS 对端已在 `testing/journeys/**`。附录 A 的 44/1/1 是业务覆盖分类，不是 Rust 退役结论。
- 验收：46 个 journeys 的 TS 对端实际运行并通过；Rust required 行从 91 降到 0（或仅剩 suspended）；Rust suite 最终删除。

### 5.6 测试工程的 Rust 遗留：为什么 44 个 journeys 还在，以及怎么退役

**一句话**：给治理加一个“已由 TS 接管”的标记 → 逐条跑 TS/Rust 对比 → 证明一条就从门禁删一条 → 全删完后移除 Rust 测试代码。**你不需要签任何东西。**

**政策原文（Cloud `docs/testing`）**

- **P11**：新测试工程没有默认 Rust 层；Rust 产品行为由 TypeScript 驱动真实 artifact 证明；迁移期旧 Rust integration crate 是 frozen legacy，不是目标架构。
- **L12**：不得用 Rust 编写新 journey、specialty、E2E、scheduler、environment、reporter 或业务 test helper；`rust-legacy` adapter 必须是调用冻结旧 crate 的 TypeScript 进程 adapter。
- **L13**：不得无 parity 停跑或删除 Rust legacy；旧 crate 先原样迁入 `testing/deprecated/rust/` 并继续 **required**；没有旧 ID、新 TS ID、断言差异、同一源码/artifact 的 parity run 和故障注入证明，不得降级、停跑或删除。

**故障注入不需要 Rust。** TS 测试框架已经提供：

- `startFaultLink`：cut / block / blackhole / held bytes / `cutAfterClientBytes` / `cutAfterServerBytes`
- `startShapedTcpProxy`：RTT / 带宽整形（透明 TCP，不解析产品协议）
- 现有 `slow-peer-isolation`、`debug-reconnect`、`active-capacity-drop`、`neteff-depth` 等 specialty 已经在用

所以 L13 要求的 parity run 和故障注入都可以由 **TS 驱动同一 artifact** 完成；只有 ABI/unsafe/内存模型等 native-intrinsic 事实才需要源码就近的 Rust 验证（P11）。当前 46 个 journeys 都是业务行为，不属于这一类。

**现状核查**

- `testing/migration/rust-parity.json`：93 行（journeys 46、command 17、install 7、authorization 6、claude 6、supply_chain 4、concurrency 3、cursor 2、opencode 2）。
- **46 个 journeys 全部 `status: "ts-owned"`，`tsId` 全部存在（0 缺失）**；TS 对端在 `testing/journeys/**`。
- 但 46 个 journeys 全部 `legacyExecution: "required"`；全量 91 行 required、2 行 suspended（opencode）。
- `parityEvidence` 是一条历史记录，notes 明确写着 “not accepted as blanket retirement proof”。
- 治理校验 `testing/infrastructure/lint/governance.ts` 只允许 `required` 或 `suspended`；`testing/specialties/contracts/rust-oracle-class.specialty.ts` 也要求每行是 required/suspended。**没有 `retired` 状态。**
- **Cloud `docs/testing/README.md`（测试工程总体提案）首行**写 “M6 已把业务动作面换到 TypeScript，Open 冻结 crate 保留且 testctl 不再执行 rust-legacy”；但同仓的 Open `testing/README.md` 写 “`testing/deprecated/rust/` is frozen legacy … complete `testctl` gates retain required legacy cases”，当前 `testctl.ts` 也仍有 `runRustLegacyUnit`，parity 仍 required。**两份 README 与代码/parity 不一致**；当前事实以 Open `testing/README.md` + `rust-parity.json` + `testctl.ts` 为准。

**`legacyExecution` 状态语义**

| 值 | 含义 | 是否进默认 gate |
|---|---|---|
| `required` | 旧 Rust case 仍必须运行（当前默认） | 是 |
| `suspended` | 产品能力已由 Human 决定下线；保留源码与行，计入未执行清单 | 否 |
| `retired`（**本提案新增**） | 能力仍在，但 TS 对端已有 per-case parity 证据；Rust case 可以移出并删除 | 否 |

`retired` 不是“能力退役”，而是“**Rust 实现退休、TS 实现接管**”。它需要一个 `retirement` 记录（approver/date/evidence/run ids），默认仍是 `required`；没有证据不能改。

**结论**

- 44 个 journeys **不是“新写的 Rust 测试”**，而是 frozen legacy；TS 对端已经存在，用例层面的迁移基本完成。
- 它们仍被 required，是因为 L13 要求 per-case parity evidence，而治理没有 `retired` 出口；`parityEvidence` 又不被接受为 blanket proof。结果是 **Rust 用例无法按 parity 正常退役**，只能永远 required 或按“能力下线”suspended。
- README 的“不再执行 rust-legacy”是目标/过期状态，不是当前事实。这正是你看到“44 个 journeys 居然都是 Rust”的原因。

**退役流水线（4 步，可直接执行）**

**Step 0 — 治理出口（1 个 PR）**

- `testing/migration/rust-parity.json`：新增 `legacyExecution: "retired"` + `retirement { evidence, runIds, tsId, assertionDelta, fault, reviewedIn }`。**不需要产品签字**：L13 只对 `suspended`（能力下线）要求 Human 批准；parity 退役以证据 + PR review 为准。
- `testing/infrastructure/lint/governance.ts`：允许 retired，校验 `retirement` 字段；`required` 默认不变。
- `testing/policies/gates.ts`：`rust-legacy` 分支增加 `legacy-retired` 排除，reason 写明 retirement run ids。
- `testing/specialties/legacy/required.specialty.ts`：retired 行不再注册为 rust-legacy。
- `testing/specialties/legacy/parity-batch.specialty.ts`、`testing/specialties/contracts/rust-oracle-class.specialty.ts`：允许 retired 并校验证据。
- 验收：一条 synthetic retired 行不进 gate，`governance check` 通过。

**Step 1 — parity runner（1 个 PR）**

- 新增 `testctl parity --case <oldId> [--fault <spec>]`（或 `testing/migration/parity-run.mts`）。
- 对每一行：在同一 `--open`/`--cloud` SHA 和 artifact 下，跑 TS 对端 + Rust legacy（rust-legacy adapter），归一化公开证据（reply/event/disk/git/process），写 `testing/migration/parity/<oldId>.json`。
- 故障注入由 TS 驱动：`startFaultLink`（cut/blackhole/held bytes）或 `startShapedTcpProxy`（RTT/带宽），不需要 Rust。
- 验收：一条 journey 产出可追溯的 parity receipt；`testctl inspect` 可读。

**Step 2 — 按 suite 批量退休（每个 suite 一个 PR）**

- 顺序：journeys 46 → command 17 → install 7 → authorization 6 → supply_chain 4 → concurrency 3。
- claude 6 / cursor 2：留在 release-only 矩阵，不阻塞默认 gate；opencode 2 保持 suspended。
- 每批：跑 parity → 修 TS 缺口/断言差异 → 标 retired → 从默认 gate 移除 → 删除该 suite 的 Rust 文件。
- 验收：`governance check` 通过；full gate 不再跑已退休 Rust case；TS 对端在同一 gate 通过。

**Step 3 — 删除 Rust 代码**

- 所有 suite 清空后删除 `testing/deprecated/rust/` 和 `testing/infrastructure/adapters/rust-legacy.ts`；移除 `RunnerKind`/testctl 的 rust-legacy 分支；更新两份 README 的 M6 状态。
- 验收：代码中无 rust-legacy；full gate 仍通过。

**不需要你决策，按以下默认执行**

1. **审批**：不设产品签字。`retirement` 记录证据 + PR review；只有 `suspended`（能力下线）才需要 Human 批准。
2. **证据门槛**：自动 receipt（同 artifact + 同公开证据 + 故障注入）+ 每个 suite 一次 PR review。
3. **删除节奏**：每个 suite 退休后立即删对应 Rust 文件，PR 小、可回滚。

**验收**：46 个 journeys 的 TS 对端实际运行并通过；parity evidence 可追溯；Rust required 行从 91 降到 0（或仅剩 suspended）；`rust-legacy` adapter 删除；README 与代码一致。

---

## 6. 问题清单（六类）

### A. 废弃但仍在关键路径（严重度：高）

| 证据 | 业务影响 | 违反标准 |
|---|---|---|
| `agent_space_builder` 3,935 行，2026-10-10 标注退役，仍在 `workspace.rs` 8 处和 `router.rs` init/build 调用 | 打开/校验 Space 走退役逻辑；B1 边界被违反；用户感知为偶发慢/行为不一致 | 简洁、可靠 |
| 按名字写死 4 个 Agent（`manifest.rs:10`） | 新增 Agent 必须改平台代码，违反 B1 | 可靠 |
| `.pipebuilder` / `.spacebuilder` 两套 lock 格式并存 | daemon 绑在退役格式上，产品 CLI 契约无法收敛 | 简洁 |
| 平台 PM（`project_control` + `COMPONENT_PM`）仍挂在会话/项目路径 | 已决定退役的机制持续增加条件分支 | 简洁 |
| `packages/workbench/deprecated` 2,926 行 | 占认知和搜索空间，不参与构建 | 简洁 |
| `testing/deprecated` 约 91 例 / 6,553 行仍在门禁 | 每次全量都付测试时间 | 高效 |
| `expert.py`、旧变量/目录/标签兼容壳 | 旧名迁移完成前不能删，缺少到期日 | 简洁 |

### B. God module（严重度：高）

| 文件 | 规模 | 承担职责 |
|---|---|---|
| `daemon/session/manager.rs` | 13,760 行 / 57 公开方法 | 创建、fork、import、artifact、列表、快照、inspect、narrative、round… |
| `workbench/protocol/client.ts` | 2,680 行 / 133 方法 | 拨号、握手、心跳、重连、bulk lane、RTC、订阅、预览、shell、队列、诊断 |
| `workbench/session/store.ts` | 3,956 行 | 会话状态、订阅、轮询、恢复、通知 |
| `cloud/store.ts` | 约 2,789 行 / 135 SQL | 账户、机器、工作区、会话目录、票据、审计 |
| `cloud/app-api.ts` | 1,353 行 / 14 handler | 机器连接、工作区、票据、设备、更新 |
| `daemon/router.rs` / `workspace.rs` | 3,949 / 3,231 | Agent 路由、Space 扫描、锁校验、工作区生命周期 |

**业务影响**：任何需求改动都落在 2k–13k 行文件里；评审、回归、定位成本高，merge 冲突频繁。

### C. 跨层重复模型（严重度：中高）

| 概念 | 表示位置 | 风险 |
|---|---|---|
| Session | daemon `session/store.rs` + `manager.rs`；workbench `session/store.ts`；cloud `store.ts` 目录投影 | 字段/状态 drift；lean 改动要同时动 3 层 |
| Workspace 目录 | daemon `workspace.rs`；cloud `workspace-catalog.ts` + `store.ts` placements | 在线判断/最后可见时间不一致 |
| Diagnostics/Feedback | daemon `diagnostics.rs` + `preview_feedback.rs`；workbench `diagnostics.ts`；cloud `server/diagnostics.ts`；console `diagnostics.ts` + `Feedback.tsx` | 脱敏/字段/采样策略各自实现 |
| Agent 注册/路由 | `apps/agent` provider registry；daemon `adapter/registry.rs` + `agent_routing.rs`；workbench `capability-preferences.ts` | 能力位/模型路由语义重复 |

### D. 兼容层只加不删（严重度：中高）

- 181 个 RPC 变体、151 个 domain 类型、约 241 个 `serde(default)` 可选字段（domain）+ 108（rpc）。
- 20+ 个版本化能力位，部分 v1/v2/v3 并存：`genehub.preview-runtime.v2/v3`、`speech.transcribe.v2`、`speech.transcribe.partial.v1`、`asset.preview.image.v1`、`asset.preview.machine-file.v1`、`fabric.channels.v1` 等。
- 全平台 deprecated 标记只有 5 处；没有淘汰日期或迁移检查。
- `DATA_PLANE_VERSION=4`、`WEB_PROTOCOL_VERSION=v3`。

**业务影响**：每加一个特性就多一条混合版本路径；测试矩阵和发版检查持续膨胀。**本次不做兼容窗口，按当前版本自洽直接收缩。**

### E. 配置/测试漂移（严重度：中）

- 平台目录 **112 个常量** + **34 个 `GENEHUB_*` 环境变量**；窗口、队列、超时、上限散落在 fabric、logical_connection、endpoint、rtc、relay。
- 全量门禁 852 例、约 3 小时、22 个 exclusive 文件、192 个 specialty 文件、451 个 id 声明。
- 每个 knob 都是独立故障面；复现问题时环境差异难对齐。

---

## 7. 具体方案（P0–P4）

### P0 — 删除退役层 / SpaceBuilder 迁移 / 平台 PM 退役

**P0.1 SpaceBuilder 迁移并删除 Rust builder**

- 目标：删除 3,935 行，消除 B1 违规和热路径负担；daemon 依赖 CLI lock 契约。
- 实施：
  1. 定义 daemon 侧最小 verifier：读 `.spacebuilder/lock.json`（`spacebuilder-lock.v1`）的 schema/ownership/digest；完整 verify 调用 `spacebuilder.py verify`，按 digest 缓存。
  2. 用 CLI build 把 16 个受管 Space 一次性迁到 `.spacebuilder`；迁移前后比对各 Space 的生成物摘要；保留 git 回退点。
  3. 迁移 `workspace.rs` 的 8 处 `verify_pipe_space`；迁移 `router.rs` 的 `init`/`build`（允许与 dev-2 小冲突，见 §8）。
  4. 删除 Rust 模块、`lib.rs` 声明、`state` 引用、`.pipebuilder` 写入/读取路径。
- 验收：16 个受管 Space 迁移后 open/list/lock/parent/child/init/build 行为不变；`spacebuilder.py verify` 通过；B1 检查通过；净删除 ≥3.9k 行。
- 回滚：迁移前保留 git 回退点；Rust builder 删除前先完成迁移验收；不做长期双读。

**P0.2 删除 `packages/workbench/deprecated/workbench-v4`**

- 目标：删除 2,926 行；不参与构建，风险低。
- 验收：`tsconfig`/`vite` 构建和测试不变；grep 无引用。

**P0.3 Rust legacy 按 parity 退役**

- 按 §5.6 执行：为 46 个 journeys + 其余 ts-owned 行逐条记录 parity evidence；扩展 `legacyExecution: "retired"`；从默认 gate 移除已 retired 行；删除对应 Rust suite，最终删除 `testing/deprecated/rust` 和 `rust-legacy` adapter。
- 39 个核心（authorization/command/concurrency/install/supply_chain）按同一规则处理：有 TS 对端的按 parity 退役；opencode 保持 suspended；claude/cursor 的真实外部用例留在 release-only 矩阵。
- 验收：Rust required 行从 91 降到 0（或仅剩 suspended）；46 个 journeys 的 TS 对端全部通过；README 与代码一致。

**P0.4 平台 PM 退役（保留团队模板）**

- 按 §5.3 执行：停止 `COMPONENT_PM` 迁移/创建；`project.approval.request` 返回 retired；删除 `project_control` 与 PM 门禁；**保留** `team-template/tools/pm_board_server.py`、`team.py`、`.pm/` 看板和 `genehub-team` Skill。
- 验收：新配置无平台 `pm`；`project_control` 引用为 0；团队看板与 `team.py` 功能不变；已有 PM Space 有迁移提示。

**P0.5 清理兼容壳（不影响团队模板）**

- `expert.py → team.py` 是团队模板内的兼容别名；**保留团队模板本体**。只有在确认无模板/团队引用后，才删除 `expert.py` 这个别名。
- 旧环境变量/目录/标签的兼容逻辑，迁移完成后删除；给出到期日。

### P1 — 收敛云端模型（可与 dev-2 并行，cloud-only）

**P1.1 拆分 `cloud/store.ts` 与 `app-api.ts`**

- 按域拆：accounts、machines、workspaces、sessions/directory、fabric tickets、downloads/audit。
- 把 135 条 SQL 的逐行循环改成批量查询（本候选已在 workspace directory 做过一次，说明模式存在）。
- 验收：所有 HTTP 路由行为不变；查询等价性测试；N+1 计数下降；单文件 <1.5k 行。

**P1.2 收敛 diagnostics/feedback**

- 定义一份事件 schema + 脱敏策略；daemon/workbench/cloud/console 只做投影。
- 验收：同一反馈在 4 层解析一致；脱敏测试通过；console diagnostics 1,539 行显著下降。

### P2 — 拆 god module（dev-2 当前 WIP 提交后即可开始）

**P2.1 `session/manager.rs`**

- 按 lifecycle / round / artifact / permission / import-fork / inspection 拆分；57 个公开方法收敛为域服务。
- 验收：公开 API 不变；characterization tests 通过；单文件 <5k 行（首期目标）。

**P2.2 `workbench/protocol/client.ts`、`workbench/session/store.ts`**

- 按 dial/recovery/subscriptions/preview/shell 与状态切片拆分。
- 验收：现有 client/session 测试全过；公共导出不变。

**P2.3 `daemon/router.rs`、`workspace.rs`、`cli_front/*`、`speech/mod.rs`**

- 在 P0.1/P0.4 完成后，按域拆分；CLI front 与 Speech 保留功能，只做内部边界整理。

### P3 — 协议/能力位/配置直接收缩（无兼容窗口）

- 按“当前版本自洽”删除旧协议字段、旧能力位、旧客户端路径；不保留长期兼容层。
- 建立 capability/optional 字段清单：keep / remove（直接执行）。
- 协议面审计：181 RPC、151 类型、241 可选字段，先做分类，再删除不再需要的部分。
- 配置收敛：112 常量 + 34 env 收敛到一个 policy 模块，带默认值、校验和文档；删除纯调参 knob。
- 验收：能力位数量下降 ≥30%；可选字段下降 ≥20%；配置常量下降 ≥30%；旧客户端在发布说明中明确需要更新。

### P4 — 测试与发布门禁分层

- 两级门禁：受影响面（目标 <15 分钟）+ 夜间全量（目标 <90 分钟）。
- 审计 22 个 exclusive 用例，只保留真正需要全局网络命名空间/tc/固定端口的。
- 验收：受影响面门禁覆盖本次改动；全量时间下降；无覆盖回退；失败归因清晰。

---

## 8. 与 dev-2 的冲突矩阵（少量冲突允许）

**阈值**：
- **小冲突（可接受）**：单文件 <50 行改动、非重叠函数、机械 rebase、commit 级冲突。
- **大冲突（避免）**：同一函数/同一 200 行以上区域重写、协议/流控语义改动、同一测试 fixture 重写。
- 撞到大冲突时暂停并协调，不硬合并。

| 文件/区域 | dev-2 状态 | 本提案动作 | 排期 |
|---|---|---|---|
| `apps/daemon/src/dataplane/*`、`transport/*` | 正在重构（WIP） | 不碰 | 不涉及 |
| `apps/relay/src/*` | dev-2 已交付/可能继续 | 不碰 | 不涉及 |
| `packages/workbench/src/dataplane/*`、`protocol/client.ts` | 正在重构 | 不碰 | 不涉及 |
| `packages/proto` 传输/恢复字段 | 正在改 | 只做淘汰政策，不改字段 | P3，且先协调 |
| `apps/daemon/src/session/manager.rs` | 有 lean 投影改动 | 拆分可在当前 WIP 提交后开始，接受小冲突 | P2 |
| `packages/workbench/src/session/store.ts` | 有 pause/resume/polling 改动 | 拆分可在当前 WIP 提交后开始，接受小冲突 | P2 |
| `apps/daemon/src/router.rs` | WIP | P0.1/P0.4 可并行；小冲突直接 rebase，大冲突暂停 | P0 |
| `apps/daemon/src/cli_front/query.rs` | WIP | 不碰 | 不涉及 |
| `testing/specialties/connectivity/*` | dev-2 | 不碰 | 不涉及 |
| `apps/daemon/src/workspace.rs` | 无 WIP | P0.1 可先做 | P0 |
| `apps/daemon/src/agent_space_builder/*` | 无 WIP | 删除 | P0 |
| `packages/workbench/deprecated/*` | 无 WIP | 删除 | P0 |
| `testing/deprecated/*` | 无 WIP | 分类退役 | P0 |
| `genethub-cloud/server/*`、`console/*` | dev-2 已提交 lane，但无 WIP | P1 可并行，注意 rebase | P1 |
| `apps/daemon/src/speech/*`、`cli_front/*`（除 query.rs） | 无 WIP | 保留；只做内部拆分 | P2 |

**规则**：不修改 dev-2 正在重构的传输核心；其他文件允许小冲突，遇大冲突暂停协调。

---

## 9. 取舍与替代方案

| 方案 | 优点 | 缺点 | 判断 |
|---|---|---|---|
| 全平台重写 | 一次到位 | 风险极高、无业务增量、会重复过去两个月的循环 | 不采纳 |
| 只加测试/只修 bug | 短期安全 | 机制继续叠加，门禁继续变长 | 不采纳 |
| **删除优先 + 单一事实来源 + 当前版本自洽** | 直接降低复杂度和门禁成本 | 旧客户端必须更新；需要一次性迁移 | **推荐** |
| 保留 `agent_space_builder` 但改成数据驱动 | 兼容现有调用 | 仍然是独立的 Rust 构建器，违反“平台只提供原语”的方向 | 不采纳（用 CLI lock 契约/最小 verifier 替代） |
| daemon 直接调用 Python CLI 做每次 open 的完整 verify | 单一实现 | 进程启动/Python 依赖/延迟；热路径不适合 | 不采纳（只在需要完整校验时调用，结果按 digest 缓存） |
| 保留长期兼容窗口/双读 | 旧客户端平滑 | 代码无法收缩，违背本次“简洁优先” | 不采纳（用户已明确） |

---

## 10. 验收与交付

### 10.1 全局指标

| 指标 | 现状 | 目标 |
|---|---|---|
| 平台净删除行数 | — | P0 ≥ −6.8k 产品行 + −6.5k 测试行；整体 ≥ −12k（含测试），冲刺 −15k |
| 退役机制 | agent_space_builder、平台 PM、兼容壳、legacy 门禁、重复 diagnostics | 全部离开默认路径 |
| Rust legacy required 行 | 91 required / 2 suspended | 0 required（仅 suspended）；删除 rust-legacy adapter |
| God files | manager 13.8k、client 2.7k、store 4.0k/2.8k | 首期：无 >5k；二期：无 >3k |
| 能力位/可选字段 | 20+ / ~241 | −30% / −20% |
| 配置常量/环境变量 | 112 / 34 | −30% |
| 全量门禁 | ~3 小时 | ≤90 分钟 |
| 受影响面门禁 | 无统一层 | ≤15 分钟 |
| 用户可见（与 dev-2 共担） | 列表 17.7s、控制排队 | 列表 ≤2s、控制 p95 ≤300ms、首屏 ≤1s |

### 10.2 每期独立可交付

- P0：SpaceBuilder 一次性迁移 + Rust builder 删除 + workbench deprecated + legacy 分类 + 平台 PM 退役；不改产品行为；团队模板保留。
- P1：cloud 拆分 + diagnostics 收敛；HTTP 行为不变。
- P2：god module 拆分；公共 API 不变；Speech/CLI front 功能保留。
- P3：协议/配置直接收缩；旧客户端按发布说明更新。
- P4：门禁分层；覆盖率不下降。

### 10.3 验证方式

- P0：16 个受管 Space 的迁移前后生成物摘要；open/list/lock/init/build 真实路径测试；B1 静态检查；`project.approval.request` retired 测试；团队看板/`team.py` 功能测试；grep 无 `AGENTS = [...]` 硬编码。
- P1：HTTP 路由契约测试；SQL 查询等价性测试；N+1 计数。
- P2：characterization tests；公共导出 diff；业务旅程回归。
- P3：当前版本自洽测试；旧客户端更新提示；回滚点验证。
- P4：受影响面选择器；全量时间测量；失败/不稳定统计。

---

## 11. 兼容、迁移与恢复

- **兼容策略**：本次不设兼容窗口；旧 web/guest/App 客户端必须更新。发布说明明确“需要更新到新版本”，并保留上一版本回滚点。
- **SpaceBuilder 数据**：一次性把 16 个受管 Space 从 `.pipebuilder` 迁到 `.spacebuilder`；迁移前保留 git 回退点；失败可回退到旧分支。
- **平台 PM**：已有 PM Space 启动时禁用 PM 并提示；不删除用户 `.pm/` 数据；团队看板与 `team.py` 继续可用。
- **团队模板**：`genehub-team`、`team-template`、`team.py`、`pm_board_server.py`、`.pm/` 看板全部保留，不受平台 PM 删除影响。
- **回滚**：每期独立；删除类改动先保留模块/开关一个版本，验收通过后再物理删除；云端拆分按域回滚。
- **发布**：本提案是平台内部简化，预期仍走 Live（guest + web + services），不涉及 App tag；ABI 是否变化由 `check-plan` 确认。旧客户端更新提示进入发布说明。

---

## 12. 未决问题（技术设计，不涉及已定决策）

1. **SpaceBuilder verifier 的技术设计**：daemon 读 `.spacebuilder/lock.json` + 按需调用 CLI `verify` 的缓存策略；错误/超时行为。
2. **P0 提交顺序**：P0.1/P0.2/P0.3/P0.4 的先后与同一槽位的验证顺序；`router.rs` 小冲突由当前执行者 rebase。
3. **Rust legacy parity evidence**：46 个 journeys 的 per-case parity run/故障注入由 TS 框架执行（`startFaultLink` / `startShapedTcpProxy`）；需要确定 `legacyExecution: "retired"` 的 schema、证据记录（不需要产品签字）和 run id 格式。
4. **README M6 状态**：修正“testctl 不再执行 rust-legacy”的表述，使其与代码/parity 一致。
5. **`expert.py` 别名**：确认无模板/团队引用后删除；不影响团队模板本体。

---

## 13. 下一步

1. 评审本提案，确认 §12 的技术设计项。
2. 在 `dev-3` 同步主干后，先做 P0.1 的 lock verifier 设计；Space 迁移由 Space 工具链完成后，再切换 daemon 读取并删除 Rust builder。
3. P0.2/P0.3/P0.4 可以立即并行；P0.4 直接删除平台 PM（PM Space 不需要）。
4. P2 在 dev-2 当前 WIP 提交后开始；小冲突由当前执行者 rebase，大冲突暂停。
5. 每期完成后更新本文件的状态和“已删除机制/净删除行数”，不把提案评审当作实施完成。

---

## 附录 A：46 个 journeys 逐项分类

口径：`testing/deprecated/rust/tests/journeys.rs`，46 个 `#[tokio::test]`。**保留 44，release-only 1，删除 1。**

| # | 测试 | 判定 | 理由 |
|---:|---|---|---|
| 1 | `the_main_journey_runs_a_task_end_to_end_on_the_built_in_agent` | 保留 | 主旅程，核心业务 |
| 2 | `streaming_output_is_visible_before_the_turn_ends` | 保留 | 流式输出，核心体验 |
| 3 | `a_multi_step_task_feeds_tool_results_back_until_it_finishes` | 保留 | 多步工具结果回灌 |
| 4 | `agents_that_are_not_installed_stay_out_of_the_picker` | 保留 | Agent 插件/选择器 |
| 5 | `the_picker_is_filled_from_what_the_provider_says_it_has` | 保留 | 模型目录 |
| 6 | `a_provider_the_user_adds_works_like_the_ones_we_ship` | 保留 | 自定义 provider |
| 7 | `models_written_by_hand_need_no_list_call` | 保留 | 手写模型配置 |
| 8 | `capabilities_are_declared_so_the_ui_never_offers_a_dead_control` | 保留 | 能力位/UI 禁用 |
| 9 | `switching_the_thinking_level_takes_effect_on_the_built_in_agent` | 保留 | thinking level |
| 10 | `a_choice_made_before_the_first_prompt_is_announced_and_not_only_stored` | 保留 | 首次选择生效 |
| 11 | `the_built_in_agent_still_answers_to_the_old_name_for_thinking` | **删除（随别名）** | 旧 `mode_id="high"` 别名；本次无兼容窗口 |
| 12 | `a_prompt_arriving_mid_turn_is_refused_rather_than_interleaved` | 保留 | 回合中拒绝并发 prompt |
| 13 | `an_unknown_tool_still_renders_instead_of_disappearing` | 保留 | 未知工具渲染 |
| 14 | `a_task_with_no_credentials_says_so_instead_of_failing_silently` | 保留 | 缺凭证错误 |
| 15 | `a_key_entered_in_settings_makes_the_very_next_task_work` | 保留 | 设置中录入 key |
| 16 | `a_key_the_provider_will_not_accept_says_that_and_not_add_a_key` | 保留 | 拒绝 key 的处理 |
| 17 | `a_real_provider_that_rejects_our_key_says_so_instead_of_hanging` | **release-only** | 依赖真实外部 provider（`real_only!`） |
| 18 | `model_failures_surface_as_actionable_errors` | 保留 | 模型错误可操作 |
| 19 | `the_agent_hands_the_model_a_system_prompt_and_tool_definitions` | 保留 | 系统提示/工具定义 |
| 20 | `conversation_history_is_replayed_to_the_model_on_the_next_turn` | 保留 | 历史回放 |
| 21 | `changes_made_by_the_agent_show_up_in_git_and_can_be_committed` | 保留 | Git 工作区 |
| 22 | `what_an_agent_left_running_is_answerable_to_the_session_that_started_it` | 保留 | 进程归属 |
| 23 | `files_can_be_browsed_and_edited_through_the_workspace` | 保留 | 文件浏览/编辑 |
| 24 | `writes_outside_the_workspace_are_refused` | 保留 | 越界写入拒绝（安全） |
| 25 | `a_terminal_opens_echoes_resizes_and_closes` | 保留 | 终端 |
| 26 | `a_commands_output_stays_behind_the_access_layer` | 保留 | 输出权限隔离 |
| 27 | `reconnecting_replays_the_gap_without_losing_or_repeating_events` | 保留 | 逻辑事件重放（非字节 journal）；dev-2 后端变化后需复验 |
| 28 | `asking_for_a_gap_older_than_the_window_gets_an_honest_full_reset` | 保留 | 逻辑订阅窗口重置；dev-2 后复验 |
| 29 | `history_survives_a_daemon_restart_and_the_conversation_continues` | 保留 | 重启持久化 |
| 30 | `a_session_found_in_the_list_can_be_reopened_and_continued` | 保留 | 列表重开会话 |
| 31 | `interrupting_a_running_turn_ends_it_as_canceled` | 保留 | 中断回合 |
| 32 | `continues_round_is_accepted_over_the_wire_and_ignored_when_unrecognized` | 保留 | `continuesRound` 仍是当前协议字段 |
| 33 | `a_message_naming_continues_round_after_an_interrupt_still_runs_normally` | 保留 | 同上，中断后续跑 |
| 34 | `a_completed_round_is_recorded_in_the_round_ledger_on_disk` | 保留 | round ledger |
| 35 | `an_interrupted_round_left_dangling_is_ledgered_as_superseded_once_a_new_one_starts` | 保留 | ledger 纠正 |
| 36 | `a_client_that_drops_mid_turn_gets_the_missing_events_when_it_returns` | 保留 | 逻辑订阅补事件（非字节 resume）；dev-2 后复验 |
| 37 | `a_second_client_sees_the_same_session_as_the_first` | 保留 | 多客户端一致性 |
| 38 | `a_connection_without_the_token_is_rejected_outright` | 保留 | 无 token 拒绝（安全） |
| 39 | `a_malformed_frame_gets_an_error_rather_than_silence` | 保留 | 坏帧错误 |
| 40 | `an_empty_prompt_is_refused_before_it_reaches_the_model` | 保留 | 空 prompt 校验 |
| 41 | `sessions_list_per_workspace_and_can_be_archived` | 保留 | 会话列表/归档 |
| 42 | `a_session_title_comes_from_the_first_thing_the_user_says` | 保留 | 会话标题 |
| 43 | `tool_calls_move_through_their_states_rather_than_appearing_finished` | 保留 | 工具调用状态 |
| 44 | `the_log_can_be_read_from_whatever_device_saw_the_error` | 保留 | 跨设备读日志 |
| 45 | `a_log_request_cannot_reach_outside_the_log_directory` | 保留 | 日志路径隔离（安全） |
| 46 | `a_session_starts_where_it_was_told_to_and_cannot_be_told_to_leave` | 保留 | 会话 cwd 绑定（安全） |

**汇总**：46 个 journeys 全部是 `ts-owned`（tsId 全部存在），因此“44 保留/1 release-only/1 删除”是**业务覆盖分类**，不是 Rust 退役结论。Rust 退役按 §5.6 的 per-case parity 执行：#11 的 TS 对端随别名一起退役；#17 的 TS 对端保留在 release-only 矩阵；其余 44 个 TS 对端保留为默认覆盖。
