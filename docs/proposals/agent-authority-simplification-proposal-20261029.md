# GeneHub 完整连接与旧平台机制简化重构提案

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

- 状态：核心简化、本轮局部收尾和最新main集成已落地；最终Openaa7f7d7f / Cloud4b9b16e已提交推送，两仓干净、main为祖先、PR均clean，精确CI均success。最终RTC局部修复4/4 qualified feedback、原生640/640；历史失败和跨候选证据分开保留。当前为可进入授权合入的代码候选，未合并或发布。M5正式完整testctl merge资格未生成，不冒称提案全部发布验收通过；旧项目兼容及R1–R4不扩入本轮。见[最终收尾记录](full-agent-simplification-closeout-20261030.md)。
- 日期：2026-10-29。
- 源码基线：Open `9e511f347b9822153058104464b04d72d8c12d97`；Cloud `023c7d14744d6ee498823eaf6e4e03d33e9ecc33`。设计复查时 `git ls-remote` 核对两仓 `main`、`dev-3` 分别等于上述 SHA，dev-3 双仓干净。
- 适用范围：产品 daemon、CLI、Agent、workbench、host/WASM 边界、Cloud admission、测试与产品文档。开发用 PipeSpace、PipeBuilder、`spaces/*` 工作流不属于产品旧 Workflow，本提案不迁移它们。
- 本文取代[上一轮可行性分析](next-simplification-feasibility-20261029.md)的下一阶段建议；不改写已经合入的历史验收记录。

## 1 结论与用户体验

建议完整推进“连接认证后统一操作能力 + 旧 Workflow 执行语义退出 + 协议与数据收尾”，而非只删几个鉴权函数。可行，主要工作是理顺现有入口与迁移已有数据，不需要新建权限框架。

用户在手机上连接自己的机器，让 Agent 修改项目 B，Agent 工具已经能完成；同一连接直接修改 Space、读文件、使用终端时，却可能因设备 grant、workspace scope 或旧 managed 身份被拒。用户需要记住多套规则，开发也要在不同入口补例外。改后，获准驱动完整 Agent 的连接统一使用目标 daemon 的 OS 账号能力，跨项目操作不另申请平台权限。来源、路由目标和操作回执仍明确记录。

另一个场景是打开旧 Workflow 留下的会话：当前 UI 可能禁用输入，切换 Agent 被拒，继续运行还会注入旧 Workflow 提示。改后，这些记录可作为历史阅读；继续工作通过现有普通会话 fork 路径承接，不能重新激活已退役调度语义。

配对体验保持“生成链接即批准，扫码核销后连接”。新邀请明确表示机器 OS 账号级控制能力，不再让用户挑选一组互相矛盾的 grant。已有受限设备不会静默升级：升级时使其旧凭证失效，由用户按现有配对流程重新接入。

仅展示分享仍只能访问获准的预览与反馈。它不属于完整连接，不能因本轮简化获得会话、终端、设置或其他文件的能力。原生 Agent 的 plan/read-only 和凭证卡片继续表达用户交互意图。

## 2 复查纠正了哪些判断

| 上轮判断 | 本次结论及依据 | 方案影响 |
| --- | --- | --- |
| 设备 grants 整体是必须保留的真实边界 | `authz.rs` 将 Session、PTY、Settings 等拆开，但完整 Agent 已有间接执行能力；与安全模型 §0 冲突。未获得 Agent 的受限旧设备仍有迁移责任 | 退出普通完整连接的 grant 分级；旧受限设备失效重配，不自动全权 |
| 删除 ordinary 和项目检查就基本收口 | router 有双重 capability gate、Session 例外、managed 只读和 PM 开目录特例；endpoint 又有 workspace scope 和事件过滤 | 按入口、RPC、stream、推送、路由一并清理 |
| managed 可暂时只作展示 | workbench 用它关闭 durable input、控制只读；manager 用它限制切 Agent、注入 prompt/evidence scope | 旧数据必须先解除执行入口，随后移除运行字段；不能只改 Summary |
| PipeSpaceInfo 与旧配置迁移可以一起直接删 | wire 投影是派生冗余；`pipeSpaces` 配置却可能是旧树/组件的唯一记录 | 先无损转成 agentSpaces，验证保存，再移除活跃兼容模型 |
| Workflow 残留只有 proto/RPC/CLI | 还贯穿 Agent evidence 工具、adapter 能力、routing、旧请求 ID、UI 输入和数据来源推导 | 按消费链退出，不能只删除类型 |
| 只剩资源计数、真实浏览器等测量缺口 | 旧 browser 是协议 Client，native resources 已为 None；真正漏迁多会话、四阶段、工具循环和主动详情/预览请求 | 按实际 oracle 重建，不用历史描述代替源码 |
| 旧并发源码不存在，parity 永远无法补齐 | 本次 `git ls-tree 01b545a6 testing/deprecated/rust/tests/concurrency.rs` 找到 blob `5ce7671da508fd4384ea0e3c5440529bd362ffb5` | 可验证历史重建可行性；不承诺一定能重建原 artifact，也不修改无效 run |

