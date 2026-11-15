# 完整连接简化实施状态

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

目标：提案 W1–W6 落地，保留当前 team 行为，产出最终可合入候选。未授权合并或发布。
状态库：release-beta/.agent-workflow，任务 full-agent-simplification-implementation-20261030，执行上下文 dev-3。
基线 Open c1ba53e388 / Cloud 023c7d147。产品仓修改开始前已登记 executing。

## 最新状态（后文保留时间顺序的历史记录）

W1–W6 已实施并完成最终验证。Open5cd379b67c1593df3b8dc04e201d4535a7618dc7 / Cloud66f379458728a2741e6d841183d49b5d25336dbe，双仓干净、已推送。
完整merge gate `261030-1343-full-agent-reserved-merge-6644`：775/775、gate/scope均为完整merge、qualified=true、inputDrift=false、进程/端口泄漏0，7类执行产物前后逐文件相同。最终Windows/macOS等CI已通过；两仓PR均ready、MERGEABLE/CLEAN，main为候选祖先，未合并或发布。
历史红run保留；旧并发/CLI冻结比较实际执行，openGaps=[]。team协作、hooks、远程委派和200会话/80观察者混合负载均通过。真实Claude release-only账户403仍blocked，不计通过。完整证据与升级/回滚边界见[最终验收记录](full-agent-simplification-final-validation-20261030.md)。工作流控制器已接受 completed（validated-candidate），回执 final-workflow-completed.json。

## 验收约束

- team Space/组件/角色/默认项目/委派/hook/一次回报保持，删除的是旧 Workflow 授权。
- 完整身份成功，配对/分享/撤销/过期仍正确；旧窄设备不静默扩大权限。
- 不把定向通过或 preflight blocked 当完整 merge 资格。
- 业务与测试/治理分别形成可审查提交；受控 review/commit 后才是候选。

## 测试工程前置

已读取 Cloud principles/laws，组合 digest 858b019bf276806b7903cd7029fd40560c790116f1bc9a4632edca8ca41550bd。
适用 P01–P13：均适用；L01–L16 均需检查。分类 specialty/journey（公开 CLI/client 驱动真实 daemon，只替换 LLM endpoint），不新增 Rust 业务测试或 bridge。
动作入口现有 CLI、公开 client/daemon；产品消费者 web/CLI/team scripts。构建与真实 artifact smoke 待实施验证后补充。
P10/L08/L10/L13 风险：历史无效并发证据不能复用；缺完整门禁环境不能报通过；旧 Rust 测试需逐条接管。

## 实施进度

- W1–W6 代码与测试证据已审查提交：Open ccb5fdd86ab567501be1d5764197a63402e72b75；Cloud 66f379458728a2741e6d841183d49b5d25336dbe，均已推送 dev-3。
- Open 两个提交957731c4/ccb5fdd8，Cloud66f3794，双仓干净；没有合入主干或发布。
- 完整 merge gate `261030-1158-full-agent-final-merge-d388`：775项正在执行，未提前宣称资格。Windows/macOS CI 待 PR 触发结果；当前交付仍 validating。

## 2026-10-30 实跑记录（继续推进中）

- 当前候选仍未提交；不得视为可合入最终候选。
- daemon 643/643、proto 263/263、workbench 857/857；TS typecheck 通过。原生 workspace 测试清理外层 Agent 身份后，CLI contract 7/7，remote 6/7；剩余断言在 forget 后的 Hub 发现错误码，与身份不匹配拒绝无关，正迁移该行为。
- `261030-0930-authority-migrations-c5c5`：7 passed / 1 failed，inputDrift=false。失败为新历史 fixture 读取事件 turn ID 的形状错误。
- `261030-0941-team-migrations-b6d9`：7 passed / 1 failed，inputDrift=false。team collaboration、hook 名迁移、Agent 本地/hosted 控制与来源、Space 组合、旧配置迁移、身份重启恢复、旧协议拒绝通过；历史拒绝返回 internal，已改为 badRequest。
- `261030-0945-history-concurrency-5aac`：history passed（含 fork 后真实工具副作用），concurrency blocked（调度资源预算不足）；不计为 gate 通过。
- `261030-0947-concurrency-scale-33b6`：20/60/80 session、4/8协议观察者、四阶段工具循环、主动轮询、模型开始/释放屏障，正在运行；运行期间保持源码冻结。
- 已用独立 Python 3.12 venv 安装 aiohttp，补齐 preview-media 测试依赖。Linux namespace 与真实 WAN 测试依赖仍按实际机器探测结果处理，不绕过预检。

### 新的闭环证据与后续动作

- `261030-1000-concurrency-profiles-30b3`：3/3 passed，feedback qualified=true，inputDrift=false；20/60/80 会话均完成四阶段，4/8 observer 主动轮询、详情/预览及工具副作用，模型开始屏障证明在途重叠。后续为对齐冻结旧 full session.list，将该调用设 lean=false，需在共同基线再跑 moderate。
- `261030-1000-remote-contract-retry-ece7`：7/8 passed，inputDrift=false；后台执行与 missed-event replay、精确 CLI 字节、shell stdin/stderr/timeout、offline、stale identity/forget、跨项目 Agent/hosted/Device 成功。唯一失败是新测试期待 machineNotPaired，实际与旧 Rust 一致为 credentialRevoked；已修正新断言。
- 冻结 concurrency.rs 从 Git 01b545a6 恢复，原件 SHA256=29a86130878aebbac3e0ef72d7ba43ca0b0432c4a0d4dfdf79fe1687106972bf，只添加当前协议要求的 lean=false 字段；原断言未改。一次性 TS 冻结 adapter 显式 --ignored 调用原两个测试，Agent 使用共同当前 CLI/guest 产物。完成后归档源码、adapter 与证据，不永久恢复 runner。
- `261030-1019-parity-reconstruction-execute-4898` 正在比较冻结 Rust 与 TS；旧 canary 已实际执行并完成，完整结果待该 run 收尾，不提前计 retired。
- Claude 子 Agent 隔离 TS 对端已添加；`261030-1019-claude-current-probe-eb4e` 两条当前探测均 blocked，原因以 inspect 为准，不沿用历史 403。
- 代码复核另发现 Config::load 会先清旧 Speech 凭证再校验 pipeSpaces，混合坏旧配置可能提前写盘。下一次修改应延后这次写盘，并在 space-config migration fixture 同时种旧 speech 字段，验证失败保留完整原文。

