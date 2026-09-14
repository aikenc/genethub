# 会话组织与多设备统一导航：工程调研及提案

2026-09-06。状态：研究提案，未实施产品改造。

本文调整上一版以临时筛选为中心的方向。推荐“统一会话入口 + 可保存的个人分组/标签 + 批量整理”，在同一导航中聚合已授权设备。Agent 和 Session 继续保持原有执行身份、持久历史和权限边界。

## 1. 调研范围与可证明的现状

代码基线：Open `640d6b4`、Cloud `945e144`，双仓 dev-agent 槽位。规模样本通过本会话绑定的 `/root/.local/bin/genet-beta workspace list`、`session list` 读取，来自本 Space 实际所在 daemon，**不是上一轮的 dev smoke 数据**。只统计摘要，没有为分类读取各会话正文。

| Agent | 本次返回会话数 |
|---|---:|
| dev-agent | 45 |
| dev-chat | 35 |
| dev-ui | 31 |
| dev-1 | 27 |
| spaces-manager | 24 |
| dev-net | 21 |
| dev-0 | 19 |
| dev-daemon | 11 |

整体为 15 个登记 Agent、229 条返回会话。表中会话均没有 `managed` 标记；不能靠“隐藏内部 Worker”解决其管理规模。CLI 此次查询不代表包含所有已归档历史，也不能把多数返回 `idle` 解释成任务完成。

本地配对名册此次返回 0 条；这不代表 Hub 账号下没有设备，因为两份名单来自不同入口。本轮没有做多台真实设备的并发在线实验。以下多设备结论来自当前源码与协议结构，不能宣称多设备新 UI 已经实测通过。

### 当前链路

| 工程面 | 核对结果 | 对方案的影响 |
|---|---|---|
| 会话列表 | `ConversationList` 定时刷新；`RecentSessions` 对整个结果排序并渲染，操作主要逐条进行 | 少量过滤开关不能替代长期分类、批量整理和稳定阅读位置 |
| 摘要查询 | `session.list` 仅有 workspaceId / includeArchived；`SessionManager.list` 调 `SessionStore.list_meta` 遍历登记目录与 meta | 不能把多设备聚合简单变成每台每两秒完整扫描 |
| 会话元数据 | 有 title、status、archived、managed、lineage、messagePreview；没有个人标签、分组、置顶或跨端已读字段 | 持久同步的标签并非“纯 CSS 改动” |
| CRUD | 已有 session.create / rename / archive / delete | 单条操作可复用；批量编排、部分成功和条件检查需要补齐 |
| 删除语义 | Router 会撤销授权和清理绑定，Manager 会停止会话并删除历史、scratch 等 | 不能把它当成微信式“从我的列表移除”，也没有现成回收站承诺 |
| Workbench 状态 | 全局 `client`、sessions、workspaces、sessionTimelines 等；主连接 effect 清理时 close | 多设备列表需要改变前端数据所有权，不能只删掉设备选择器 |
| Fork / 转发 | `MachineCatalogPicker` 和 machineBroker 可读取其他机器目录；临时 Client 用完关闭 | 可复用目标选择与交换协议，但它不是常驻全局目录服务 |
| 设备发现 | `Host.targets()` 合并本地配对与账号设备，`openTarget(...remember:false)` 支持不切换主界面 | 可以作为跨壳设备发现与拨号入口 |
| Hub 目录 | `/app/workspaces` 返回账户级逻辑 Workspace 的 id/name/online/lastSeen/revision；placement 保留在服务端 | 已有跨设备 Agent 目录基础，但不是完整 WorkspaceInfo，也没有全局 Session 列表 |
| Fabric | `HubWorkspaceFabric` 支持一个 endpoint 上打开不同 Workspace 的流；当前 `openFabricDataLink` 自己构造 FabricEndpoint | 传输协议具备复用基础，生产 Client 接线仍需适配 |
| 多落点 | Hub 路由在多个在线 placement 时返回 ambiguous | 不能宣称同一 Agent 已支持自动跨机器调度或故障迁移 |

