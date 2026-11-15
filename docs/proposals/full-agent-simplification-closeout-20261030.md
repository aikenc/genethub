# 完整连接简化：候选、收尾与验证记录

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

更新：2026-10-31。本轮代码收尾和成对候选核对完成：Open `aa7f7d7f` / Cloud `4b9b16e` 已提交、推送，产品双仓干净，最新main为祖先，无合并冲突。精确两仓CI均success、两PR均clean；Open必需rust/guest/gate全成功。最终Fabric/RTC撤销与续租4/4获同候选feedback资格，原生640/640，制品350份文件前后完全一致。当前可进入授权合入步骤，未执行合并或发布。完整testctl merge资格未取得，不能把下述历史结果或多个feedback拼成正式完整资格。以下按时间保存历史记录，最终结论见末节。

## 候选与边界

| 仓库 | 候选 | 本次核对的 main | PR |
| --- | --- | --- | --- |
| Open | `b4d8206bb760c5bb97b31b19862adc4749ec09e5` | `baae72ae9a550022737d5bec9d89ecb5f212a0c7` | [#71](https://github.com/aikenc/genethub/pull/71) |
| Cloud | `66f379458728a2741e6d841183d49b5d25336dbe` | `023c7d14744d6ee498823eaf6e4e03d33e9ecc33` | [#37](https://github.com/aikenc/genethub-cloud/pull/37) |

两仓干净、已推送。最近远端核对见记录（工作区资料：`spaces/dev-3/closeout-main-sync-remote-observation-003.json`，未纳入本仓）。本轮交付为经过验证的代码候选；没有执行主干合并、发布、线上 daemon 重启、真实设备或团队迁移。旧项目兼容按 Human 最新范围暂不纳入；R1–R4 独立可靠性包和真实 Claude 403 不计完成。

## 改了什么

既有主体统一完整 Agent 连接的 OS 账号级操作能力，移除普通 grants、项目/角色降权、旧 Workflow 执行与授权特例、死 RPC/CLI/proto 及 PipeSpace wire 投影。认证、账号/机器归属、撤销/过期、OS、仅展示分享、来源身份、CAS 和幂等保留；原生 plan/read-only、提问和凭证卡片仍是业务交互。

本轮收尾删除没有生产消费者的 confinement 执行链：Policy、包装 argv、隐藏 __confine 入口、Landlock/namespace 限制执行及依赖、exec/PTY 恒为空的策略参数、无用启动错误包装、Confinement 类型/字段与 IsolationUnavailable 映射。exec/PTY 直接启动目标程序，TS 投影从 Rust 重生；host/guest 成对构建。内核能力探测仍被 machine.info/CLI context 消费，因此保留诊断模块，不向 Agent 应用沙箱。

| 提交 | 内容与受控审查 |
| --- | --- |
| `3ea95576` | 隔离执行接线删除；回执（工作区资料：`spaces/dev-3/closeout-commit-receipt.json`，未纳入本仓），seal48c2549f… |
| `52fc0d55` | 已有邀请指南契约断言对齐，保留 Human 明确授权配对及凭证不进文件/日志/提交；回执（工作区资料：`spaces/dev-3/closeout-guidance-commit.json`，未纳入本仓），seal6cfb5ea7… |
| `b4d8206b` | 集成推进期间新增的 main Capture/预览实现；修正两处继承的格式及四份旧权限描述，保留源端共享、页面同意、撤销和 OS 边界；回执（工作区资料：`spaces/dev-3/closeout-main-sync-commit.json`，未纳入本仓），seal26f834e6… |

相对上述 main，Open 为 173 文件 +13,789/−8,744；产品与构建部分 89 文件 +905/−5,576，净删 4,671 行。testing 为 79 文件 +12,846/−3,141，新增主要包含冻结比较证据归档。不能把全仓变更说成净删除。Cloud 仅两文件说明/注释，无运行逻辑变更。

## Team 保留与实测

角色、Space/组件树、父子关系、委派、定时钩子、锁、结果归属和一次回报保留。开发用 PipeSpace/PipeBuilder 未改。

当前同候选已通过 team fault-injection、共享项目钩子、team relay、远程派发、摘要预算/取消、三组 200 会话混合负载及 10 节点/200 成员摘要聚合。节点压力测试使用本机隔离 daemon，不代表十台物理机器验证。尚未执行的原 policy 用例单独列在补验选择中，没有以标签替代执行。

## 已验证的结果

| 验证 | 结果与范围 |
| --- | --- |
| 组合机械验证 | cargo workspace tests，daemon641/641；Workbench864/864；Capture5/5；Skill15/15；Clippy workspace/all-targets/−D warnings、类型、协议生成235、testing lint/governance 通过。 |
| Open CI | [41079326736](https://github.com/aikenc/genethub/actions/runs/41079326736)，精确绑定 b4d8206b，9 个 job 全部 success，包括 Windows/macOS。不能扩大为两平台所有 UI 或 Capture 物理媒体/输入验收。 |
| Cloud CI | [41000635726](https://github.com/aikenc/genethub-cloud/actions/runs/41000635726)，精确绑定66f37945，success；Console按原路径过滤 skipped，不计 CI 执行。本地配套构建/类型和消费端验证已通过。 |
| 长流与 Capture | 2320-4b5c（工作区资料：`spaces/dev-3/runs/261030-2320-authority-main-sync-dev-feedback-4b5c/summary.md`，未纳入本仓）：9/9，qualified feedback；Fabric/RTC 活跃流撤销、真实租约续租/驻留，实际 Capture 进程与 opaque H5 源关闭/接管边界。 |
| 原两项吞吐 | 2346-1fa5（工作区资料：`spaces/dev-3/runs/261030-2346-authority-main-sync-dev-feedback-1fa5/summary.md`，未纳入本仓）：2/2，qualified feedback；9 轮采样和70%门槛未改。 |
| 常规单例对照 | 0130-d9e1（工作区资料：`spaces/dev-3/runs/261031-0130-authority-main-sync-dev-feedback-d9e1/summary.md`，未纳入本仓）：team-automatic 1/1，qualified feedback。无跟踪；没有复现主进程 SIGTERM。 |

以上三个常规反馈 run 均绑定 b4d8206b/66f37945，inputDrift=false、unprovenArtifacts=[]、进程/端口泄漏0/0。CI核对回执（工作区资料：`spaces/dev-3/closeout-main-sync-ci-verified-receipt.json`，未纳入本仓）。

Linux Capture包由本槽固定原生/Rust源码构建，build.json绑定b4d8206b且dirty=false，30份文件哈希全部核对，ABI5真实加载。Linux没有原生图形后端；不据此声称 Windows/macOS 物理桌面画面、声音或输入通过。包身份回执（工作区资料：`spaces/dev-3/closeout-main-sync-capture-package-identity.json`，未纳入本仓）。

## 完整运行中断与补验

原完整 policy plan 为779项。`261030-2349-authority-main-sync-merge-e5bf` 留下697条互不重复的 passed 记录、0条 failed，随后进程收到SIGTERM并以143退出；没有最终manifest。进度文件的旧running状态不能证明进程还活着。中断回执（工作区资料：`spaces/dev-3/closeout-main-sync-interrupted-receipt.json`，未纳入本仓）。信号发出者仍未知，没有将它归因于产品或环境。

单例信号跟踪 run 0121-a1c2（工作区资料：`spaces/dev-3/runs/261031-0121-authority-main-sync-dev-feedback-a1c2/summary.md`，未纳入本仓） 没有复现主进程SIGTERM，但出现请求超时及清理失败，0/1，qualified=false、清理前泄漏41进程/6端口；该失败保留，不作资格或性能通过证据。同源无跟踪对照0130-d9e1通过且无泄漏，因此本轮没有据此修改产品代码。

现有工具不能从缺失最终输入观察的运行直接恢复正式资格；不手工补造manifest或qualified字段。复用697条部分结果、两项已有正常吞吐结果和一个常规单例结果后，已覆盖700个不同policy用例，只剩79项。它们分8批执行，每批保留自己的正式feedback manifest；每批选择都与已覆盖ID集合不相交，原variant、负载和断言不变。补验选择与来源（工作区资料：`spaces/dev-3/closeout-main-sync-tail-selection.json`，未纳入本仓）、实时状态（工作区资料：`spaces/dev-3/closeout-main-sync-tail-status.json`，未纳入本仓）。

补验完成后只汇总“用例覆盖”，不会将多个feedback和中断记录伪装成一份正式merge qualification。发布或其他要求特定gate资格的流程仍必须按其合同判断。

## 输入与制品身份

CLI、Host、guest、Relay、Workbench、Cloud server、Console、Capture包（含原生侧库）8类制品在补验开始前逐文件大小/SHA256与冻结起点一致；源码仍是同一干净候选。冻结起点（工作区资料：`spaces/dev-3/closeout-main-sync-artifact-inventory-start.json`，未纳入本仓）、中断后核对（工作区资料：`spaces/dev-3/closeout-main-sync-interrupted-artifact-inventory-end.json`，未纳入本仓）。每批另由testctl核对其实际输入，结束后再次独立核对8类全量文件清单。

## 历史记录与验证成本

保留旧52fc候选1806完整run773/775、2032亲和性对照0/2、低争用2216对照2/2，以及主干推进时中止的2219（42条部分结果）；不转借其资格。旧5cd完整通过和旧macOS指南断言失败也保留。

此前没有先冻结候选，把主干更新过早等同于必须中断并重跑全量，放大了成本。本轮不再因文档或无关主干更新重启；同源已验证结果不重复执行，具体失败做定向验证，必要的完整policy范围逐项列清。补验不修改测试框架、policy或通过门槛。

## 回滚与交付

没有实际部署。源码回滚须使用匹配协议的组件；实际升级必须保全新增会话/输入及完整备份，不能让旧格式程序覆盖新格式数据，也不能用旧受限设备备份恢复授权。当前仍在补验，待结果闭合、PR与真实远端主干核对后再确认候选收尾；未将正式merge gate标成通过。

新增失败：run261031-0137…7138中team-automatic-100回复100/100完整，RPC p95=1419ms但errors=1；最慢响应准备后egress约9764ms。该失败不是通过，尚未归因于当前重构或主干。其余批次由编排器在本批非零退出后停止。

## 最新定向对照与补验约束

主干baae72的同一100会话用例run0203-e226通过，p95=755ms、errors=0。候选b4d的run0215-1733通过，p95=741ms、errors=0、完整回复100/100，无输入漂移或资源泄漏。额外观察只读本次测试自有租约的现有RPC时序、socket队列和CPU计数，不注入hook、不使用strace、不增加RPC、不改负载和断言；观察期间共享cgroup没有新增CPU节流。

这没有解释旧run7138中的一次10秒超时，不能写成已修复或环境问题。旧失败保留为未归因的不稳定现象，详见三次对照回执（工作区资料：`spaces/dev-3/closeout-auto100-comparison-receipt.json`，未纳入本仓）。剩余验证严格只选原policy里未执行的69个ID（原批次2–8），不重跑已完成的710个不同ID；分批独立manifest、遇失败停止，不重启779全量。此处710只是已有通过记录的覆盖数，包含无最终manifest的697条部分结果，不代表正式资格。

## 2026-10-31 补验完成后的合入判断

原批次2–8共69/69通过，各批独立feedback资格有效，均为b4d8206b/66f37945，inputDrift=false、unprovenArtifacts=[]、进程/端口泄漏0/0。8类制品完整清单与冻结起点逐文件一致。原697条部分passed、既有3条正常反馈、首批9条passed及100会话定向对照1条，再加本次69条，覆盖原779个不同ID。覆盖回执（工作区资料：`spaces/dev-3/closeout-main-sync-coverage-with-open-failure-receipt.json`，未纳入本仓）。这是一组覆盖证据，不是正式完整merge资格；原红run7138和跟踪诊断a1c2均保留。

最新远端Open main=baae72ae、dev-3=b4d8206b；Cloud main=023c7d14、dev-3=66f37945。两仓干净，候选已推送，主干没有推进；patch级cherry显示Open7条/Cloud1条待合。精确候选CI此前已确认绿色，本轮未改产品源码、未重新跑全量。

唯一未关闭的运行风险是7138的100会话管理请求单次10秒超时：完整回复100/100且p95=1419ms，但errors=1违反原零错误断言；同候选后续单例p95=741ms/零错误，main对照p95=755ms/零错误。未证明为环境因素或既有主干问题，也未实施产品修复，不能靠后续通过覆盖旧失败。当前结论为：覆盖补验完成，原验收未闭合，暂不建议直接合入。没有执行合并或发布。

## 2026-10-31 最新main语义集成

新候选Open `05d33e78aa0f5db29241c5ddcff54296c63e2852` / Cloud `4b9b16eb361da802fb4a04ddcd17496fb707d111`；已包含main `10a0cfc6` / `dac6d4d2`，并已推送dev-3。合并逐块处理8处冲突，没有整文件选择权限或网络一侧。保留当前网络新endpoint、订阅准入先于回执、物理心跳和本地队列预算；保留完整连接权限、分享隔离和实时撤销/过期。旧重放journal/credit没有恢复。协议绑定由最终Rust重新生成236项。

自动合并带回的无效 `WorkflowRequestBudgetSnapshot` 示例导出在审查第4批被拒绝，删除后cargo check proto --examples通过，再以新候选完成13批新鲜审查。Open seal `ded4b542…`，Cloud seal `4da783d0…`；旧拒绝记录保留。平台PM测试旧ID按主干退出，仍有效的原生Agent计划卡过期属性与timeline检查单独保留为 `specialty.contracts.native-plan-recovery`。

机械验证：workspace check、daemon640/640、Workbench网络/协议/数据面129/129、Cloud真实Fabric13/13、两仓相关类型、测试lint/governance、协议236导出及导出示例编译通过。当前制品从本槽组合候选构建；Capture独立应用源码/包未变，仅保留原包证据，不扩大为新Capture物理设备验收。

上游网络候选5e0/dac6的完整dev745/745 qualification已读取实际manifest并核对哈希（记录（工作区资料：`spaces/dev-3/closeout-v2-upstream-qualified-observation.json`，未纳入本仓））。它属于上游输入，不计为05d/4b9组合资格。旧失败路径使用15秒物理静默判断与跨载体重放；新版已移除重放并使用既有Fabric120秒物理期限，断线明确结束旧流，订阅通过业务游标恢复，已接收输入按message ID/回执恢复。旧7138具体时刻的单一根因仍不能追溯确定；本轮须用原100会话零错误/p95<1500ms断言及新100会话同节点突发的真实源一次/物理连接不替换断言验收新路径，不能只靠旧候选后续绿色宣布修复。

组合验证选择固定为2+21项，见performance/functional plan；范围涵盖team、完整连接权限、分享拒绝、Fabric/RTC长流撤销和续租、订阅准入、真实断链后的源一次、CLI活连接释放及更新时显式Human停止。保留各自限定范围manifest，不拼造完整merge资格。不新增旧项目兼容工程或R1–R4，也不执行主干合并、发布或真实设备重启。

## 当前百会话负载的结论（网络v2组合候选）

原用例与原断言未变。`261031-0825-authority-v2-management-96cb` 已通过：100/100源端回答和精确回复、270次管理RPC零错误，p95=740ms（门槛1500ms）、p99=1199ms、最大1316ms；nodeTcpAccepted=40，无修复性重订阅。逐会话恢复检查全部settled=10/pending=0，输入漂移false、无未证明制品，进程/端口泄漏0/0，qualification为本次选定范围的feedback。见原始摘要（工作区资料：`spaces/dev-3/runs/261031-0825-authority-v2-management-96cb/summary.md`，未纳入本仓）、时序与结果回执（工作区资料：`spaces/dev-3/closeout-v2-management-observation.json`，未纳入本仓）。

另一个同节点100会话同时订阅/发送用例在 `261031-0823-authority-v2-performance-4bb3` 真实通过：100/100、resync=0、物理连接2→2。该批次另一个管理用例未启动：我把environment设为1，派生io预算1，小于用例声明io2。原批次整体qualification=false，资源总普查不完整；保留原manifest。纠正为environment2/io2后只运行此前未执行的管理用例，没重跑已通过的突发用例，也没有修改产品、测试或断言。不能把两个独立run拼成原批次全绿。

旧7138的单次10秒超时保留为旧实现的未归因故障。证据已限定在请求进入router且迅速生成回复、出站耗时约9.8秒并伴随额外TCP接受；不能凭这些信息确认某一条计时器就是历史根因。处理结论是主干已实际删除对应传输重放/信用机制，替换物理存活判断；本候选完成新路径集成并以原指标验收，不为旧实现再加补丁或可靠性层。这是“新路径当前满足原验收，历史根因未证实”，不是“后续绿了所以旧故障不存在”。

## RTC 撤销用例消费者修正（只改测试）

`261031-0828-authority-v2-functional-8a64` 为20通过/1失败，qualification=false；失败在RTC撤销之前的authorized-event观察，尚未进入撤销动作。`503bfc23` 补全Client必填且带类型约束的onResync，复验`261031-0836-authority-v2-rtc-consumer-02e4`仍为1通过/1失败，记录保留。只补回调的判断不完整：新建空闲会话cursor=0，公开订阅契约以reset快照代替历史事件，故仅消费replayed也会漏掉真实标题。

`52f218ed` 按Workbench现有消费者方式采纳真实snapshot.summary.title与实时/重放事件；不制造titleChanged事件，不读取内部状态。授权前置仍限5秒，撤销后5.5秒关闭与9秒无延迟磁盘副作用、独立owner可用的断言未改；撤销后观察同时拒绝快照与事件带来的新标题，比原来只拒绝事件更完整。类型、lint、governance通过；受控审查seal fd1e5ef0、tree10e25520。只验证这两个共享消费者用例，不重复已通过的其他20项和百会话负载，也未修改产品、超时、预算、policy或治理标准。

## RTC 撤销时限产品修复（独立工作包）

`261031-0839-authority-v2-snapshot-consumer-00a0` 保留：RTC已观察授权标题、repairs=1，随后在5500ms关闭断言失败，揭示真实授权停止时限风险。Fabric的失败为本轮新增观察数组包含初始null标题导致TypeError，已以`7772642b`单独修正，并补失败时的公开状态诊断；没有当作产品失败或放宽门槛。

独立产品任务 `hosted-rtc-revocation-bound-20261031` 复用相同槽位与状态库。现有Hosted monitor每1秒检查，HTTP预算2秒；endpoint又把授权检查绑到5秒物理heartbeat，叠加可能超过原5500ms。产品修复保留物理5秒clock，在同一endpoint任务内为Hosted/到期访问增加独立1秒授权检查，并Skip积压tick；不增加Hub请求、后台任务或权限机制。未鉴权字段为空的普通设备不轮询这个分支，原百会话rendezvous负载走该普通设备路径，不因此重跑。

中间`1a36c765`单一clock加deadline的写法在实跑前复核发现可能改变普通Ping间隔，已继续收敛，未用它执行或声称任何真实专项通过。最终源码须重新经过受控审查，guest须在冻结提交后构建，随后仅验Fabric/RTC活跃流撤销及两条五次真实续租，共4项；不会重开全量或重复其他已通过范围。

## 最终局部收尾结果（aa7f7d7f / 4b9b16e）

最终共用endpoint代码保留原物理5秒heartbeat，在同一任务内对Hosted/到期访问单独每1秒复核授权，跳过积压tick；没有额外Hub请求、后台任务、权限等级或协议变更。普通Device没有上述授权字段，其原5秒物理clock和百会话rendezvous路径不变。中间提交的deadline写法已退出，未以其产物声称实际通过。最终产品tree `a7b205adb06b0315be0ebc53e0bd7c464db59b00`，受控seal `5a25565b31487aba05b96b89bc29c78dd7e4c5e569bfa99945f7f24cf597bf36`。

最终实跑（工作区资料：`spaces/dev-3/runs/261031-0849-authority-rtc-final-ac39/summary.md`，未纳入本仓）4/4，qualified feedback；source为完整aa7f/4b9。Fabric/RTC活跃订阅和已启动命令在原5500ms内结束，9秒后没有延迟磁盘副作用，独立owner正常。Fabric/RTC五次真实续租分别得到6/9个独立admitted endpoint，最大管理RPC86/87ms，671/689个事件精确有序。RTC授权前置实际通过一次快照恢复（repairs=1），Fabric为0；不伪造事件。inputDrift=false、unprovenArtifacts=[]、进程/端口泄漏0/0。

新guest从最终冻结提交构建；运行前后350份文件清单（工作区资料：`spaces/dev-3/closeout-rtc-final-artifact-inventory-end.json`，未纳入本仓）逐文件一致。只有guest因endpoint产品修复而改变，另外7类制品与组合起点一致。旧05d百会话测试仍仅作为其实际源码范围证据，未转移其资格为aa7f；本次修复不触及其中普通配对设备分支，未无理由重跑。

独立产品工作包`hosted-rtc-revocation-bound-20261031`已由控制器接受completed。主收尾任务继续等待最终精确Open CI；PR说明已更新为当前候选及真实证据范围。没有合入、发布、线上重启或迁移真实设备/团队。旧7138历史单一根因未证实，旧实现已被main新网络替代；当前RTC关闭时限是本轮新发现、已针对机制修复并由原边界验证的问题，两者不混同。

## 最终合入候选核对

| 仓库 | 最终候选 | 当前main | CI与PR |
| --- | --- | --- | --- |
| Open | `aa7f7d7f6a3097e2b4d0aa060fccef6d4f0309cb` | `10a0cfc6f3bd733ac935c5eba752c3315766da65` | [CI9个job全部success](https://github.com/aikenc/genethub/actions/runs/41152139583)，[PR71](https://github.com/aikenc/genethub/pull/71) clean |
| Cloud | `4b9b16eb361da802fb4a04ddcd17496fb707d111` | `dac6d4d26389657f4a80872049ffb32feb3ed47f` | [精确CI success](https://github.com/aikenc/genethub-cloud/actions/runs/41149448485)，[PR37](https://github.com/aikenc/genethub-cloud/pull/37) clean |

两仓产品工作树干净，origin/dev-3等于上述head，main为祖先，当前无文本分叉冲突。GitHub实际核对的Open必需检查为rust、guest、gate，全部success；两PR均非draft、mergeable=true、mergeable_state=clean，无inline review评论。Cloud私仓的protection接口因GitHub套餐返回403，未据此假定没有保护；其CI与平台计算的PR clean是独立可观察事实。详见最终候选回执（工作区资料：`spaces/dev-3/closeout-final-candidate-evidence.json`，未纳入本仓）。

这关闭的是本轮代码候选的主干集成、真实RTC关闭回归和精确PR检查。Team机制保留，当前受影响权限/team/订阅/恢复范围的既有有效记录与最终局部4/4分开列明；没有把05d的20条通过行或旧百会话资格转移为aa7f的完整资格。提案M5要求的正式完整testctl merge qualification仍为null，没有暗改门槛或冒称完整dev/merge/beta/stable发布验收通过。本轮按Human和专家要求保留旧有效证据、补实际改动范围，没有重启全量。

后续合入应经当前两个PR并重新核对head及main；本轮未执行合并、发布、线上重启、真实设备/团队迁移。旧项目兼容、独立R1–R4和真实Claude账户403不计本轮完成，旧7138历史根因未证实的边界继续保留。

主收尾任务 `full-agent-simplification-closeout-20261030` 的validated-candidate交付已由控制器接受 `completed`，见完成回执（工作区资料：`spaces/dev-3/closeout-final-completed.json`，未纳入本仓）。该状态表示成对候选交付完成，不提升上文限定的测试资格，也不是合并或发布回执。
