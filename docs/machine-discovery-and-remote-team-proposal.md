# GeneHub 机器发现与跨机团队派单：第二版提案及实施合同

交付范围：dev-2 第二版源码候选；完整门禁尚未通过，未取得 Beta 发布资格。日期：2026-10-24。
源码基线：open `10775e08`，随后独立修复连接收尾 `0b0b3552`；Cloud `4a6d5a52`。本文说明本版实际范围，取代前稿较大的 B/C 设计；历史细节可查 Git 版本。

## 背景与用户场景

用户希望从一个会话查看开发机器，把任务交给有相应代码或资源的远端岗位，再收到最终结果。例如“让另一台机器的 QA 检查这个项目”。机器是执行设备，workspace 是设备上已登记的工作目录或 Space，会话在所属设备执行，团队则是用户自己的岗位目录和协作脚本。平台有远程原语，团队脚本还需要负责选对岗位、写入互斥和结果回传。

原来的发现入口和执行入口不一致：`machine list` 默认只读本地直连配对库，日常机群却来自 Hub；列表为空，同一机器的 `context --machine` 仍能成功。上一版只加提示，仍让 Agent 在“查有哪些机器”时答错问题。因此用户要求默认命令直接回答当前身份能发现的机器，而不是学习内部存储差异。

用户随后要求审查其他命令、写清提案并实施，并明确不需要为了输出过滤新增 `--limit`。本轮又批准最小跨机方案与普通 Agent 的账号权限一致性：固定岗位目标，执行端拿写锁，模型在目标机校验，暂停不被通知解除，单条故障不拖垮对账。不建设中央调度或分布式租约。

可追溯的起点：原始排查 `ghref:item:s_2bd26602bde045368b859df733f3684c:u_957b7818b87e4181bbbd5fcda600a45f`；指定 dev-2 `ghref:item:s_2bd26602bde045368b859df733f3684c:u_f97a2a3554274e9f8c81d61864a6b1bc`；上一版声明 `ghref:item:s_2bd26602bde045368b859df733f3684c:turn_45e65beec7004dddb9ce2b1c7a43cc89-230`。历史会话不是当前安装版已更新的证明。

## 问题、证据与改前改后

| 场景 | 基线问题及源码证据 | 本版行为 |
| --- | --- | --- |
| 查询机器 | `cli_front/machine.rs`、`machines.rs` 的默认 list/show 分别依赖直连库，取票错误还可能被解释成未配对 | list 默认合并本机、直连和 Hub 目录；show 使用同一目录；`--paired` 明确查看直连库，`--reachable` 保持兼容；Hub/文件读取失败不伪装成空列表 |
| 查帮助、传命令负载 | native 顶层扫描任意 `--version`；guest 帮助/schema 与部分解析不一致；未知筛选被当空结果 | 顶层版本只识别完整顶层调用；子命令帮助来自合同，`--` 后负载原样传递；路由筛选隐含 routes；agent run 的 --agent/--tag/--session 选择与 schema 一致；未知选项/枚举立即报参数错误 |
| 派到其他机器的 qa | `team.py` 按短名或本机解析的远端路径猜岗位，显式 workspace 又可绕过核验 | 固定 machine/workspace/接单命令；显式会话 ID 也校验 workspace，空 machine 不落本机、空 request-id 不生成新任务；执行端核对实际团队/岗位，另一团队同名 qa 也拒绝 |
| 两个派单写同目录 | 旧远端 spawn 跳过本机 claim；send 还可自动建会话或复用已结束会话 | 执行端原子 claim；冲突直接忙；send 只补充仍持回执的任务，结束后新任务必须重新 spawn |
| 创建成功但回复丢了 | 创建前没有可核对的执行端回执；重跑可能开出两个会话 | 派单方先存意图，执行端先存 unknown；已有 sessionId 就复用回执，unknown/损坏记录阻止重建 |
| 本机模型覆盖/多媒体任务 | 旧 choose 在远端分支前采用本机 TEAM_MODEL；默认路径跳过媒体校验 | 使用目标机配置/catalog/路由，缺模型或媒体能力不明时在创建及拿锁前拒绝 |
| 人已暂停，收到补充消息 | 旧远端 notice 去掉 --system，可能恢复暂停 | 两端都是 system 通知；用户暂停由 Human 明确恢复；自动取消/内核失败只释放已终止任务的锁，不解除暂停 |
| 一台远端故障 | 旧 reconcile 只处理 targetNotFound，其他异常中止整轮 | 每条记录保存错误并保留待办，其余独立任务继续；投递和释放共用执行端回执，释放失败保留相应批次 |
| 连续远程调用突然不可达 | 独立回归在第32条查询失败；`rpc_wire` Drop 先终止 Fabric pump，32个逻辑连接名额等待60秒过期 | 正常结束先完成现有 CLOSE 再释放carrier；64条远程查询及执行中断线续传均通过，不增加上限或关闭恢复 |
| 普通 Agent 执行管理命令 | SessionController 只有 handshake/read/session，完整 Hub Channel 却没有同样限制 | 普通会话具有当前 OS 账号能力，仍保留 sessionController 身份；managed 子会话与设备显式授权不扩权 |