以上是源码与 Git 事实核对，不是新一轮运行时回归通过证明。历史 run 的结果仅作追溯线索。

## 3 目标结构和不变量

沿用现有认证与身份模型，收敛为三种入口用途，不新增 RBAC、项目授权表或第二套 token：

| 入口用途 | 允许范围 | 生命周期与身份 |
| --- | --- | --- |
| 已认证完整连接：本地用户、会话控制器、配对设备、完整 hosted channel | 目标 OS 账号可执行的产品操作；项目/角色标签不降权 | 保留 actor/session/device、目标 machine、连接认证、撤销与过期 |
| 配对 bootstrap | 只核销绑定邀请并换设备凭证 | 邀请身份、单次消费、过期、不得提前调用普通业务 |
| PreviewShare | 既有分享范围内的预览和反馈协议 | share 身份、路径/版本/范围、过期与撤销；不接收普通推送 |

实现优先保留现有 `Principal` 来源变体，删除 `ordinary` 和 grant 数据参与操作决策的分支。在现有认证完成点建立可信身份，业务入口只处理完整连接、配对、分享的边界。不要将未知主体、认证失败或查不到的设备默认归入完整 channel。

必须保留：OS 权限、账号/机器归属、proof/抗重放、加密、撤销/过期、路径规范化、目录映射、输入与大小约束、资源容量、树结构不变量、CAS、幂等、进程身份复核、动作来源及错误回执。

必须区分：

- 连接有全能力，不代表替用户填写问题答案、读取或代交凭证、伪造 Human 决定。
- Agent 只读/plan 模式是用户选择的运行行为；旧 Workflow 的 parent/role/readOnly 不是当前平台权限需求。
- workspace 可以是路由默认目标、树归属和文件映射，不能继续作为完整连接内的项目 ACL。
- 操作权限不使目标对象自动存在，也不允许错机执行、越过分享范围、跳过 revision 检查或误杀复用 PID。

## 4 设计基线的实现与消费者证据

本节是顶部 9e511f34/023c7d1 设计基线的调查快照，不是当前待办。路径相对对应产品仓，现存文件链接指向当前 dev-3；行号与描述保留原调查时点。已删除对象不再提供失效本地链接，实施结果与最终 SHA 以验收记录为准。

| 面 | 基线事实 | 消费者与处理 |
| --- | --- | --- |
| 鉴权核心 | [authz.rs](../../apps/daemon/src/authz.rs)：12 种 Capability，GrantSet；Principal::allows 对普通/managed 控制器不同 | RPC、stream、事件推送、CLI authority；一起退出普通分级 |
| 本地 CLI | [transport/local.rs](../../apps/daemon/src/transport/local.rs):291–307 根据 managed 推导 ordinary | 去推导，保留 controller proof、会话存在与真实来源 |
| 二次授权 | [router.rs](../../apps/daemon/src/router.rs):145–570 的 gate、session_exception、PM/managed/project 辅助函数 | 删除角色/项目能力判断；拆出交互语义与结构校验 |
| Space 操作 | router:2528、2556；AgentSpaceChangePlan/Configure 均调用 management_project | Device/Channel 即使拥有 Settings 仍可能被只认 LocalUser/SessionController 的函数拒绝；完整连接统一 |
| 远程 workspace scope | [endpoint.rs](../../apps/daemon/src/dataplane/endpoint.rs):1258 起按 scope 拒绝目录配置、进程列表、其他 workspace/parent | 完整 channel 只保留目标定位；分享另行保留范围 |
| stream 与推送 | endpoint:1109 起 stream gate；frame_requires/filter_agent_logs；[exec.rs](../../apps/daemon/src/dataplane/exec.rs)、[file_read.rs](../../apps/daemon/src/dataplane/file_read.rs) 各有范围/grant 分支 | 不能仅改 RPC；撤销后现有 stream/推送也要停止 |
| PTY 隔离策略 | [isolation.rs](../../apps/daemon/src/isolation.rs):42 由 PtyUnconfined 决定；native/guest/host 均有包装接线 | 移除设备分级驱动的隐式 confinement；OS/用户显式模式不因此取消 |
| Cloud 准入 | [store.ts](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/store.ts):1325–1400 返回 principal、workspaceHandle、localWorkspaceId；[peer-admission.ts](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/peer-admission.ts) 核验目标机器凭证 | 保留账号/机器与 route 绑定；分开定位字段和执行范围 |
| RTC/恢复 | [logical_registry.rs](../../apps/daemon/src/dataplane/logical_registry.rs) 保存继承身份、scope、expiry；[handshake.rs](../../apps/daemon/src/dataplane/handshake.rs) 校验 proof | 继承原认证用途，不随载体变化重新授予完整权限 |
| 旧会话执行 | [manager.rs](../../apps/daemon/src/session/manager.rs):646 managed 创建；2727、3206 注入旧 prompt；3213 传 evidence_scope；3713 限制 Agent 切换 | create_managed 本次全仓搜索只发现定义及内部转调；历史读取仍活跃，分开退役 |
| 前端旧锁定 | [WorkbenchApp.tsx](../../packages/workbench/src/app/WorkbenchApp.tsx):261、290、960、1064 | managed 关闭 durable input、显示只读并限制交互；SessionPicker 仍显示旧角色 |
| Agent evidence 链 | [adapter/genet.rs](../../apps/daemon/src/adapter/genet.rs):278；`apps/agent/src/tools/evidence.rs`（设计基线对象，现已删除）；tools/mod.rs:252 | GENEHUB_EVIDENCE_SCOPE 改工具集，含退役 workflow 命令；不是普通 plan 模式的同义词 |
| PipeSpace 投影 | [domain.rs](../../packages/proto/src/domain.rs):508、542；workspace.rs:1374；agent_space.rs:360 | 当前 TS 业务读取主要命中 composition-boundary 的旧形态断言；移除前复核所有运行客户端 |
| 配置升级 | [config.rs](../../apps/daemon/src/config.rs):295、356 把 pipeSpaces 转 agentSpaces，已有 agentSpaces 优先 | 当前不是双写；保留一次性导入能力与备份，不能直接丢旧输入 |
| 协议壳 | [rpc.rs](../../packages/proto/src/rpc.rs):149–344 的 workflow 请求及 SessionFlow；router:948–970 统一 workflowRetired | 无执行引擎；移除会改变旧客户端错误形态，需版本约束 |
| CLI 消费 | [cli_front/project.rs](../../apps/daemon/src/cli_front/project.rs) 遍历 managed parent；query.rs 仍描述旧 Reply；mod.rs 返回 workflowRetired | 保留正常默认项目解析和显式 workspace 选择，删除旧父链解析 |
| UI 权限残留 | [ProviderConfigurationCard.tsx](../../packages/workbench/src/settings/ProviderConfigurationCard.tsx):47 读 authority.grants.settings | 只改服务端会留下禁用按钮；改为完整连接及交易状态判断 |
| 团队旧名 | `expert.py`（设计基线对象，现已删除） 转发 team.py；多个 TS journey/specialty 仍调用旧名 | 不是无消费者死代码；迁移测试、新模板和已有 hook 后再删分发壳 |