源码索引见文末。本文不以类存在、类型生成或公开目录可读代替完整产品路径已就绪。

## 2. 其他 App 值得参考什么

以下均来自产品官方文档或官方发布页。只借鉴交互与组织方式，不据此假定能直接复用其代码或同步协议。

| 产品 | 已有做法 | 适合 GeneHub 的部分 |
|---|---|---|
| 企业微信 | 官方版本说明包含按标签等分组筛选，以及手机端给项目聊天添加标签 | 用用户自己的项目/主题组织聊天；此处指聊天标签，不是客户 CRM 标签 |
| WhatsApp | 自定义 Lists 出现在聊天顶部，可加入单聊和群聊 | 手机顶部少量常用分组，建立和切换都直接 |
| Telegram | Chat Folders 支持规则与单独纳入/排除、置顶、跨客户端同步，支持批量整理 | “选 Agent 自动收集 + 单条例外”很适合一个 Agent 多 Session |
| Slack | 个人自定义 sections，可放频道、DM、应用，支持批量管理和各区排序 | 项目工作集跨多个 Agent，个人分类不改变同事的目录 |
| Teams | 将不同会话归入自定义 sections，再以快捷视图和状态筛选 | 日常分组与临时“未读/需要处理”互补 |
| Gmail | 个人标签、勾选批量操作、归档与删除分开 | 大量历史的整理效率；标签是附加归类，不是移动或复制会话 |

出处：