以上是基线源码行为和本地隔离实验，不声称已发生线上跨机写冲突。机器目录/CLI 修正在前批提交完成；本轮重点收敛团队执行和普通会话权限。

## 最小配置与执行路径

派单方只增加 `.genethub/remote-targets.json`，每个岗位固定一个目标：

```json
{
  "qa": {
    "machineId": "<machine list 的精确 ID>",
    "workspaceId": "<目标机已注册的岗位 workspace ID>",
    "command": ["<目标机 Python 绝对路径>", "<目标团队 tools/team.py 绝对路径>"]
  }
}
```

```text
team.py spawn --space qa --kind work --machine <ID> --request-id qa-review-42 --desc "验收变更" "任务正文"
team.py send --machine <ID> --to qa "补充要求"
```

省略 --request-id 时，每次 spawn 创建新任务并在远端变更前输出生成编号；相同正文的新任务不会返回旧结果。遇到失败，用已输出的编号与原内容重试查询；不要省略编号盲重派。

这不是权限白名单或自动调度池。命令通过已授权的 `shell --machine` 执行，目标账号必须有完整执行权限。Python/脚本按 argv 传递，路径属于目标机；接单进程使用目标 daemon 绑定的 CLI，不猜其他渠道。

派单方保存父子关系、批次、意图及最终回传；执行端保存创建回执、会话和写锁，不启动前台、看板或定时对账器。`receive` 校验安装脚本对应的团队根，不能因当前 cwd 位于别的团队就改变身份。工作岗位锁其 WORKTREE_DIR，未配置则锁岗位根；research 不拿写锁，但只是团队约定，不是 OS 只读沙箱。

接单、投递、释放共用目标岗位的进程互斥。写锁仍采用现有 `genet-writer.json` 的排他文件创建；本机 spawn 也遵守同一目录的保留锁。远端遇到冲突直接报忙，不排队、不自动切 worktree；需要并发就绑定不同实际工位。直接 shell/agent run 及 Human 手工操作不属于协作锁的强制隔离承诺。

`send` 只接受本团队 pending 中仍持执行端回执的会话。零个先 spawn，多个指定会话 ID；释放后的旧会话不再接受新任务。执行端在同一互斥内投递 system 消息或释放锁，释放前确认没有待处理输入，且最新回复 ID 与本次对账快照相同；不相同则保留待办重新取结果，避免“刚补发要求就被上一轮结果销账”的竞态。

## 接收、完成与故障恢复

| 所有者及状态 | 含义 | 可执行恢复 |
| --- | --- | --- |
| 派单方 dispatch 意图 | 记录稳定编号、完整任务及目标快照，早于远端变更 | 同编号、同内容重试查回执；不同内容拒绝 |
| 执行端 unknown | 创建前已保存，尚无确认的 sessionId | 核对实际 workspace、标题、时间与系统输入；不得自动重建或删锁换号 |
| 执行端 created | 有 sessionId 和选路信息 | 即使创建回复丢失，重试仍返回同一会话 |
| pending | 收到创建回执，任务可能仍在运行或暂停 | 按 machine 查询真实状态及最终回复；系统接收不等于任务完成 |
| 执行端 released / 派单方 done | 终态已观察，写锁已释放，结果按既有消息身份回传并归档 | 重复释放只清理原任务自己的 marker，不删除新写者的锁 |

回执为空、损坏或无法读取都是不确定状态，不是“从未派单”。释放授权先持久化再删除自己的 marker，重试可以收尾；若新写者已接手，旧释放不得删它的锁。用户主动暂停保留锁。源任务明确超时取消或内核记录本轮失败时，确认不再执行后可释放锁并交付失败终态；暂停标志不改变。