## 5 具体改动与可行性

### W1 统一完整连接的权限判断

删除 SessionController.ordinary、普通 Device 的逐项 grants 决策、router.session_exception 及 PM/managed 开目录授权特例。完整连接成功进入既有业务 dispatch；Pairing 和 PreviewShare 的明确 allowlist 保留在现有入口。

`authorize_project_mutation`、`authorize_agent_space_change` 不再按调用角色或项目相等判断。`agent_space_management_project` 中“允许某个项目 PM 挂接新子 Space”的授权绕行退出；目标树解析移回既有结构路径。循环、parent 存在、合法 component、revision 和 plan digest 仍由既有校验负责。不得把删除整棵 Space 树约束算作权限简化。

`caller.authority` 保留真实身份和业务操作说明，移除用于逐能力禁用 UI/CLI 的 grants 字段；providerOperations 若仍服务凭证事务说明，应描述具体业务动作，不再作为另一张 capability 表。同步 CLI help/schema、查询输出、ProviderConfigurationCard 和内置 Skill，不保留第二份硬编码完整 grant 清单。

风险中：改动集中但入口多；必须同时验证 Device、Channel、SessionController 的 Space 修改成功，而不只测 LocalUser。

代表性协议输入（已有操作类型，目标语义为拟议变更）：`{"type":"session.send","payload":{"sessionId":"session-in-project-b","messageId":"simplification-example-001","text":"继续处理"}}`。来自项目 A 的已认证完整控制器应进入正常 durable input 路径，返回现有接收回执；后续以同一 message/action 标识查询处理结果，不能把接收回执当 turn 完成。目标不存在仍返回现有 notFound；revision 冲突仍返回 revisionConflict；配对/分享调用则在业务入口拒绝。最终字段以 proto 生成 schema 为准，实施前用 CLI schema 核对，不新增发送协议。

### W2 退出 grants 与隐式设备沙箱

新 `device.invite` 不再接收 scope/grants；CLI 移除 `--grant`，设备列表展示身份、连接、最后活跃与撤销，不再展示能力等级。旧请求若仍带 scope，返回可操作的“不再支持受限邀请，请使用完整配对或现有预览分享”错误，不能忽略参数后发全权邀请。版本切换前用原始 JSON 层识别旧字段，避免 serde 忽略未知字段造成静默扩大权限。

旧凭证按升级前的 GrantSet 解释器分类：

| 旧状态 | 升级行为 |
| --- | --- |
| 已有默认全权设备，以及版本化旧 full 形态 | 保留设备 ID、secret、名称、撤销语义；去分级数据 |
| 显式受限设备，含只有 Read/Files，也含有 Session 但缺其他 grant | 在放行业务前使旧凭证失效，记录不含 secret 的迁移摘要；提示重新配对。不能因“已有 Session”静默升级 |
| 未核销的受限邀请 | 失效；新生成链接明确完整能力 |
| 损坏、未知形态或无法确认权限的设备数据 | 报错或隔离原文件，保持拒绝；不当作 full |

