# 完整连接简化：最终验收与合入交接

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

> 本文是 Open5cd379b6/Cloud66f37945 的历史验收记录，资格不沿用到后续提交。最新52fc0d55收尾范围及验证进展见 [收尾记录](full-agent-simplification-closeout-20261030.md)。

状态：最终候选验证通过，两仓 PR 已转 ready，GitHub 均为 MERGEABLE / CLEAN。工作流控制器已接受 completed，交付类型为 validated-candidate。不执行主干合并或产品发布。

## 候选与范围

| 仓库 | 最终候选 | 对应 main | PR |
| --- | --- | --- | --- |
| Open | `5cd379b67c1593df3b8dc04e201d4535a7618dc7` | `c1ba53e388a0647957dcfa69122fccb835e4ffbd` | [#71](https://github.com/aikenc/genethub/pull/71) |
| Cloud | `66f379458728a2741e6d841183d49b5d25336dbe` | `023c7d14744d6ee498823eaf6e4e03d33e9ecc33` | [#37](https://github.com/aikenc/genethub-cloud/pull/37) |

双仓 dev-3 已推送、工作树干净；远端 main 均为候选祖先，patch 级核对为 Open 5 个、Cloud 1 个待合补丁。没有执行合并、部署、发布或线上 daemon 重启，没有迁移真实设备及已有团队。原开发 Space 未修改。

[完整提案](agent-authority-simplification-proposal-20261029.md)的 W1–W6 已落地：

| 条款 | 结果与保留边界 |
| --- | --- |
| W1 完整连接权限归一 | LocalUser / SessionController / Device / Channel 统一按目标 daemon 的 OS 账号能力执行；来源、动作归属、CAS、幂等保留。 |
| W2 grants 与隐式降权退出 | 删除运行时能力位与普通连接分级，旧 scope/--grant 显式拒绝。已知旧全权设备保留身份；窄权限和未知凭证撤销并需重新配对。先保存私有原件、原子落盘，再发布新状态；写失败不消耗邀请。 |
| W3 hosted 定位与权限分离 | workspace 只作默认目标，完整连接跨项目成功；账号/机器归属、准入、撤销/过期、续租和仅展示分享仍有效。续租使用 logical registry 的当前有效 lease，长流不再被旧 expiry 误关。 |
| W4 旧 Workflow 退出执行 | 移除旧执行与授权特例；旧 managed 数据转 historyOnly，保留历史并可 fork 成普通会话，不恢复旧 prompt、未完成输入、副作用或原生续接。会话格式为 10。 |
| W5 死协议与 Space 投影退出 | 旧 Workflow RPC/CLI/proto 和 PipeSpace wire 投影退出；仅磁盘迁移读取旧形态，验证、备份后原子导入，新条目优先。WebProtocol 为 4，旧客户端明确提示升级。 |
| W6 team 与测试收尾 | team.py 是新分发入口；只替换已识别的旧产品 timer 命令，先备份并保留其他字段，自定义 hook 不改。旧 Rust helper、CLI 业务 suite 和 CI exclude 退出；冻结比较归档，没有恢复常驻旧 runner。 |

team 的 Space/组件树、角色、默认项目、父子关系、委派、定时钩子、写锁及一次结果回报均保留。原生 plan/只读模式、用户提问和凭证输入仍是业务交互。认证、撤销、过期、真实 OS 权限与仅展示分享范围没有因权限归一退出。

Open 差异共 146 文件：运行时/文档 67 文件 +707/−4319；非归档测试 65 文件 +1077/−3135；另 14 文件为冻结证据归档 +11769/−6，不能把这些归档行数当成新增运行机制。Cloud 为测试说明和 store 注释两文件，无运行时逻辑变化。

## 最终完整门禁

- Run：`261030-1343-full-agent-reserved-merge-6644`。
- **775/775 passed**，failed/blocked/unstable/interrupted 均为 0。
- `gate=merge`、`scope=gate`、`policyVersion=gates.v3`、`qualified=true`、`reasons=[]`；未使用过滤器或 resume。
- 双仓 SHA 与上表精确一致、dirty=false；`inputDrift=false`、`unprovenArtifacts=[]`。
- run 记录内进程/端口泄漏均为 0，不代表清理或核验了本任务以外的机器资源。
- 预算：6 环境、12 CPU、24 GiB；高负载独占用例仍使用其原 12 CPU/16 GiB 声明，没有减少负载、断言或单项超时。
- manifest SHA256：`500d45c85c2017fb765c9d5d8699a7bc0e3d91dd3980cfa80d13b402286e358b`。

可核对 summary（工作区资料：`spaces/dev-3/runs/261030-1343-full-agent-reserved-merge-6644/summary.md`，未纳入本仓）、manifest（工作区资料：`spaces/dev-3/runs/261030-1343-full-agent-reserved-merge-6644/manifest.json`，未纳入本仓）、最终候选核验回执（工作区资料：`spaces/dev-3/final-qualified-candidate-receipt.json`，未纳入本仓）。7 类执行产物（CLI、Host、guest、Relay、Workbench、Cloud server、Console）在门禁前后按文件清单、大小和 SHA256 逐项相同，见结束清单（工作区资料：`spaces/dev-3/final-artifact-inventory-end.json`，未纳入本仓）。

实际二进制 SHA256（不是 bundle 清单的 digest）：

| 产物 | SHA256 |
| --- | --- |
| CLI 薄转发器 | `a570657aa2ccb91f7790b96abf40f855ac54f1d3ce1245e7a94e07cd98a054d8` |
| Host | `429b08fea879c128f181f02324b84a0ce420662c36d044c17e1a2a2a7561a9fe` |
| guest | `3b5091a5c7490fac8f9c0740fbd564b6b0cbb5304716fb3e08d5176ba9f5d059` |

## 平台、team 与迁移证据

- [Open 最终 CI41006654550](https://github.com/aikenc/genethub/actions/runs/41006654550) 精确绑定 5cd379b6，所有 job 成功，包括 Windows/macOS 桌面监督测试、guest、Rust、Relay、web 与 gate。
- [Cloud CI41000635726](https://github.com/aikenc/genethub-cloud/actions/runs/41000635726) 精确绑定 66f37945；server、gate 等通过，Console 依据路径过滤 skipped。配套 Console 已本地重建，纳入完整门禁执行产物核验，并通过本轮 Console 基线，不能把 skipped 写成 CI Console 已执行。
- fmt、Clippy workspace/all-targets/−D warnings、cargo test --workspace --offline（daemon 642）、Workbench 857、Open/Cloud typecheck、治理和 layer lint 均通过。完整门禁内 daemon/Workbench/Console 基线再次通过。
- 本机完整门禁覆盖 Linux native 与 WASM guest/host，包含真实 namespace/tc 和已授权远端的隔离 WAN canary。Windows/macOS 证据来自匹配候选的 CI；曾预置但未执行的旧物理机器 smoke 不算证据，也不宣称两平台所有 UI 路径已实机端到端验证。
- team collaboration/reflection/fault-injection、远程委派、身份/hooks、组件组合、结果归属和一次回报均通过。20/60/80 会话四阶段工具负载通过；10 个本机隔离 daemon 的 200 会话、50/80/200 活跃任务、80 观察者、双预览混合负载与 200 成员摘要目录均通过。后者是本机多 daemon 压力测试，不能称 10 台实体机器。
- team 自动通道、100 正文订阅、固定通道拓扑、全部/聚焦/预算/分离控制正文策略均通过。容量退化对照只证明原 oracle 的完整恢复，不被计作生产延迟 SLO 通过。
- 真实创建/fork/import 目标归属、旧设备迁移及保存故障、旧会话历史与 fork 后工具副作用、旧 Space 混合配置失败保原件、准入/撤销/过期/续租、分享与 Human 交互均在完整门禁中通过。

## 旧测试退役证据

`rust-parity.json`：94 条 = 86 retired /6 release-only /2 suspended，openGaps=[]。两条并发旧缺口已通过实际冻结执行补证，原无效 run 没有被改写为有效。

| 比较 | 结果 | 说明 |
| --- | --- | --- |
| 并发重建 `261030-1019-parity-reconstruction-execute-4898` | 8/8，qualified，无漂移 | 实际 --ignored --exact 执行两个旧 Rust 测试，TS 四阶段负载、慢 Git/模型和预览背压同步比较；原件与唯一协议适配一并归档。 |
| CLI 接管 `261030-1030-cli-parity-c417` | 9/9，qualified，无漂移 | 实际执行旧原生 remote 七条与公开 TS 接管路径，合同变化及映射在 takeover.json 明示。 |

冻结原生与 WASM daemon 是同源码、不同二进制；共享当前 CLI/guest Agent，不宣称二者 daemon 文件字节相同。可核对仓库内 [并发归档 summary](../../testing/deprecated/archive/concurrency-reconstruction-20261030/summary.md) 和 [CLI 接管说明](../../testing/deprecated/archive/cli-reconstruction-20261030/takeover.json)。

真实 Claude 当前 release-only 探测仍为 403 Insufficient account balance，不计通过；子 Agent 隔离 TS 对端已补。OpenCode 两条仍 suspended，不执行、不算通过。这些既有状态不被完整 merge 的 775 项通过改写。

## 保留的失败与本次收尾

1. `261030-1158-full-agent-final-merge-d388`：697 项后中断，681 pass/15 fail/1 interrupted，无 finalized qualification。发现旧 JS bundle、旧 ACL oracle、服务请求漏 FIN、自更新预期关闭被记为崩溃及 Windows 4 秒等待短于 guest 关闭预算；分别修正并经 27/27 反馈复验。失败原件保留。
2. `261030-1309-full-agent-qualified-merge-06c2`：416 项后中断，415 pass/1 fail。Claude 离线 89 回放在 12 环境并发下超过原 25 秒产品预算；固定 Python3.13.16 独立测量负载下 39.7 秒、无本任务并发时 15.6 秒，均完整通过全部回放。只将整轮并发预算降到 6 环境/12 CPU，不改源码、回放、25 秒预算或 gate；新建完整 run，无 resume。
3. 最终完整 run 内四个内置 Agent 离线自测均通过；Claude 89 回放整例 23.242 秒（包含 daemon 准备），其余 CodeBuddy71、Codex22、Cursor12 回放均通过。该离线超时与真实账户 403 分开记录。
4. 资源回收只操作 PID+birth 与租约 owner 核验过的本任务资源，无法核验归属的旧目录保留。历史红 run 和无效证据均未清掉或洗绿。
5. PR 的旧版 gh edit 遭 Projects classic 废弃接口拒绝，已用同一账号标准 REST API 完成描述更新；ready 动作没有重复。远端接收文件完成回执、正文 SHA256 与实际 PR 返回正文一致。

## 审查与回滚

Open 五个提交：957731c4 主体；ccb5fdd8 测试与冻结证据；a91f787f 桌面 stop 使用 40 秒 monotonic 等待并保留原断言；4448c7c7 在 shutdown 前记录既有 closing 意图、避免把预期关闭记成 AgentCrashed；5cd379b6 补齐完整连接成功 oracle、实际目标归属与服务 FIN。真正 Agent 崩溃的负例继续通过。每个提交均经 modify-review 全批次封印与受控提交；未直接 git commit。

主干与 patch 核验（工作区资料：`spaces/dev-3/final-main-compatibility.json`，未纳入本仓）、PR ready / CI 状态（工作区资料：`spaces/dev-3/final-pr-merge-readiness.json`，未纳入本仓）、PR 正文摘要核对（工作区资料：`spaces/dev-3/final-pr-ready-bodies-verified.json`，未纳入本仓）均保留。回滚前必须保全升级后的新增会话与输入；源码可 revert，实际发布后的回滚还必须使用匹配组件/客户端协议及升级前完整快照，不可直接让旧 format9 程序读取 format10 数据，也不可借旧受限设备备份重新授权。

提案 R1–R4 独立可靠性审计包不纳入本期完成口径。当前是 W1–W6 的可合入候选，不是产品已经发布，也不代表所有后续审计风险都已整改。

工作流 completed 回执（工作区资料：`spaces/dev-3/final-workflow-completed.json`，未纳入本仓）已由控制器接受，任务 `full-agent-simplification-implementation-20261030`；审计链保存在沿用的 release-beta 状态库。