未知创建、派单方永久丢账、磁盘损坏和强制关机仍需人工核对。没有到期抢锁、自动重派或自动删除去重回执。用户确认任务永不重试后才能归档回执。此处选择保留可恢复状态，代价是少量人工恢复，而不是引入跨机租约服务。

## “连接即有权”的具体边界

普通 Agent 原本就能以该 OS 账号执行任意代码，因此本机 CLI 再人为扣掉 Settings/Devices 等能力既不构成 OS 沙箱，也让本地与完整 Hub 通道产生意外差别。本版由 daemon 校验会话 proof 和真实 managed 元数据，为普通会话返回账号能力，不通过清除 Session 身份冒充 LocalUser。

普通会话（包括 PM 主会话）可以登记账号可访问的 workspace，也可以发起 Agent action/reset/reload 等账号操作。登记目录不等于接管或改组其他项目；项目管理与受管子会话仍按已有绑定校验。需要 Human 输入/批准的认证请求仍只能由 Human 看见和回答；provider configure 准备配置卡片，Agent 不可直接提交 provider 凭证或绕过配置卡写 provider。provider 配置删除仍由 Human 设置入口处理。自答 Human 问题/计划批准、项目/父会话管理边界继续保留。

显式受限设备连接仍逐请求读取 grants，撤销立即生效；PreviewShare 的文件范围不改变。managed 子会话保留原 handshake/read/session 能力和既有 Workflow 约束。本版不承诺把最初发起设备的 narrowed grants 变成已运行 Agent 的 OS 沙箱；Session/不受限 shell 本身具有执行能力。详见 [安全模型](./security-model.md)。

还须区分上游服务拒绝与本机权限：本轮 Claude legacy 用例实际收到 `403 Insufficient account balance`，这是模型服务的响应，不能靠放开本机 Settings、重新配对或重启 daemon 修复。daemon 端点未能核验、会话被用户暂停也不等于缺少账号权限；应保留各自的错误和状态。

## 取舍、迁移和发布边界

| 方案 | 结论及代价 |
| --- | --- |
| 机器列表只加提示 | 默认答案仍错，已改为直接发现完整可见目录；保留显式 --paired 离线排障路径 |
| 按岗位短名猜远端团队 | 初始化省一步，但会误派；改成一次性精确绑定 |
| 分布式锁、租约、队列、中央调度 | 本期不采用；执行端本机文件已能解决固定目录的合作式互斥 |
| 丢回复后直接再建 | 易重复执行；改成稳定编号和回执，unknown 保留人工核对 |
| 仅在本机会话调用远端 shell | 保留；无需远端 Agent 环境时更省部署步骤 |

改动由 open 仓的 CLI、authz/transport/router、团队模板及文档拥有；Cloud 不需要改协议。新增身份判断/接单脚本没有新增 wire/WIT/native-host 合同，属于 guest 和内置资源；整个 dev-2 候选仍含前批 native CLI 修改，不能据此直接声称只发 Live 就包含全部修复。

启用新绑定前暂停旧版新派单，核对并收尾旧版无锁远端任务。用户团队独立于产品模板，双方都需显式升级脚本，保留用户定制及目标机配置。SpaceBuilder portable 岗位制品不含接单脚本、父团队描述或完整运行资源，单独一个制品尚不是本版接单安装包。目标机不需要运行团队根会话或对账器。

回滚前停止新派单并收尾运行任务、保存回执。旧脚本不理解新的执行端锁和释放状态，不能带着未结束的新派单直接回退。本轮不修改用户正在运行的团队，也不安装、重启或发布 Beta。

## 验收和当前证据

验收以真实公共 CLI/client、daemon、Relay、文件和进程为准，默认只替换 LLM endpoint。参数传对、接收回执或 exit 0 均不能替代最终状态。测试运行根位于 dev-2 的 runs，最终资格与提交身份写入同一任务状态卡。