迁移使用现有私有原子保存；失败时不发布新的内存设备表。迁移发生前断开相关旧连接，RTC 与 resume 不得继续使用旧身份。备份和摘要不写入公开诊断或工作区文件。

新完整连接不再因缺 PtyUnconfined 触发隔离包装或拒绝绝对路径 `file.read`。保留文件 API 的映射、规范化、私有目录保护和分享路径限制；本期不新增一个任意 OS 文件浏览器，`file.read` 已有的机器路径能力则与完整连接对齐。

移除隐式 confinement 策略后，逐条检查 `isolation.rs`、process.launch_argv、native confine、CLI/host wrapper、WIT 与 WASI binding 的生产调用。仅为退役设备策略服务的接线应在 guest/host 同批移除；有独立、用户显式用途的原生机制保留并写明消费者。不能只删 guest import 就破坏 host ABI，也不能将这些代码全靠改名留存。

风险中高：旧受限设备会被要求重配，这是明确的升级体验变化。无新增授权等级或迁移开关。

### W3 分开 hosted 路由定位与执行权限

Cloud 仍验证来源 endpoint/session、账号与目标机器归属、一次性 route ticket、目标兑换凭证和有效期。workspace catalog 的 handle/placement 用于选中正确机器和默认项目，不因本轮简化开放其他账号或任意机器。

完整 hosted channel 到达选定 daemon 后，删除 endpoint/exec 的跨 workspace、父 Space、目录设置和进程列表权限拒绝。保留 workspaceHandle 与本地 ID 的映射，避免把 Cloud handle 当本地 workspace ID；所有显式目标必须在该 daemon 存在。跨机器仍通过既有连接准入，不能把其他 machine ID 填入请求绕过认证。

PreviewShare 的范围继续由 share principal、既有 share 记录和预览/反馈校验决定。不能仅把所有 `PeerAccess.workspace_id` 清空：这会同时丢掉定位信息并威胁分享范围。优先复用现有 principal 区分用途，给现有 scope/locator 字段明确单一含义，避免新建 scope 服务。

同步 RPC、shell.run、file.read、asset.preview、service.preview、events 和事件 fanout 的入口判断。完整连接删除逐 Capability 的 `frame_requires`/日志裁剪；分享仍不接收普通 fanout，配对不能开业务流。RTC、secondary lane、断线恢复继承身份、用途、有效期及撤销状态，不能从“有传输”推导“全权”。

过期/撤销的验收须覆盖已经打开的长流及推送，而非只调用 handle_rpc。源码中已确认 RPC 有 expiry 检查、设备有 revocation 监听；所有载体下的停止时机需实测，不把源码存在等同全链路已经正确。

风险高：涉及 daemon、Cloud、web/RTC，需成对候选和跨载体验收；无需重写 Fabric。

### W4 旧 Workflow 会话退出执行并保全历史

先删除无当前调用方的 create_managed/create_managed_named 及旧 WM 授权例外，再处理历史数据。普通完整连接跨项目操作普通会话不再受旧 parent/role 限制。

旧会话不直接抹掉 managed 后原地当新会话续跑：它可能有 managedSystemPrompt、evidenceScope、待处理 workflow-human 请求和旧 native continuation。直接去限制可能让受限分析会话意外变成执行会话，或把废弃指令再次注入 Agent。

推荐复用现有历史阅读与 fork 能力：旧 managed 记录保留只读历史，可导出和 fork；fork 继承可展示叙事及来源关联，创建普通会话，清除旧执行控制、evidence scope、managed prompt、待处理旧调度义务与 native continuation。不得把旧系统 prompt 伪装成人类消息，也不把旧 queued/sent 输入自动复制重发。旧会话页面清楚提供“从此处继续”，不再呈现一个会永远被旧 Workflow 锁住的可编辑输入框。

为避免永久保留另一套运行时，旧元数据读取集中到已有 Store 的历史格式读取路径：运行态 Meta/SessionSummary 不再携带 ManagedSessionInfo，旧原始文件留在私有备份。历史转换沿用现有时间线、lineage 和 fork 数据结构；只读历史的展示与禁发逻辑复用现有导入历史组件。现有 imported 字段专指 Agent 原生历史，不能给旧 Workflow 伪造该来源；如需 wire 表达 fork-only 历史，仅在现有会话摘要增加通用 continuation 可用性信息，不新增角色或授权状态机。该信息来自历史格式/原生恢复能力，普通会话不受限制。新 fork 保留原 session/round/trunk 关联，旧 ID 与历史内容不重编号。格式版本按 Store 既有规则更新，防止旧 writer 丢掉新迁移标记。无损映射原型须在 M0 验证；保留的最小旧格式读取器要列入明确保留项，不能假报零残留。

原生 Agent 模式和 imported.continuation=ReadOnly 的真实不可续跑限制保留。删除 managedReadOnly、managed 导致 durableInput=false、旧切 Agent/自动 failover 特例、project.rs 父链授权推导和 Workflow UI 文案；普通会话能力跟随原生 Agent catalog。