- [企业微信官方 App Store 版本说明](https://apps.apple.com/cn/app/%E4%BC%81%E4%B8%9A%E5%BE%AE%E4%BF%A1/id1087897068?platform=vision)
- [WhatsApp：Custom Lists](https://blog.whatsapp.com/focus-on-what-matters-with-custom-lists)
- [Telegram：Chat Folders](https://telegram.org/blog/folders)
- [Slack：Custom sections 与批量管理](https://slack.com/help/articles/360043207674-Organize-your-sidebar-with-custom-sections)
- [Teams：会话、频道与自定义分区](https://support.microsoft.com/en-us/teams/teams-channels/explore-the-new-chat-and-channels-experience-in-microsoft-teams)
- [Gmail：标签](https://support.google.com/mail/answer/118708?hl=en)、[归档和整理](https://support.google.com/mail/answer/9259770?hl=en)

推荐组合：**WhatsApp 的手机入口、Telegram 的动态分组、Slack 的项目组织、Gmail 的批量整理**。不照搬新的深层文件夹树，也不要求每次查找都重新填写一组条件。

## 3. 分组、标签、Agent、Session 各自承担什么

- Agent 是工作的对象；一个 Agent 对应多个独立 Session。
- Session 是一段可以续接、Fork、授权、归档的持久工作记录。
- 标签是用户对 Session 的多对多归类，例如“授权体验”“协议调研”；不修改 Agent Parent 或运行状态。
- 分组是保存下来的浏览视图，可收集多个 Agent、指定 Session、标签和必要条件；同一 Session 可以出现在多个视图里，但始终只有一份记录。
- 归档是已有的会话级状态，不等于完成、停止或删除。删除标签/分组只删组织关系，不删除会话。

用户只需先学会“添加到分组”。创建分组有两种方式：选几条会话手动加入；或者选 Agent / 标签，自动收集匹配会话。高级规则和排除项按需出现，不把规则编辑器放在主界面。

对当前兄弟 Agent，可以建立：

| 我的分组 | 收集规则示例 |
|---|---|
| 前端体验 | dev-ui + dev-chat 的普通会话，或带“UI体验”标签的指定会话 |
| Agent / 协议 | dev-agent + dev-daemon + dev-net；可显式包含协作执行记录 |
| 发布 | release-beta 等 Agent 的会话，以及手动加入的发布检查会话 |
| 本周跟进 | 手动关注的跨 Agent Session，不用 idle/running 推断业务是否完成 |

这是供用户确认的初始建议，不自动给现有 229 条会话乱贴标签。规则基于持久 ID，名字只是展示；新建的匹配 Session 自动进入分组，例外可以手动移出。规则优先级应固定：授权可见集合内，规则匹配与手动纳入取并集，最后减去显式排除；归档是否显示由视图的清晰选项控制。

分组不是会话的所有者，也不是项目工作流。WorkflowManager 无须理解或修改用户的个人导航分组。未来 Agent 可提出分类建议，采纳后才变成用户设置。

## 4. 日常入口与大量历史的管理

### 手机

```text
会话                            搜索   ＋
最近    前端体验    Agent/协议    ⋯
[未读] [需要处理]            [管理]
─────────────────────────────────
🐼 授权体验回归                 14:32
   dev-agent · 开发机 A
🦊 消息流性能                  昨天
   dev-chat · 笔记本 B
─────────────────────────────────
会话          Agent         发现         工具
```

顶部只保留少量常用分组；其余从一个完整分组列表进入，不能堆出几十个横向标签。Agent 和设备作为搜索/高级条件保留，设备默认是“所有已授权设备”，不再作为进入内容前的关卡。

分组内仍是一行一条 Session，完整名称优先。Agent 头像、Agent 名称与必要的设备副标题负责定位；不默认折叠成“一行一个 Agent”，否则一个 Agent 的 45 条会话又被藏进导航层级。

“Agent”底部页相当于跨设备联系人簿：选择一个 Agent 后优先展示其会话；下级 Agent 仍默认折叠。Agent 页与全局会话页复用列表行、操作菜单和选择组件。

### 桌面

同一模型显示为窄分组栏 + 会话列表 + 现有消息流。窄屏隐藏分组栏，通过顶部入口切换。所有分组是扁平的个人工作集；不重新造 Parent 树。

### 增删改查归档的具体路径

| 行为 | 建议体验与实现边界 |
|---|---|
| 新建 | 分组内点＋；只有一个适用 Agent 时预选，多个时明确选目标 Agent。选目标后直接路由所属设备，设备作为执行位置展示。继承适用的个人分类，不因打开分组就创建 Session |
| 重命名 | 行菜单或桌面快捷操作内联编辑，失败恢复原名。批量改名不是首版刚需 |
| 查找 | 搜索 Agent、会话标题、标签；可以切换当前分组/所有会话，并显式包含归档。不把标题搜索冒充消息全文搜索 |
| 批量整理 | 手机长按或“管理”、桌面复选框/快捷键进入选择模式；固定工具栏支持加标签、加入分组、关注、归档/取消归档 |
| 移出分组 | 只改手动关系或建立规则排除项，保持 Session 与历史不变 |
| 归档 | 复用已有 archive RPC；返回明确结果，成功项可取消归档。首版不默认因为工具心跳或新消息而自动取消归档 |
| 删除 | 独立危险操作，显示将删除持久历史且可能停止运行。现有 delete 不提供回收站，不画不存在的“撤销删除” |

跨分页“全选”必须区分当前已加载 N 条与全部匹配 M 条。批量操作开始时冻结目标引用集合；后续新到会话不加入这次删除或归档。跨设备逐项返回成功、失败、结果待确认，不能把部分成功显示为全部完成。

首版可用已有单条 RPC 做有界并发的批量归档，不需要分布式事务。批量永久删除风险更高：列表预检查不能消除执行开始的竞态；若要保证跳过已变为运行态的会话，应在 daemon 增加原子条件检查后再开放该批量能力。结果不明时先回读，不盲目重发破坏性操作。

当前 archive 是写入 SessionMeta 的会话级状态，所有客户端会看到。个人标签、关注、分组和阅读位置必须另存，不能顺手把“我整理列表”变成全体使用者的共享业务修改。

## 5. “天然多设备”需要分清两件事

**本期建议支持：不同设备上的 Agent 和会话在同一列表里，打开时自动找到原设备。** 用户不再手工先切设备。

**另一个独立问题：同一个逻辑 Agent 的相同会话和工作目录在多台机器之间复制、迁移或负载均衡。** 这需要历史、文件、运行归属和并发写入合同；不能作为统一列表顺带实现。现有多个在线 placement 返回 ambiguous，正说明不能任选一个落点。

多个电脑上同名的 `dev-ui`，甚至同一个仓库的副本，首版仍是不同执行实例；显示设备副标题，可放进同一分组。不能按名称、目录或 Git remote 自动合并身份。

### 长连接的真实层次

1. daemon → Hub/Relay 的上行与在线心跳，让设备能够被发现和路由。
2. 浏览器 → Fabric 的物理连接，负责承载流。
3. 浏览器 → 目标 daemon 的认证 peer link / RPC，以及具体 Session 的订阅。

第一层在线不意味着第三层已对每台机器建立。当前主 UI 切设备会清理旧 Client，Fork/转发的额外 Client 是短期使用。底层能承载多流，不代表生产 Workbench 已经复用了一个跨设备长连接池。

### 推荐的渐进实现

**先让用户体验统一，再复用传输。** 第一阶段可用现有 Client 建有界的按设备连接池，后台独立读取摘要，前台打开会话时复用对应 Client；用户不再操作设备切换器。不要为此先重写 Client 加密和重连协议。

同 Hub 的第二步适配现有 Fabric：连接池共享一个物理 endpoint，每台目标设备保留自己的 peer 握手、密钥、RPC 与重连状态。要让 `openFabricDataLink` 能基于外部已打开 stream 构建数据链，并明确共享 socket 的所有权；关闭一个 peer 不能关闭整条共享连接。旧的独立连接适配保留给 LAN、loopback、直接配对和不同 Hub。

后台目录/摘要维持轻量逻辑连接；仅对打开或确有实时需要的 Session 订阅完整信息流。多设备长连接不等于订阅几百条会话，也不等于为每条 Session 建物理 socket。移动浏览器被系统挂起时不能承诺后台永远在线，恢复靠重连和持久快照。

## 6. 身份、路由和状态必须一起改

建议在前端增加统一引用，不修改 daemon 原有 Session ID：

```ts
AgentRef = { deviceIdentity, workspaceId, accessScope }
SessionRef = { deviceIdentity, workspaceId, sessionId, accessScope }
```

`deviceIdentity` 使用连接身份与目录映射确认的稳定设备标识；`accessScope` 保留账号/Hub/配对授权来源。Hub machine id、配对 route id、daemon identity 和 Hub Workspace id 不是同一命名空间。合并目录要保存显式映射，不能把临时票据、IP、显示名当身份，也不能因两条路径指向同一设备就合并它们的权限。

Hub 逻辑 Workspace ID 本来就不同于 daemon-local workspaceId；它可作为 Hub 目录引用和路由地址，不能直接塞给要求本地 ID 的 RPC。全局 Agent 简要目录不包含完整 Parent/Component/Root，仍须经已授权的目标查询取得这些事实。

需要调整的前端结构：

- `Host.targets/openTarget` 继续负责发现和拨号；新增多目标连接所有者，不让后台拨号触发 `onOpened` 导航。
- 列表摘要按设备分区缓存、汇总；连接中、已同步、离线旧快照、无权限分别表达。
- 当前 `useWorkbench.client` 改为连接注册表与显式实体上下文。Timeline、Composer、授权、模型列表、文件、Git、终端和 Preview 均从目标引用选 Client，不依赖最后一次切中的全局机器。
- `sessionTimelines`、打开页、草稿、滚动锚点、未读标记和异步请求防过期校验使用完整引用作为 key；旧本地偏好仅在明确原设备归属后迁移。
- 创建、重命名、归档、删除、批准、Fork/转发分别路由到目标设备；摘要缓存不能成为写入权限来源。
- 一个设备断线不让其他设备页面重置。设备被撤权后不能继续把缓存作为有效授权；显式退出账号后清理该账号的可见目录与连接。
- 发送内容和批准时仍清楚显示 Agent 与执行位置；免切设备不意味着隐藏操作对象。

这属于有边界但不算小的前端状态改造。各家 Agent adapter、Session/round 执行模型与授权生命周期不需要因它重新设计。

## 7. 查询规模、离线和全局排序

不能把当前全量 session.list 两秒轮询乘以设备数。当前 229 条摘要可以先作为性能基线；本轮没有测量多设备首屏耗时，不能虚构性能预算达标。

第一阶段：每设备摘要只加载一次并复用；请求合并、防重复刷新，前台、后台和离线设备采用不同调度；连接恢复时重新同步。列表虚拟化或分段渲染按实测决定，消息流继续用已有最近轮次/分页。

第二阶段建议小范围协议增量：增加轻量目录版本/失效通知，让新增、改名、归档、删除、状态变化可触发有界刷新，而不是订阅所有 Session。通知缺失或版本断层时回读现有快照，旧 daemon 继续使用降频轮询。

若设备会话量进一步增长，再增加摘要查询的稳定游标、过滤范围和版本；按每设备页合并全局有序结果。不能只拿每台最近十条再过滤标签，就宣称历史里没有匹配项；总数与完整性也不能由已加载页猜测。

离线设备保留缓存条目并标明“离线 · 上次同步”，不会从联系人簿突然消失。已读过且有缓存的历史可按现有缓存覆盖显示；没有缓存的内容说明需设备在线。禁止把离线点击发送默默改投到另一个同名 Agent。恢复写入需重新鉴权并保持原目标。

跨设备搜索显示覆盖情况，例如“已检索 3/4 台，1 台离线”；空结果与部分结果分开。工作目录、文件内容和会话正文仍留在原设备，不为统一导航新增 Hub 全量消息仓库。

## 8. 个人分组和标签放在哪里

现有协议没有可跨端同步的个人分组/标签存储。只写 localStorage 可以验证交互，不能作为最终多设备体验交付。

建议定义中性的 `NavigationPreferences` 存储接口，保存用户自己的标签、分组规则、显式成员/排除项、关注和排序。Agent 的业务配置、Parent 与 Session 执行记录继续由 daemon 管理。

- 有 Hub 账号：用小范围账户偏好接口持久化组织元数据，绑定用户，支持版本化 patch/CAS、条目删除与并发冲突。它不是全局会话索引，不上传正文、绝对路径和运行凭证。标签名也属于用户信息，不能宣称这一扩展完全没有新的信息存储。
- 本地/直接配对无账号：Host 提供本地持久实现；是否能同步明确标识。没有账号或同步服务时，不伪造跨浏览器一致性，也不把某台随时会离线的目标 Agent 当作所有设备个人设置的隐式主库。
- 标签的 ID 稳定，改名不改所有 Session；移除标签只删除关联。个人标签不自动写进提示词，也不自动共享给其他用户。
- 现有阅读标记和自选 Emoji 是本地偏好。跨端同步要另接个人偏好合同；未读的推进规则不能简单对随机 message item ID 取最大值，需有可比较的持久顺序或服务端版本。

该部分需要新增少量 Hub/Host 能力；不能再写“完整目标协议改动为零”。

## 9. 修改范围和实施次序

| 工作 | 前端 | daemon / 协议 | Hub |
|---|---|---|---|
| 分组、标签、批量选择与操作进度 | 新增共享组织模型和 UI | 归档/改名复用现有 RPC；安全批量删除可选条件扩展 | 同步个人组织元数据需新增偏好接口 |
| 聚合所有已授权设备 | 连接池、带身份的摘要缓存、统一列表 | 初版复用现有目录/Session RPC | 复用机器与逻辑 Workspace 目录 |
| 打开会话无需手工切设备 | Composer/Timeline/文件/授权等显式绑定目标 | 复用原执行和权限语义 | 复用路由和鉴权 |
| 同 Hub 共用 Fabric socket | 数据链构造与连接所有权适配 | 不改执行模型；复用现有帧与 peer 合同 | 复用已有 endpoint/routes，核对限额 |
| 大规模列表实时更新 | 快照与版本、失效合并、旧端回退 | 建议小增量：摘要目录版本/通知；分页按实测追加 | 不增加消息内容库 |
| 同一 Agent 跨设备迁移/多活 | 独立产品课题 | 涉及文件、历史、执行所有权，不是本提案范围 | 现有 ambiguous 行为保持 |

推荐分三段：

1. **统一身份与目录**：先把 AgentRef/SessionRef、Host 拨号、每设备摘要缓存和连接池打通，列表可以聚合，写操作精确回到原设备。沿用现有消息流；个人组织设置先有明确存储接口。
2. **组织与整理闭环**：上常用分组、标签、自动收集 Agent 会话、批量归档、搜索覆盖与跨端偏好同步。用真实兄弟 Agent 规模验收，解决日常管理负担。
3. **连接和规模优化**：同 Hub 共用 Fabric、目录失效通知、必要的摘要分页和缓存恢复。性能优化要绑定测量，不能以新框架替代事实验证。

连接池与组织模型可按前后依赖逐步交付；不得先上线一个看似跨设备、发送仍使用旧全局 Client 的列表。

## 10. 验收必须证明的事情

- 当前兄弟 Agent 的规模能一次归档选定会话、批量加标签；无需逐个打开聊天。归档仍可查，删分组不删历史。
- 同一 Session 可出现在多个分组；按 Agent 自动收集未来会话；Fork 不因 lineage 自动成为内部任务。
- 一个 Agent 下大量会话、多个同名 Agent、受管 Worker、无 managed 的 Executor 分别覆盖。
- 两台设备各有同名 Agent，来回打开、发送、批准、文件预览、终端和模型选择均命中正确设备；有磁盘/协议事实证明。
- 一台掉线、撤权或重启，不中断另一台；显示部分结果，重连不能重放旧批准或重复发送结果不明的命令。
- 同一设备通过本地和 Hub 同时出现时不会重复，也不会因去重扩大权限。
- 批量操作按已确认目标集合执行；新增记录不意外加入，失败逐项展示，已成功归档可恢复。
- 手机长列表、选择模式、筛选和软键盘场景下，动作栏与底部导航可达；返回保存锚点。
- 手机/桌面个人分组并发修改有可解释的冲突处理；退出账号后不会串用另一个账号的组织数据。
- 记录首屏摘要耗时、打开 Session 的可交互耗时、长任务/帧稳定性、连接/订阅数及后台扫描次数；先设基线再定门槛。本轮研究不声称这些指标已通过。

## 工程依据

- [会话列表](../packages/workbench/src/app/ConversationList.tsx)
- [共享列表行与现有操作](../packages/workbench/src/shell/ConversationRows.tsx)
- [Workbench 主连接及跨机交换](../packages/workbench/src/app/WorkbenchApp.tsx)
- [全局 Store、摘要和订阅](../packages/workbench/src/session/store.ts)
- [Host 发现和拨号](../packages/workbench/src/host/index.ts)
- [已有跨机选择组件](../packages/workbench/src/session/MachineCatalogPicker.tsx)
- [现有 RPC](../packages/proto/src/rpc.rs)、[摘要对象](../packages/proto/src/domain.rs)
- [SessionManager](../apps/daemon/src/session/manager.rs)、[文件持久化与列表扫描](../apps/daemon/src/session/store.rs)
- [资源路由 Fabric 适配](../packages/workbench/src/fabric/hub-workspaces.ts)、[当前数据链构造](../packages/workbench/src/dataplane/fabric.ts)
- [Cloud Host](../../genethub-cloud/console/src/host.ts)
- [Hub Workspace 目录与路由](../../genethub-cloud/server/src/http/workspaces.ts)、[placement 解析](../../genethub-cloud/server/src/store.ts)、[数据库边界](../../genethub-cloud/server/src/db.ts)
- [安全模型](security-model.md)、[当前 Web 工作台设计](web-workbench.md)