| 验收面 | 用例/可观察结果 |
| --- | --- |
| 机器发现与 CLI 合同 | machine-directory、cli-usability：默认目录/show 一致，Hub 错误保留，参数边界与 schema 合同相符 |
| 接单生命周期 | team-remote-dispatch：真实 Relay + 两个 daemon 数据目录；丢成功回复后取同一会话；并发只一个写者；拒绝其他团队同名 QA；目标模型/媒体；暂停、坏回执、故障隔离、释放后拒绝复用、取消释放 |
| CLI连接收尾 | native-cli-peer-lifetime 连续64次查询目标专有数据；native-cli-resume 中断底层socket后原命令只执行一次 |
| 普通账号权限 | 真实 builtin Agent 的 client list/context；Agent action/reset/reload 需观察 fixture 日志与覆盖目录实际变化 |
| Human 和设备边界 | provider 自配置/浏览器卡片；受限邀请、撤销、无 PTY grant、managed/父会话约束 |
| 整体回归 | 完整 change policy；浏览器卡片另补，因为 change 默认不选 Playwright；lint、governance、类型和 owning-package 回归 |

目前已验证的是同机隔离目录通过真实网络协议组成的双 daemon，不等于已经验收 Mac/Windows 安装、跨真实物理设备部署或升级用户团队。最终候选的专项范围、提交、审查封印和结果以同一任务状态卡为准，不能把反馈范围的通过提升为完整门禁或 Beta 资格。

| 运行与候选 | 实际结果 | 含义 |
| --- | --- | --- |
| 完整 change `261024-2117-remote-team-owner-v2-complete-f30c`，并发 16 | 843 项执行结束：812 通过、22 失败、3 blocked、6 用例超时 interrupted；qualification=false，未报告输入漂移 | 新跨机派单用例通过（约 74 秒），64 次连续远程查询通过（约 53 秒）；整轮仍未通过，不能发布 |
| v2 前干净 `0b0b3552` 的对照 `261024-2216-pre-v2-failure-baseline-2ef9`，并发 4 | 26 项非上游拒绝项：23 通过、2 失败、1 blocked | 两条旧 CLI 断言及 Workbench 的 11 个待实现必需测试在本版之前已存在；其余失败在低并发旧版中未复现，仍需同条件候选对照，不能据此直接归因 |
| 候选 `261024-2230-remote-team-owner-v2-candidate-7582`，并发 4 | 37/37 通过，qualified feedback；对应暂存树 `e60a7651`，在最后的显式 SID 选择校验补验之前 | 包含上述 25 项可执行对照及跨机、权限、Human、连接与构建；同条件反馈验收通过，仍不能替代并发 16 的完整门禁 |
| 浏览器 `261024-2118-owner-authority-human-card-final-1573` | 1/1 通过，qualified feedback | 普通 Agent 保留身份和账号能力，凭证仍由 Human 在原会话卡片提交，重启后可继续；只证明该反馈范围 |

两条旧断言分别要求 `agent list --tag` 必须另带 `--routes`、所有 `agent run` 都必须显式填写 agentId。它们已与现有选路合同冲突，本版保留原用例 ID，改验隐含路由列表、prompt 必填及 tag/session 选型不强制 agentId，继续拒绝未知媒体。前两轮因实现继续修正而中断的完整 run 仍保留，不参与本版资格判断。五条 Claude 上游余额拒绝不重复调用，也不修改凭证；Workbench 待实现测试保留为发布阻塞。

提交前的反例 `261024-2244-remote-selector-red-budget-21b9` 又确认显式 SID 的 send 曾忽略冲突 workspace。本版在投递前拒绝冲突或空选择，补验同时观察远端输入队列和源派单意图没有增加；正常匹配的 workspace 继续投递并保留暂停。最终补验运行和提交封印记录在任务状态卡，不把早于该修补的 37 项结果标为最终暂存树的整轮资格。

当前相关遗留：真实设备安装/升级与渠道发布验收；未知创建/丢账的人工恢复；默认无限保留去重回执的运维归档；较慢远端查询的整轮预算和退避尚未引入。30s 首帧看门狗、事件泵压力和旧 Workflow 退役不属于本批。

## 方法参考

本文采用动机、使用场景、实现、代价、替代方案和未决问题的结构，参考 [Rust RFC 模板](https://github.com/rust-lang/rfcs/blob/main/0000-template.md)。Agent 工具应按真实任务返回有用信息并做系统评估，参考 [Anthropic 工具设计](https://www.anthropic.com/research/writing-tools-for-agents)；执行轨迹与最终环境结果需要分别评价，参考 [Anthropic Agent 评估](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)。这些是写作/评估方法，不代替本项目源码与运行证据。

运行配置与恢复操作正本：[远端接单说明](../apps/daemon/builtin-skills/genehub/references/team-template/skills/team-core/references/remote-targets.md)；整体机制：[团队机制](./teams.md)。