`sourceKind` 的 automation 不能因去 managed 变成人类。迁移至现有 `SESSION_STARTED_LABEL` 等来源机制，保留真实动作来源；旧父子关系作为历史关联，不再决定权限。

Agent evidence 工具链只为当前产品有真实用途时保留。当前搜索显示旧 managed 负责注入 scope，工具还包含 workflow.complete 等退役命令；先验证是否有独立的 evidence-only 用户入口。没有则随旧执行链移除 routing evidence_only、adapter.require_evidence_scope、GENEHUB_EVIDENCE_SCOPE 注入和专用工具。独立 plan/read-only 工具选择继续保留。host/update supervisor 的环境清理若仍防止旧环境串入，可保留明确迁移用途，不把它误判为旧引擎。

风险高：主要在旧数据、提示和恢复义务。完成条件包括“旧历史可读、fork 可工作、不自动重发旧动作”。

### W5 删除死协议与冗余 Space 投影

删除全部 `Request::Workflow*`、对应 Reply、仅由它们使用的 Workflow domain 类型、SessionFlow/ExecutorFlowStatus、TS bindings 和 CLI Reply 名称。删除 CLI workflowRetired 专用分支后，旧命令按正常未知命令处理；旧 wire 请求按版本/未知操作错误处理，不再永久占据协议枚举。

协议变更必须走现有 WebProtocol/兼容校验与生成流程，客户端不兼容时在业务前提示升级。生成 bindings 从 Rust 源再生成，禁止直接编辑。先处理 W4 数据读取依赖，再删除共享的 ManagedSessionInfo/SessionUserInteraction 等类型；不能连带删掉原生 Permission/Plan/Question 类型。

`WorkspaceInfo.pipeSpace`、PipeSpaceInfo、describe_legacy 和 UI/CLI/测试占位一起移除，只保留 `agentSpace`。`pipeSpaces` 旧磁盘输入则先原子转成 `agentSpaces`：已有新条目优先、parent/lifecycle/workerRole→component 不丢失；保存失败继续保留原文件并报错，重试不重复挂载。可使用同包一次性升级工具，不在活跃 Config 中永久双模型。旧平台目录和 Workflow journal 不自动删除。

风险中：wire 层切换可控，历史数据导入不能与“删除冗余投影”混为一个机械删除动作。

### W6 团队与测试兼容壳收尾

新模板、Skill 和 TS 用例统一调用 `team.py`。`expert.py` 不能在未知旧团队仍引用时直接删除；利用已有团队升级命令识别产品生成的 hook/脚本引用，备份后替换为 team.py，保留 hook ID、节奏、message/action ID 和业务文件。用户自定义脚本只报告位置，不作全盘文本替换。

删除新分发包中的 expert.py 前，验收旧模板生成的团队升级、hook 执行和一次结果通知。已有团队副本中的旧 shim 可作为用户数据保留，不能由 daemon 启动强行删掉。当前多个 journey/specialty 仍以 expert.py 为动作面，必须实际迁移；只改测试标题不算完成。

CLI 的 `apps/cli/tests/remote.rs` 仍使用 genehub-testing 的 MockLlm/agent_command_override，不能宣称旧 crate 只剩无消费者链接。逐条将业务事实迁到现有 TS 公共 CLI/client 测试；Rust/ABI 内在性质另行论证。完成后移除 CLI dev-dependency、活动 legacy helper crate、workspace/lock/CI exclude 及断言“必须仍有 crate”的测试；历史证据归档，不恢复通用 Rust runner。

风险中：不要求团队机制退役，也不修改开发 PipeSpace。此项可独立提交，但不能在总完成声明中遗漏。

## 6 测试证据与旧缺口怎样闭合

当前 `testing/migration/rust-parity.json` 有 92 个 cases：84 retired、6 release-only、2 suspended，另有 2 个 openGaps。标签数不是完成度。历史 run 失效不能修字段后变有效，当前 TS 成功也不能倒填成同源码/artifact parity。

