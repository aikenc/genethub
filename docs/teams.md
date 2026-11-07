# 团队机制

> 本文是**团队机制的事实来源**：多个 Agent 会话怎样组成一支会接力的队伍，平台提供什么、样板提供什么、
> 用户拥有什么。原语的协议细节在各自的领域文档里，本文只给出归属与链接；样板的命令与规则在样板自己的
> Skill 里，本文不重复。

---

## 1. 定位

产品要兑现的结果是：**机器和 Agent 组成一支会接力的队伍，人交代目标，工作持续向前；只有需要人判断时才来找人。**
团队机制就是这件事在多会话协作上的实现：一位用户面对一个前台，后台若干岗位并发推进，结果自动回到发起方，
卡住的会话有人接手。

它不是平台里的调度器。和 [B1](./architecture.md#b1-agent-是插件内核不认识任何具体-agent) 同理——内核
不认识具体 Agent，也不认识具体团队。daemon 只提供通用原语；“团队”是用这些原语搭出来的一棵 Space 树
加几段脚本，住在用户的数据目录里，归用户所有，可以改，也可以整体换掉。

## 2. 三层

| 层 | 是什么 | 归属与变化方式 |
|---|---|---|
| **L0 平台原语** | Space 树、身份编译、定时 hook、系统通知、会话控制、档位路由、跨机执行等（§3） | daemon 契约，随产品版本演进；团队只调用，不改 |
| **L1 样板** | `team-template`：一套按任务选择 Owner 的团队的描述文件、岗位身份、Skill 与 `tools/team.py`、`tools/pm_board_server.py`；加上每台机器的内置管理员（§4） | 随产品发布；是可复制、可改写的范例，不是平台规则 |
| **L2 用户团队** | 从样板建出来、或用户自己写的 `<data>/spaces/<团队>/`：一棵 Space 树加一个 git 仓库（§5） | 用户资产；产品升级不覆盖，只通知 |

判断一件事属于哪层：**换掉样板之后它还成立吗？** 成立的是原语，要写进 daemon 契约并有平台测试；
只对样板成立的写在样板里，团队可以改掉它。

## 3. 平台原语

不用样板、从零搭团队时，下表就是全部可依赖的东西。

| 原语 | 团队用它做什么 | 契约在哪 |
|---|---|---|
| Space 与父子：目录里有 `agent-space.genet.json` 就是 Space；`<根>/spaces/<名>` 的父是 `<根>` | 团队根 + 岗位子空间；daemon 扫描自动登记 | [daemon.md](./daemon.md)「Space 树与 `agent-space.genet.json`」「描述文件与发现范围」 |
| `agentCwd` | 用户点进团队时落在前台目录 | 同上 |
| SpaceBuilder：描述文件 + `identity` + Skill → 各 Agent 原生读取的规则与 Skill 文件；Skill 的 `hooks/` 编译为 Space 的定时 hook | 团队身份（`soul.md`/`memory.md`/岗位文件）对所有 Agent 生效；样板的定时任务随 Skill 安装 | 内置 Skill `genehub` 的 [spacebuilder.md](../apps/daemon/builtin-skills/genehub/references/spacebuilder.md) |
| 定时 hook（唯一事件 `timer`）与 `open.env` | 对账、看门狗、身份同步、模板升级提醒；按团队调阈值与端口 | [daemon.md](./daemon.md)「定时 hook」 |
| 系统通知：`session send --system --message-id` | 回执、看门狗、转交：不打断、不解除暂停、不冒充人的批准，同 id 去重 | [daemon.md](./daemon.md)「4.1 会话」中系统来源一段 |
| 会话控制：创建、发送、中断、标签、描述；会话发起的会话带 `系统发起` | 派出后台会话，按岗位打标签，前台折叠内部会话 | [daemon.md](./daemon.md)「4.1 会话」 |
| 会话历史与 `ghref` 引用 | 反思与接手时按引用回到原话 | [session-history-cli.md](./session-history-cli.md) |
| 档位路由：`--tag Ultra/Max/Pro/Flash/Mini`、`--media`，`agent list --routes` | 团队只写档位，不钉模型 id | `genet agent list --routes`、`genet session model` 的 schema |
| 跨机 | `--machine` 下的 `shell`、`session`、`agent run`；团队样板用 `spawn`/`send` 的 `--machine` 把任务派到远端岗位 | 把任务派到持有资源的那台机器，账本仍留在派单方 | 内置 Skill `genehub` 的 [multi-machine.md](../apps/daemon/builtin-skills/genehub/references/multi-machine.md)、本文 §6 |
| Asset Preview | 看板、可玩版本、报告直接作为链接给用户打开 | [assets-quick-preview.md](./assets-quick-preview.md) |

团队状态（收件箱、待办、留言、写者锁）是团队脚本自己的文件，放在 Space 根下的 `.genethub/team/` 与业务目录里，
daemon 不解释它们（[storage-layout.md](./storage-layout.md)）。

### 3.1 会话创建与协作摘要

`session.create` / `session.createRouted` 可选 `creationId`（1–128 位 ASCII 字母、数字、点、下划线、短横线）。相同项目及编号、相同原始参数重试返回原 SID；不同参数拒绝；删除墓碑阻止复活。未提供时保持普通创建语义。`agent run --creation-id ID --prepare-only` 仅准备会话、不投递 prompt；调用方先保存 Owner/派单关系，再以稳定 message-id 发送业务。两项能力通过 hello/context 的 `session.create-id.v1`、`session.prepare.v1` 协商，旧端不得假装已执行准备。

内核只读 `.genethub/session-coordination.json` 的通用、带版本摘要：`sessions[SID]` 含 `source/taskId/active/pending/ready/unknown` 和时间。原始 `status=idle` 仍表示 Agent 本轮未执行，不能拿它替代业务任务结论。界面可同时显示“空闲执行器、等待两个协作”。摘要不决定消息消费或抢占资源，不是第二套调度器。

摘要是可重建投影，源端 timer 从持久意图、pending/done、inbox 和任务引用重建。读取有大小、数量和两秒缓存边界，不同步访问远端。损坏/失踪保留上次信息并标为待核对；`coordination-source.json` 使重启后失踪也不假装空闲。超过两分钟未更新为 stale；未升级的客户端可忽略可选摘要。

## 4. 样板

位置：`apps/daemon/builtin-skills/genehub/references/team-template/`，随内置 Skill 物化到 `<data>/builtin-skills/`。

| 部分 | 内容 |
|---|---|
| 拓扑 | 团队根（前台，`agentCwd: front`）+ `spaces/leader`、`spaces/qa`、`spaces/research`、`spaces/team-reflect`，按需 `employee add` 扩出管线岗位 |
| 身份 | `soul.md`（宪章）、`memory.md`（L1，≤30 行）、各岗位 `style.md` 与 `index.md`（L2）；会话记录是 L3 |
| Skill | `team-core`（公共约定与命令）、`team-front`（前台，带 5 秒定时 hook）、`team-work`（组长/组员/QA）、`team-research`（只读研究）、`team-reflect`（反思与模板升级） |
| 脚本 | `tools/team.py`（派单、接力、工位、发版、留言、反思、快照、升级）、`tools/pm_board_server.py`（常驻看板）；`tools/expert.py` 是旧名兼容壳 |

设计要点（命令与细则以样板的 `team-core` 和 `team-reflect/references/rationale.md` 为准）：

- **纯异步接力**：派单或投递后立即结束本轮，不轮询。结果由定时对账按三条法则回到上级——有界终态、父就绪才交棒销账、
  组长看门狗自愈；同一批子任务合并成一条回执。
- **分形**：组长 → 小组长 → 多名并发 Worker 用同一套机制，不加新协议。
- **写者锁与工位**：一个目录同时只有一个写会话；并发组员各在自己的 git worktree 里提交，由组长预检合入。
- **前台对用户零黑话**：用户只和前台说自然语言；后台岗位不挂起等人，要人决定的事经前台问。
- **反思与两级记忆**：`team-reflect` 回看会话与留言，把经验提炼进岗位 `index.md` 和根 `memory.md`，并自主维护团队
  Skill 与脚本。
- **模板升级不覆盖**：团队初始化时把模板记入 `platform` 分支；模板更新后定时任务给反思会话留言，由它在 `temp/`
  里三方合并、验证后生效。`reset` 只在用户明确要求时整体恢复。

### 4.1 Task Owner 与资源

Space 是身份、Skill 和配置来源，可同时承载不同任务的独立会话。前台不绑定业务目录，也不锁 Space。`task start` 从适合的岗位准备 Owner 会话；简单任务由 Owner 自行完成，复杂任务由 Owner/子负责人 `task support` 请求支持，按精确机器和 SID 回流。Team Leader 只是具备集成/领导能力的默认岗位，旧 `spawn/send` 路径仍可读写。

Owner、协作者都以 `task finish` 记录明确结论，普通中间回复不销账。默认组内全部必需支持结算，失败不等于成功；多层支持仍使用相同记录和 timer。用户暂停保留输入、引用和工位，普通结果不解除暂停。显式 task 控制用请求编号和 revision 防止重放/旧归属操作，取消核对原生执行和子进程停止后才释放。当前自动 handover 支持同机独立会话；跨机迁移先拒绝、保留原工作，需显式完成产物/资源交接。

写锁跟随实际工作目录，不跟随 Space。Owner 和协作者默认没有写目录，修改项目前为本会话 `task bind-directory`，远端认领在执行端完成；并发写任务选择独立 worktree。临时材料使用 `temp new NAME --task-id TASK`，任务/会话引用与暂停、等待、未消费回执保护材料，不能仅按 mtime 删除。

共享上限默认团队64个活动会话、单任务累计32个会话、派单任务年龄7200秒，可在 open.env 调整 `TEAM_MAX_ACTIVE_SESSIONS`、`TEAM_TASK_MAX_SESSIONS`、`TEAM_TASK_MAX_AGE_SECONDS`。Owner 空闲且没有待办时复用 timer 有界提醒；真实进展才重置计数，普通空转回复不重置。达到阈值报前台并保留工作，不无限唤醒。详见样板 [task-owner.md](../apps/daemon/builtin-skills/genehub/references/team-template/skills/team-core/references/task-owner.md)。

**内置管理员**是样板的另一种用法：`<data>/spaces/admin/` 用同一份根文件加 `team-admin` Skill，只有一个 Space，
负责替用户建团队、接入共享团队、指导定制。它是产品文件，daemon 每次启动与模板对齐（[daemon.md](./daemon.md)「内置管理员」）。

## 5. 用户团队

团队一旦建出来就是用户的：岗位、身份、Skill、脚本、成员结构都可以改，生成物（`AGENTS.md`、`.agents/skills/`、
`.genethub/hooks/`）不手改，改源文件后重新编译。两条重写路径——复制样板后改造（保留派单、看板与升级链），或只用
§3 的原语自己写一棵 Space 树——以及落地步骤，见内置 Skill `genehub-team` 的
[customize.md](../apps/daemon/builtin-skills/genehub-team/references/customize.md)。

团队可以分享：它是一个 git 仓库，别人 clone 到自己的 `<data>/spaces/` 下重新编译身份，就成了他自己的团队。

## 6. 跨机器工位

岗位所在的机器与执行任务的机器可以不同，但只有两种组合：

| 需求 | 做法 |
|---|---|
| 会话在 A，工具在 B | 成员留在 A 的岗位会话里，用 `genet shell --machine B` 在 B 的 workspace 内执行；结果回到 A 的会话，走本机接力 |
| 会话本身在 B | `team.py spawn --machine <B 的机器 ID> ...` 或 `send --machine <B> --to <岗位>`：在 B 的岗位 workspace 创建/投递，Agent 进程、身份与产物都在 B |

`--machine` 接受 `genet machine list` 返回的精确 ID。派单方在 `.genethub/remote-targets.json` 为每个远端岗位
固定 `machineId`、`workspaceId` 与 `command`（目标机 Python、已安装 `tools/team.py` 的绝对路径 argv）。
不再按岗位短名/目录名猜归属，`--workspace` 只能核对同一个绑定。完整配置与恢复见
[远端岗位接单](../apps/daemon/builtin-skills/genehub/references/team-template/skills/team-core/references/remote-targets.md)。

**派单账本在发起方，写锁与创建回执在执行端**。`spawn` 经已授权的 `shell --machine` 调用执行端 `receive`，
先验证目标 workspace 确属该团队岗位，使用目标团队/岗位配置校验 Agent、模型及媒体能力，然后原子申请本机写锁。
写目录由目标岗位 `WORKTREE_DIR` 决定，未配置时锁岗位根目录；遇到已有锁直接报忙，不排队、不自动切远端工位。本机 work 派单也默认锁岗位目录（或 WORKTREE_DIR），沿用本机并发子工位机制；两端不能跳过同目录互斥。
同一派单编号只能对应同一内容；创建前保存回执，创建结果 unknown 时保留锁和意图，不自动重派。

派单方 `pending` 保存 machine 和执行端绑定快照，对账逐条读远端状态/最终回复。单条远端错误留待下次处理，
不会使其他记录停摆。完成批次先确认执行端释放写锁，再回传、销账；释放失败保留账本。执行端不启动前台、看板或对账器。

- `--worktree`/`--dir` 只用于本机派单。远端并发应绑定不同实际目录/工位。
- `send --machine --to <岗位>` 只补充该绑定中唯一的未结束派单会话，执行端校验有效回执后投递；已释放的旧会话不能重用，新任务先 spawn；零个会话提示先 spawn，多个会话要求精确 session ID。
- 本机和远端通知都携带 `--system`，均不解除暂停。用户暂停任务保留写锁，由 Human 恢复后继续对账；本派单的超时取消或内核失败终态可释放锁，仍不解除暂停。
- 默认使用目标机 `TEAM_AGENT`、目标机模型配置或该 Agent 的默认模型；本机隐式模型覆盖不传过去。
- 接单通过目标账号的 shell 执行能力认证；本版只支持有完整执行授权的机器。脚本内容注明原发起方，平台输入仍是脚本通知，不伪造 Human 批准。

SpaceBuilder 0.1.5 可 `build <岗位源目录> --output <制品目录>`，移动后 `verify --artifacts-only`。该制品不自动带
`tools/`、父团队描述或目标端配置，**单独一个 portable 岗位制品尚不能作为本版 receive 的安装包**。
当前接单命令要求目标机已安装团队脚本、团队/岗位描述、目标配置，并注册岗位 workspace；不用启动团队根会话或定时器。
已有团队需要显式升级模板并配置绑定后才生效。部署资源合同见 [spacebuilder.md](../apps/daemon/builtin-skills/genehub/references/spacebuilder.md)。

身份自动刷新（定时任务与 `sync-identity`）使用 `--require-no-post-commands`，遇到 Space pre/post 或 Provider post
返回 `SB018` 并保留上一版生成身份，不因文字更新隐式发布或部署。发布 hook 由源 Space 的显式构建执行；
不要通过增大定时任务超时或反复重试来执行它。该门禁不禁止既有 Provider build。

## 7. 演进与退役

团队机制经过三轮探索才定型，旧形态按 [deprecated.md](./deprecated.md) 冻结或兼容：

| 曾经的形态 | 现状 |
|---|---|
| Workflow（PM / Executor / Worker / Run，`workflow build` / `dispatch`） | 退役中（2026-10-10）；不再是接力的实现，内置 PM Skill 已下线 |
| 单人专家（一个专家 = 前台 + 研究 + 工作 + 反思） | 废弃（2026-10-19）；每次 `init` 都建 1+N 团队，`init --team` 不再有作用 |
| `tools/expert.py`、`EXPERT_*` 环境变量、`.genethub/expert/`、`expert` 标签 | 改名为 `team.py`、`TEAM_*`、`.genethub/team/`、`team`；旧名由兼容壳与首次运行迁移承接 |
| 样板 Skill `expert-core/front/work/research/reflect`、`expert-admin` | 改名为 `team-*`（2026-10-22）；团队升级合并后，`team.py sync-identity` 把描述文件里的旧名改指新名；`--expert` 参数保留为 `--team` 的别名 |
| `posts/` 岗位文件 | 不再创建；已有目录在 reset 与仓库允许名单里保留 |

## 8. 验证

- 平台原语：`testing/specialties/daemon/` 下的 `timer-hooks`、`space-tree`、`builtin-expert` 等专项。
- 样板：`testing/journeys/expert/`（协作、故障注入、反思、真实模型）与 `testing/specialties/daemon/expert-*`、
  `testing/specialties/agent-space/spacebuilder-*`。用例 ID 仍沿用 expert 旧名。
- 内置 Skill：`apps/daemon/src/skills.rs` 断言 `genehub-team` 的路由与参考文件，`builtin-skills` case 比对物化树。

### 跨机器 Space 的固定引用

项目的 `agent-space.genet.json` 可用 `members` 声明外部 Space：

```json
{"members":[{"name":"qa","machineId":"<目录中精确机器ID>","workspaceId":"<远端已登记Space ID>","command":["<远端Python绝对路径>","<远端team.py绝对路径>"]}]}
```

工作台通过现有 `workspace.list` 读取机器、Space 和可选名称，只用于组合展示。
会话与状态仍从所属机器读取；无法访问的引用显示状态未知，不按名字合并，也不授予权限。
`team.py` 用同一声明的 `command` 接单；平台不解释或执行该字段。声明存在时必须匹配唯一岗位，
无效声明不会回退到旧绑定。旧团队未声明 `members` 时仍兼容 `.genethub/remote-targets.json`。