## 2026-10-30 收尾核实

- W1–W6 代码已实施，最终候选尚未审查提交，因此仍为 executing。
- 冻结并发重建 `261030-1019-parity-reconstruction-execute-4898`：8/8、qualified=true、inputDrift=false。两个旧 Rust 用例实际以 --ignored --exact 执行；对应 TS 四阶段负载、慢 Git/模型与两种预览背压通过。共享当前 CLI/guest Agent，Rust daemon 为同源码 native 构建，不能称两个 daemon 可执行文件相同。原无效 run 保留，不改历史证据。
- CLI helper 接管 `261030-1030-cli-parity-c417`：9/9、qualified=true、inputDrift=false；实际执行旧原生 remote 7 条及新 TS remote 6 条/forwarded contracts/config migration。映射和冻结源码归档到 Open testing/deprecated/archive/cli-reconstruction-20261030。活动 helper、CLI 的转发业务 Rust 测试及 CI 排除已删除；保留原生解析/隔离测试。
- 当前完整 cargo test --workspace --offline 通过，daemon 642/642。Workbench 857/857；Open/Cloud typecheck、Console build、CI 机械脚本 55/55、治理与 layer lint 通过。
- `261030-1058-full-authority-boundaries-bf49`：93/104 passed，11 failed，inputDrift=false。失败保留：Hosted 续期持旧 expiry；7 处旧授权测试（含自撤销 ACK）；两处 expert 模块旧名；Claude TS owner 元数据未对齐。已逐项修正，不将此 run 算通过。
- Hosted 关闭计时器与每请求有效性检查已改用 logical registry 的最新认证 lease；保留撤销/过期，避免已续期订阅被初始 expiry 关闭。对应原生 workspace 回归通过。
- `261030-1114-final-authority-regression-9b12`：109 项正在跑，包含原 104 项 + 三种 20/60/80 会话完整负载、暂停预览恢复和转发 CLI 合同。源码与产物冻结，不提前报告通过。
- 当前 Claude 真实 probe `261030-1019-claude-current-probe-eb4e`：两条 blocked，HTTP 403 Insufficient account balance；TS 子 Agent 隔离对端已补，仍非真实 provider 通过证据。
- 独立 Beta Linux 测试环境已验证真实 user/net namespace：inner 0 映射 host UID=1000/GID=1001，创建文件仍属正常用户，网络 namespace 与外层不同，正常用户可终止子进程。只在 .candidate-tests 安装测试依赖与受管池新建 dev-3 双仓；未重启/更新 Beta 产品或发布。完整 gate 尚未启动，资源预算和依赖仍在核实。

- 本机现时重新探测已可直接 unshare user/net，ip/tc 可用；与旧 blocked 记录不同。最终 merge plan=774 项、累计估时428.2分钟，计划预算12环境/24CPU/32GiB，机器96CPU/约115GiB可用内存。Python3.12+aiohttp 已有；WAN 使用原调用身份连接已授权 Beta，仅运行隔离 canary。无需把全量门禁放到低配置 Beta。

- `261030-1114-final-authority-regression-9b12` 最终109/109 passed，qualified=true，inputDrift=false。guest SHA 88f7986fa1ad42d9…；CLI hash未变化是薄转发器预期行为（该 hash 不是 guest hash）。
- 新配对写盘故障用例 `261030-1132-invitation-write-red-8a39` 成功复现：写盘失败后第二次核销同一邀请被拒；测试结果0/1、无输入漂移。修复改为持久化成功后才消耗邀请并发布设备；正在补验故障恢复/并发核销/独立撤销。

- 业务/协议候选经12批基线审查受控提交 `957731c436173f70efcd4e6147368f8565854813`，seal sha256:c44d7aad7705376b8addc56fe1f828fbb76ed39160c6b79d8bbc2bf92ec3a449。测试证据/负载另批提交进行中。
- `261030-1144-test-evidence-closeout-6c56`：13 passed /1 interrupted。扩展设备 fixture 的3个拒绝重连串行等待，超过原150s；未提高超时，改为并行验证全部凭证，保留失败记录，新 run 重验14项。结束后的实际进程/端口复核均为0。

- 收尾补验 `261030-1149-test-evidence-closeout-a630`：14/14 passed，qualified=true，inputDrift=false；严格CLI字节/重放，未知旧设备与重复迁移、Agent登录全权路径、治理、team.py 临时目录工具全部通过。原150s超时保留。
- 测试证据提交 ccb5fdd86ab567501be1d5764197a63402e72b75，seal sha256:01d1e7ddb0d3db278788d95e2429b9954a67479d68e42c61d533cce7ed6c97bf；Cloud66f379458728a2741e6d841183d49b5d25336dbe，seal sha256:a139e94c8339dc1ed0870122154d006374c3d9ff1570b2d32074243712b062e6。