| 义务 | 现有线索 | 本期处理及完成条件 |
| --- | --- | --- |
| 并行工作区与会话规模 | 当前 TS 每 workspace 一个 session、一轮；旧 moderate 是 10×(1 主+1 analysis)=20 session，heavy 是 20×(1+2)=60 session，max 是 20×(1+3)=80 session | 查清原 gate 使用哪个 profile；同 profile 对齐活跃 session 数、实际并发在途和完成；模型请求开始/释放屏障证明负载重叠，防止前一轮已结束后才发 canary。不以 workspace 数相同声称负载相同 |
| 阶段与工具负载 | 旧 case 运行 cold、warm、passive-reader、owner-only 四阶段，并断言各阶段完成、tool detail 数与模型请求/工具循环相符 | 使用确定模型脚本重现工具真实副作用、工具详情与各阶段；仅延迟纯文本回复不足以接管 |
| 4/8 observer 与主动交互 | 旧所谓 browser 为 Rust `Client::connect_loopback`，poll_browser 轮换会话、subscribe/unsubscribe，访问 session.list、file.tree、asset.preview、trunk 与 tool detail | 用生产 Node client 复现客户端数、20ms/10ms/饱和 profile 的请求节奏及各类调用确实发生且无失败；当前全会话被动订阅不是等价。真实浏览器仅服务新增页面事实，不作为旧 parity 的硬前置 |
| native_resource_count | 在已恢复的 `01b545a6` 源码中三处都是 None，无资源计数断言 | 这是旧观察口已退出，不列为本行尚缺 oracle；若追踪泄漏，在独立资源专项中用 OS 事实验证，不虚构私有计数 |
| 阻塞 canary | slow-model-unrelated-reads、slow-git-unrelated-reads 有 TS 对端；旧 case 还记录 128 并发 preview、暂停接收/恢复 | 关联同候选有效 run；补 preview 洪泛的公开输入与恢复事实。旧暂停段是观察报告，不要求复现全局卡死；保留慢 Git 的 <500ms 等实际断言，改阈值须说明依据 |
| Rust parity 同输入证据 | 原 run inputDrift=true；Git 历史仍有源码 | 先验证在受管槽重建冻结测试/共同基线产物的可能性。Git 有源码不等于旧 artifact 已恢复；新建 run 保留旧失败，不永久恢复 runner |
| 若无法形成现行 L13 要求的证据 | 当前 governance 绿并不消除义务 | 继续明确未完成，不计 retired；若拟改证据标准，另走独立治理变更、说明风险与迁移，不能借产品权限契约暗改 L13 |
| Claude 六条 release-only | 历史记录账号 403；本轮未探测账号 | 可在正常已授权环境重验；仍不可用则 blocked，不能把 release-only 当通过；补查子任务隔离对端与断言 |
| OpenCode 两条 suspended | 已退役能力历史 | 保留暂停归档及恢复条件；不当作待运行产品能力，不新造批准记录 |

不把“测量项”作为自动删测试的理由；先说明它防的用户故障、替代事实、阈值和对应 gate。只有证据或明确治理处理收口后，才删除 openGap 活跃占位；归档保留 oldId→TS IDs、源码/制品、输入、故障与结果的映射。

测试设计沿用 [P01–P13](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/docs/testing/engineering-principles.md)、[L01–L16](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/docs/testing/engineering-laws.md)。本次完整读取组合 SHA256：`858b019bf276806b7903cd7029fd40560c790116f1bc9a4632edca8ca41550bd`。本轮未编写或运行业务测试；实施测试任务须重新核对适用版本与接口就绪门。

## 7 用户交互与凭证事务保留什么

保留 SessionAsk、Question、PlanApproval、工具 Permission 和 ProviderConfiguration 的现有产品交互。它们表达“谁在请求用户做什么”，不再包装成能隔离同 UID Agent 的安全等级。

- Agent 可发起自己会话的问题和 provider 配置计划；不得通过换 actor 或把自己的回复伪造成 Human 决定。
- provider 的 prepare/submit/verify、action ID、baseline CAS、密钥私有存储和日志脱敏保留。UI 不再依赖 settings grant；SessionController 的专用交互错误清楚指向已有卡片。
- 对“只允许在本会话提问/配置”的判断逐项说明业务目的：防止把问题投进错误对话、绑定卡片和幂等事务。保留这种目标约束，不扩大成项目 ACL。
- 不全局删除 consulting/continuation：router 的旧 PM consulting 授权限制可退出，但正常 HumanContinuation、inbox、更新续接与结果回执仍有当前消费者。

`managed_update` 是软件更新续接，GitHub Actions workflows 是 CI，dataplane 的 grants/credit 可能表示流控额度；这些名称不能成为批量删代码的匹配条件。

## 8 分期依赖与连续交付

| 阶段 | 工作包 | 独立成果和依赖 | 出口要求 |
| --- | --- | --- | --- |
| M0 基线与迁移输入 | 凭证形态、旧 meta/config、Cloud/workbench 消费者清单；确认测试环境 | 明确活跃调用/历史输入/生成物，固定双仓 SHA | 旧受限凭证与分享样本均纳入迁移验收；环境缺口有实际探测结果 |
| M1 完整连接能力归一 | W1 + W2，连同 UI/CLI 与设备迁移 | 去 ordinary/grants 和 PM 授权特例；旧受限凭证不升级 | 本地/设备/会话控制器成功；撤销、bootstrap、分享拒绝；设备升级原子失败测试 |
| M2 hosted 路由与载体对齐 | W3，依赖 M1 的入口语义 | hosted 默认项目保持，跨项目成功，RTC/恢复不变更身份 | Cloud + daemon + 浏览器成对验证；长流撤销/过期和分享边界通过 |
| M3 旧数据与协议退出 | W4 + W5 | 旧会话只读历史/fork、旧配置导入；活跃 Workflow 类型与 PipeSpace 投影退出 | 迁移幂等、故障恢复、正常会话输入/切 Agent、协议版本行为通过 |
| M4 团队与测试收尾 | W6 + §6；可在前序契约稳定后独立推进 | team.py 单一新入口；legacy helper 与 openGap 按证据收口 | 旧团队升级、hook、TS 接管和治理证据通过 |
| M5 最终候选 | 所有目标阶段固定后 | 双仓候选、生成物、文档、迁移和回滚清单一致 | 受影响验证与适用完整 merge gate 获有效资格；所有未覆盖项明确 |

阶段不作为反复询问“要不要继续”的人工等待点。后续获准实施后按依赖连续推进，失败保留证据、修复后重验。本文本身不授权运行时代码实施、发布或迁移真实用户数据。

不沿用上轮无测量支撑的“0.5 天/3–5 天”精确估计。M1 中风险，M2/M3 高风险，M4 中至高风险；先用 M0 的真实消费者、数据样本和构建结果确定批次，不以删除行数当进度。

## 9 验收矩阵

所有结果绑定最终双仓 SHA、artifact hash、policy、实际 case 集和平台。现有名称是可复用的测试起点，缺失 oracle 必须补齐，不能靠名字宣称已覆盖。

| ID | 输入与动作 | 可观察结果 | 现有基础或新增范围 |
| --- | --- | --- | --- |
| A01 | LocalUser/SessionController/Device/hosted 分别操作项目 B：建/发/停会话、改 Space、文件/Git/PTY/设置 | 各入口成功且 actor/目标正确；OS 拒绝正常返回 | agent-session-control-parity、agent-hosted-machine-access、composition-boundary；补 Device/Channel Space 成功 |
| A02 | 未认证、错误 proof、错账号、错机器、重放票据、bootstrap 发业务请求 | 无业务副作用；票据/邀请只按原规则核销 | admission/handshake/remote identity、Cloud peer-admission/workspace-fabric |
| A03 | 设备撤销与 hosted 过期时保持 RPC、下载、PTY、preview/events、RTC/resume 活跃 | 拒绝新动作并终止相应访问；无重新认证的静默恢复 | revoke-stops-acting、device-depth、connectivity；补长流覆盖 |
| A04 | PreviewShare 尝试列会话、终端、配置、外部文件、改 scope、RTC/续连 | 只获既有分享预览/反馈，其他请求拒绝，无普通事件泄漏 | preview-sharing、preview-file-feedback、registration churn |
| A05 | 升级 full、窄 grant、未知形态、旧邀请、损坏 devices；迁移中注入保存失败 | full 不掉线或按升级重连；受限/未知不全权；备份与重试不丢设备 | device-state-depth；新增真实旧数据升级旅程 |
| A06 | 新客户端带旧 scope/--grant；旧 WebProtocol 调新 daemon | 明确升级/参数错误，不忽略参数签发全权；握手不进入不兼容业务 | CLI schema/contract 与协议兼容测试 |
| A07 | 旧 managed 正常/只读/evidence/缺 parent/待处理请求，查看并 fork | 历史保留；新普通会话能完成真实任务；旧 prompt、未完成副作用和令牌不被复活 | Session 历史/fork/来源旅程；新增旧格式样本 |
| A08 | 普通会话切 Agent、durable input、用户问题/计划、provider 卡片取消/提交/重试 | 没有旧 Workflow 锁定；交互身份与 CAS/幂等正确，密钥不入日志/历史 | interaction-boundaries、provider-configuration、provider-self-bootstrap |
| A09 | 旧 pipeSpaces 混有新 agentSpaces、重复 ID、非法 parent、写失败；重复升级 | 新条目优先、结构不丢、失败保原件、重试不重复；新 wire 无 pipeSpace | composition-boundary、space-tree、配置故障钉子 |
| A10 | 旧团队生成后升级、用户自定义 hook、team.py 发工作并反馈 | 产品 hook 不重复，用户编辑不误改，front 收到一次归属正确的结果 | expert-collaboration/reflection、team-identity-build-hooks；迁移动作名 |
| A11 | 多会话四阶段工具负载、主动详情/预览轮询、慢 Git/模型、暂停预览输入/恢复 | 会话隔离、每阶段工具副作用与完成、请求种类/节奏、无关响应与恢复可核对；parity 证据可追溯 | parallel-workspaces、control-plane-liveness、connectivity 与 §6 补证 |
| A12 | Linux/macOS/Windows，native daemon 与 WASM guest/host，PTY/exec/关闭 | 不因移除 grant 策略破坏 host ABI、尾部输出/背压/清理或 OS 权限 | 平台 CI/真实 host；单机 guest pty-echo 不能代替 Windows/native |

旧 invite-read-only、no-pty-grant-no-bytes、files-grant-preview、confined-pty-or-refused 的能力分级断言需要迁移为新合同，不直接删除整条用例。保留其中配对、隔离分享、撤销和字节泄漏的独立事实，明确旧合同已退出的部分。

验证顺序：生成绑定/版本检查、相关 Rust build/check、web/testing typecheck、治理/lint → 定向真实 artifact 测试 → 最终完整 merge gate。完整 gate 的条件从当次 testctl plan/preflight 取得，不硬编码旧“760 条”。历史收尾记录里的 unshare/远端机/Python 依赖缺口需要实测；缺失是 blocked，不是通过，既有 main CI 不被本提案声称为当前绿色。

## 10 迁移发布与回滚

代码按业务/测试/治理职责形成可独立审查提交，生成物随源定义同步。发布沿用现有产品版本和兼容策略，不添加长期 legacy 模式开关。先验证迁移器可用，再切新写入和删除读依赖；Cloud/daemon/web 协调发布，旧方不能误把分享或受限凭证当完整连接。

磁盘迁移先备份、验证、原子替换，再发布内存状态；保留设备/配置/旧会话的私有原件与迁移摘要。不要在 daemon 启动时遍历所有用户项目改 hook、删除 Workflow 目录或覆盖团队编辑。

回滚不仅是 git revert：新格式数据先检查旧版本是否能读；否则恢复对应私有备份再启动旧程序。已失效受限设备凭证不能因恢复备份自动重新启用，设备仍按重新配对处理。fork 后的普通会话和新输入不能被旧快照覆盖；回滚前保留新增数据并验证可读性。旧客户端版本恢复不得导致分享全权化。

本次不执行发布、App 构建、daemon 重启、真实设备失效、团队升级或主干合并。

## 11 可靠性后续项与本期边界

完整方案需要交代这些遗留项，但不能把每个审计条目自动变成权限框架的依赖。以下是后续独立工程包，不计入本提案核心 M1–M3 的完成量；若实施变更触发对应路径回归，则必须当期修复。

| 后续包 | 问题与可行路径 | 独立完成事实 |
| --- | --- | --- |
| R1 进程生命周期 | stdout EOF 唯一退出信号、退出后组身份与总预算等；沿用现有 child wait/进程注册复核，不新建守护层 | leader 已退出而后代持 stdout、PID 复用、超时 cleanup、native/WASM Windows 均正确，不误杀 |
| R2 会话存储恢复 | 损坏 meta、检查点/索引/字节引用、fsync 写入成本；保留坏原件，仅从有事实的数据恢复 | 崩溃与写失败不丢已承诺数据，不生成伪造历史；在目标盘测 p50/p95 与写放大 |
| R3 模板分发 | 产品包与用户定制归属混合、覆盖非原子；复用现有安装/团队升级入口，不启动时全盘修复 | 单文件失败可恢复，模板可用，定制可找回，升级不重复 hook |
| R4 controller proof 生命周期 | 现有凭证用于真实来源认证，不为角色分级服务；是否绑定进程需单独验证重启/长会话/延迟 hook | 旧实例不再冒用，正常长会话与 hook 不掉线；不新增固定过期后无人能续期的 token 层 |

此前审计报告同时包含“后续已修”和旧风险描述，不能整表当当前事实。可靠性包开工前按当前 SHA 复现；本提案没有重新确认所有旧风险仍存在。

## 12 替代方案与完成口径

| 方案 | 代价与结论 |
| --- | --- |
| 只删除 ordinary 与几个项目比较 | 改得少，但 Device/Channel Space、hosted scope、旧 UI/数据/stream 分级还在，无法满足一致体验；不采用 |
| 保留 grants 并使 Session/Pty 隐含所有 grant | 表面兼容，仍保留能力表、闭包推导和旧邀请歧义，新增能力继续漂移；不采用 |
| 所有旧设备与旧会话直接全权继续 | 代码最少，静默扩大受限设备权限、复活旧 prompt/义务；不采用 |
| 先隔离每个 Agent，再保留项目 ACL | 改变产品定位，涉及 OS/container 设计，不能作为本次简化的必要条件；不采用 |
| 本提案：完整连接统一、分享独立、旧受限凭证重配、旧执行归档/fork | 有一次升级成本，能实际删除运行分支并保护已有数据；推荐 |

本期无需再决定“要不要新增项目 ACL”。需要评审的是具体迁移体验：受限设备重新配对、旧 Workflow 历史从 fork 继续、旧参数与协议的升级提示。若不接受这些体验，应调整对应迁移批次，不能暗中保留一套未说明的运行权限模型。

实施前验证项已经落到 M0：旧字段真实样本、独立 evidence-only 消费者、host ABI/旧客户端兼容边界、同输入 parity 重建可行性、旧 load profile 与可用测试机器。这些是可调查事项，不以泛称“需产品设计”搁置，也不阻止无依赖的清理。

完成报告分四个结论给出：

1. 核心权限迁移完成：M1–M3 的删除与 A01–A09、A12 对应证据齐全。
2. 兼容与测试债务完成：M4 的团队、helper 与旧证据义务逐条闭合；未闭合则明确未完成。
3. 可以合入/发布：最终候选相应 gate 的资格有效，未覆盖项按既有流程处理；提案评审或定向通过均不能代替。
4. 全部审计整改完成：只有 R1–R4 等独立后续包各自验证后才能宣称。本期不使用这个总称。

本提案在2026-10-29初稿时尚未实施。Human随后授权完整推进；当前源码、重建对照及门禁状态统一记录在 [实施记录](full-agent-simplification-progress-20261030.md)，不以设计结论代替实际资格。
