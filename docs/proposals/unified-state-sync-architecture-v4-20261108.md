# GeneHub 统一信息同步架构 v4：分层节点与校验 hash

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

> 已被 [v5 统一节点同步体系](unified-node-sync-system-v5-20261108.md) 取代，以 v5 为实施依据。本文的源码证据（第 2、4.1、7、8.1 节）和业界案例（第 3.4 节）继续作为 v5 的依据。

状态：待评审；只是提案，尚未实现，也未部署。日期：2026-11-08。

修订记录（同日）：
- 列表分页与分层统一为"索引节点 + 分段"（已被第三次修订的视图窗口取代）。
- 推送与比较共用同一个函数，见 5.3。
- 断线恢复改为通常一次往返，见 5.2。
- 第三次修订：把易变列表当作一类设计冲突重新处理，按变化频率选择机制；列表改为"视图窗口"，即带游标、可订阅的查询，取代第二次修订中由内容决定的分段（过度设计）。补充业界案例对照（3.4）、CLI 解决方案（8.1）、协议流转与三层一致性（5.5）。查询并入同步帧，核心协议减为四类（5.4）。
- 第二次修订：评估分页这类易变关系的适用性，分段改为由内容决定，daemon 重启后保持不变（3.4）；补上 daemon 内存层（4.1）和 CLI 性能风险（8.1）；列出核心协议（5.4），并把迁移改写为带代码位置的重构步骤（第 10 节）。

本文取代 [v3](unified-state-sync-architecture-v3-20261108.md)。v3 中的问题分析、数据源分类、关系设计、体验旅程和信息族映射都沿用，但做了两处收窄：
- 去掉 Git 式的版本管理。
- hash 只作为校验值，用来判断"要不要更新"。

v1 的接口审查和原型实验仍作为历史证据。源码基线：Open `origin/main` `193aa152`，Cloud `e7dd53e`。

本文覆盖 GeneHub 全部信息的读取、变化传播、缓存和修改回执，消费端包括 daemon、浏览器、CLI、团队脚本、其他机器和 Hub。实时媒体与信令、连接认证、更新包签名不在范围内，原因见第 7 节。

## 摘要

**体验影响。** 下面这些现象表面不同，根源都是信息同步效率低：
- 重开或重连慢，手机恢复慢。
- 列表之间互相放大开销。
- 文件和 Git 面板不会自动更新。
- 团队脚本轮询，加重 daemon 负担。
- 跨机器每次都从头读。

每类信息各有一套同步方式。它们的共同缺陷是：
- 没有能跨进程、跨重启比较的"是否需要更新"标记。
- 不能只读需要的那一层。
- 变化传播不统一。
- 没有共享缓存。

**怎么解决（待实施）。** 所有信息统一表示成一棵棵**分层节点**：
- 每个节点带一个**校验 hash**，由拥有方根据节点数据和子节点的 hash 算出。比较一个 hash，就能知道这个节点及其下面的所有内容是否需要更新。
- 按变化频率选择机制：稳定数据用 hash 树；按轮次变化的数据（摘要、列表顺序）用 hash 校验加推送；每秒都在变的数据走流或不进入 hash。
- 列表是"视图窗口"：一次带游标的查询，只返回有序 id，可以订阅。对象按 id 缓存和校验，这才是缓存收益的主体。
- 有变化时，拥有方用同一个比较函数，按各连接"已告知的 hash"推送差异。
- 推送丢了也没关系，下次比较 hash 就能发现。
- 断线后，客户端带上自己订阅范围内的已知 hash，通常一次往返就能补齐。
- daemon 的内存里只有一份数据，即各族的内存读模型。同步内核只记 hash，不另存数据副本。
- CLI 直接读 daemon 的内存读模型：本地查询一次完成，不再循环翻页；远端查询走本地 daemon 维护的副本。

整套机制只有三个概念：节点、校验 hash、变化通知。修改仍然走现有命令。不保存历史版本，不按 hash 存取对象，不需要回收。旧的分族同步路径在对应阶段一并删除，旧版本兼容做了简化。

**如何避免复发。**
- 7 条内核规则（第 4 节），用共享的合同测试守住。
- 每族上线前按同一张验收表核对（第 9 节）：内容不变时重连、单次修改、故障恢复。
- 防回流测试，确保消费者不再调用已迁移族的旧读接口或旧推送帧。

## 1. 为什么 v3 不够简洁

v3 把 hash 当作"版本身份"，于是不得不同时管理历史版本。下表列出 v4 删掉的部分，以及代价：

| v3 机制 | 为什么出现 | v4 的处理 | 失去什么，为什么可以接受 |
| --- | --- | --- | --- |
| 按 hash 存取的不可变对象库 | 把 hash 当作数据身份 | 删除。节点按**路径**存取，内容原地更新 | 无法跨位置复用相同内容；本项目不追求这一点 |
| 拥有方保留最近 8 个根，用来计算差异 | 断线后想一次往返拿到差异 | 删除。在线时靠推送；断线后，客户端在 `check` 里带上订阅范围内的已知 hash，拥有方一次算出差异（见 5.2） | 基本没有损失。已知 hash 表的长度只与订阅范围有关，与历史总量无关 |
| pin、回收、闭包检查 | 版本要保留，还要判断是否收齐 | 删除。客户端删掉拥有方已不再列出的子节点即可 | 无 |
| 旧根到新根的变化链和 `changeId` | 保证事件按版本连续应用 | 删除。通知就是"节点 X 现在的 hash 是 H"，重复应用没有副作用 | 无。漏掉的通知由下次比较发现 |
| 读取时的一致快照 | 不可变版本附带的能力 | 不提供整树快照。以"最终 hash 一致"作为已同步的标准 | 同步过程中可能短暂地新旧混合。页面可以接受；分页是带游标的视图查询，不依赖快照（见 3.4） |
| 客户端用 WebCrypto 校验 hash | 对象按 hash 存储时需要防止串改 | 删除。客户端只保存拥有方给出的 hash，从不计算 | 传输本身已经认证；hash 的用途只是判断是否需要更新 |
| 把封存的文件当作原始对象、用 inode 提示缓存 | 内容寻址 | 删除。文件内容继续使用现有的 `file.read`（带 offset 和 SHA-256 expect） | 无 |

v4 保留了 v3 中真正解决问题的部分：
- 分层，读者只付自己所读那一层的代价。
- 父 hash 汇总子 hash，比较一个值就能确定一整棵子树是否需要更新。
- 统一推送。
- 统一缓存。
- 同一协议服务所有消费者。

**为什么用 hash 而不是修订号。** 修订号只在一个进程实例内有效：daemon 一重启、换了一个生产者，或者到了另一台机器，就无法比较。hash 由内容决定，相同内容在任何时候都得到相同的值，所以 daemon 重启后，客户端也能确认"不需要更新"。这是 hash 唯一不可替代的价值，也是本设计使用它的唯一理由。

## 2. 问题现状（源码阅读，未实测）

| 信息族 | 现在怎么同步 | 低效或不可靠之处 |
| --- | --- | --- |
| 会话目录 | `catalog.sync` 使用内存修订号，浏览器上传已知清单（最多 12,000 项），daemon 逐条投影 | 成本随历史量线性增长；daemon 重启后只能整份修复 |
| 会话正文 | `subscribe sinceSeq` 重放加快照；`read_view` 先构造全量再截页 | 读一页的成本随整段历史增长 |
| Agent、进程 | `AgentsChanged`、`BackgroundProcesses` 每次推送整份列表 | 一项变化就全表重传 |
| 文件、Git | 只在挂载或手动刷新时读取；超过 2,000 项或 10,000 节点时静默截断 | 外部改动看不到，截断后被当成完整 |
| PTY、日志 | 原始字节帧、尾部读取 | 断线后接不上 |
| 设置、设备、更新、Hub | 请求一次响应一次，各页面各自重读 | 不同页面看到的状态不一致 |
| CLI、团队 | 翻页到末页；`board.py` 周期性读完整活动集合 | 轮询，重复读取 |
| 跨机器 | 每次 `--machine` 都完整走一遍 Fabric | 没有本地副本 |
| 浏览器缓存 | 只缓存目录，且每次整份重写 | 写入放大，其他族没有缓存 |

证据位置：
- [catalog.rs](../../apps/daemon/src/session/catalog.rs) 第 279–387 行。
- [rpc.rs](../../packages/proto/src/rpc.rs) 中 `ServerFrame` 的定义（第 1326 行起）。
- [FilesPanel.tsx](../../packages/workbench/src/files/FilesPanel.tsx)。
- [summary-directory-cache.ts](../../packages/workbench/src/protocol/summary-directory-cache.ts)。
- v1 [接口审查](layered-sync-interface-audit-20261108.md) 第 334–362 行。

## 3. 数据模型

### 3.1 节点、校验 hash、变化通知

| 概念 | 定义 |
| --- | --- |
| **节点** | 拥有方对外暴露的一份数据，用路径唯一标识，内容原地更新。节点分三种：<br>• **实体**：按所有权路径存放，例如 `session/s_1/summary`、`session/s_1/state`、`workspace/w_1/head`、`agents/a_1`。key 稳定的容器（目录清单、时间线的已封存分段）也是实体，带子节点列表 `[(名字, hash)]`。<br>• **视图**：一次带参数的查询结果，只含有序的 `[(id, 排序键)]`，例如 `sessions.recent?ws=w_1&limit=100`。视图按需计算，不存放，也不汇总进任何父节点（见 3.4）。<br>• **流**：只追加的尾部，见下文 |
| **校验 hash** | `hash = H(节点自身数据的字节 + 子节点的 (名字, hash) 列表)`，只由拥有方计算。视图的 hash 只覆盖 id 和顺序，所以实体内容变化（例如运行状态）不会改变视图的 hash。用 SHA-256 截取 128 位，以十六进制表示。相同内容得到相同的 hash，与进程、时间无关。它只回答"你手里的这一层及其以下，是否和我一致" |
| **变化通知** | 与 `check` 的回复使用同一格式 `{path, hash, data?, children?}`，包含变化的节点和它们的祖先。由拥有方按每个连接的"已告知 hash"比较后发出（见 5.3）。客户端按路径直接覆盖，重复应用没有副作用 |
| **动作** | 现有的 typed 命令，回复附带它造成的变化通知 |
| **流尾** | 只追加的数据（会话时间线、PTY、日志），已封存的段是普通节点，活动尾部按 `seq` 追加 |

用户最初提出的"事件 hash"，在这里就是通知里携带的节点新 hash：收到 `(path, hash)` 后，与本地相同就忽略，不同就更新。

**例子：会话 `s_1` 改名，A 改为 B。** 现有实现中改名会刷新 `updatedAt`（`manager.rs` 的 `rename`）。
- 拥有方更新实体 `session/s_1/summary`，约 600 B。
- `s_1` 移到 `sessions.recent?ws=w_1` 的最前面，被订阅的视图的 id 列表随之变化，100 条约 3 KB。
- 每个连接只收到它订阅范围内变化的部分：看着这个列表的，收到摘要和新的 id 列表；只打开了 `s_1` 详情的，只收到摘要。其他摘要都不动。

### 3.2 数据源：四类，各自的变化检测方式

| 类别 | 例子 | 变化检测方式 | 可靠性边界 |
| --- | --- | --- | --- |
| A 持久事实：daemon 自己写 | 会话 `meta.json`（标题、标签、归档、模型参数、草稿、待处理权限、inbox、执行围栏、lineage 同在一个原子文件中）、会话正文文件、工作区 registry、Space 描述、各类配置、设备与批注存储 | 在写入点直接更新节点，例如 `Store::save_meta`、`append_round`、registry 保存 | 最可靠 |
| B 外部事实：daemon 只能观察 | **项目文件夹本身**（是否存在、名字、所在卷是否在线）、项目内文件、Git、其他程序写入的 Space 描述、团队协调器的投影、Hub 数据 | 有订阅时启用 watcher，订阅时做一次有预算的对账；Hub 在其事务提交时更新节点 | 可能晚到或漏报，必须带观察时间，可以标为"未知" |
| C 运行观察：只在内存中 | 会话运行状态、内存中的待处理权限、进程、PTY、机器在线状态、daemon 版本 | 状态跳变时更新节点；节点带拥有方实例的 epoch | 拥有方重启后需要重新观察 |
| D 派生视图 | 会话摘要、活动集合、项目状态卡、显示名、计数 | 任一输入变化时，按依赖表重算 | 不单独持久化 |

**文件夹名也是数据源。** 工作区名默认在注册时取自文件夹名并复制进 registry（`workspace.rs` 第 1580–1585 行），会话数据又存放在项目文件夹内的 `.genethub/sessions/` 下。文件夹改名或移走后：
- 项目节点应标为"根路径不可用"。
- 其下的会话标为"未知"，不能当作已删除。
- 用户重新定位（这是一个动作）后，项目和会话恢复。

**不进入 hash 的内容：** 相对时间、心跳、探测时间、token 计数。否则 hash 会持续变化，判断是否需要更新就失去了意义。

### 3.3 节点的划分与关系

**怎么划分节点：** 按"变化频率 × 谁来读"拆分。同一个业务实体可以对应多个节点，例如一个会话拆成 `session/<id>/summary`、`state`、`timeline` 三个节点。
- 摘要只存在于 `session/<id>/summary` 这一处。
- 视图里只放 `(id, 排序键)`，不复制摘要内容。
- 正文逐 token 增长时，不会让摘要和列表的 hash 跟着变。

| 关系 | 表示方式 | 例子 | 理由 |
| --- | --- | --- | --- |
| **包含**（层级；随父节点一起删除） | 路径层级。父 hash 汇总子 hash | 会话 → 摘要、状态、时间线 → 轮次段；目录清单 → 子目录 | 比较一个 hash 就能确认整棵子树 |
| **关联**（指向独立的实体） | 数据字段里只写稳定 ID，跨机器时附带 `machineId`。不计入对方的 hash | 会话 → 项目、会话 → Agent、fork 父会话、团队成员、制品 → 会话、Hub placement → daemon 工作区 | 改 Agent 名时，不应该让所有会话的 hash 都变；目标消失时显示"不可用"，不级联删除 |
| **派生**（计算得出） | 发布者声明依赖表：哪个输入变了，就重算哪些节点。视图也是派生物，但只依赖排序键和成员资格 | 摘要 ← meta + 运行状态 + 协调 + 交互；`sessions.active` ← 全部摘要的 `isActive`；`sessions.recent` ← 会话按 `updatedAt` 排序；项目状态卡 ← 成员摘要 + 团队 + Git | 只在一处计算，各端得到同一个结论 |

**补充规则：**
- 派生只在同一拥有方内部完成。跨拥有方的汇总由消费端用 ID 现场组合，缺失的来源标为"缺源"，不能当作 0。
- 列表是视图，规则见 3.4。
- 追加型序列（轮次、日志段）每 256 个归为一个分段节点。已满的分段不再变化，只有最后一个会变。

### 3.4 易变列表：一个典型的设计冲突

**冲突在哪里。** hash 树要求分区稳定，同一个 key 总落在同一处，比较时才能整片跳过。用户要的列表却按易变字段排序，最常用的是"最近活动"。两边很难同时满足：
- **按稳定 key 分区**（id 的 hash 或创建时间）：分区稳定，但与浏览顺序无关。看第一页得先拿到全部成员，再在本地排序。按创建时间排序也不符合"最近在忙的排在前面"的实际需要。
- **按易变 key 分区**（`updatedAt`）：与浏览顺序一致，但条目会在分区之间移动。要让分区边界在重启后保持不变，还得设计专门的切分规则。

第二次修订选了后者，并设计了由内容决定的切点。这能做到，但只为一种列表引入了一套切分算法，属于过度设计。

**业界怎么做。** 成熟系统几乎都把"对象"和"列表"分开处理：对象按 id 缓存和校验，列表当作便宜、可重算的查询，只返回 id。

| 案例 | 易变列表的处理 | 对本方案的借鉴 |
| --- | --- | --- |
| JMAP（RFC 8620，邮件和日历协议） | `Foo/query` 按排序返回 id 列表和 `queryState`，`Foo/queryChanges` 返回增删；对象用 `Foo/get` 读取，用 `Foo/changes` 按 `state` 增量同步 | 列表只给 id，对象单独校验。本方案用 hash 代替 `state`；视图窗口小，变化时直接整窗替换，省掉 `queryChanges` |
| Firestore | 分页是 `orderBy().limit().startAfter(游标)` 查询；实时监听推送 `added/modified/removed` 和新旧位置；用 resume token 续接 | 分页就是带游标的查询，实时窗口就是被监听的查询，不缓存"页" |
| Discord 成员列表懒加载（社区文档） | 客户端订阅可见区间（如 0–99），服务端在区间内推送插入、删除、更新和失效 | 只订阅可见区间。本方案窗口小，整窗替换即可，不需要多种操作类型 |
| Linear 同步引擎（公开技术分享） | 对象存在本地 IndexedDB，启动时整批加载，之后按单调递增的同步序号拉增量；列表在本地对象上排序 | 对象缓存是收益主体。不照搬全量本地化：会话数量大，而且分布在多台机器上 |
| Replicache 与 Zero（Rocicorp） | 服务端为每个客户端维护"客户端视图记录"，记录已经发给它的行和版本，据此推送差异 | 与本方案的已告知 hash 表同构，说明这条路在生产中走得通 |
| IMAP CONDSTORE/QRESYNC（RFC 7162） | 每封邮件有修改序号，重连时带上已知 UID 和最高序号，一次拿到变化和删除 | 一次往返重同步。本方案用已知 hash 代替全局递增序号，跨重启、跨进程同样成立 |
| Cassandra、Dynamo 的 Merkle 反熵 | 只对 key 稳定的区间建 hash 树，用来比较副本 | hash 树只用在 key 稳定的地方，比如目录清单和时间线分段，不用在按易变字段排序的列表上 |
| HTTP ETag 加 stale-while-revalidate | 先展示缓存，再后台校验 | 打开时先显示"上次状态"，核对后再标为"已核对" |

**本方案的做法：按变化频率选机制，不用一种机制硬套所有对象。**

| 变化频率 | 例子 | 机制 | 缓存收益 |
| --- | --- | --- | --- |
| 稳定：小时级以上 | 工作区、Agent、设置、时间线已封存分段、文件内容、目录清单 | 实体加 hash 树（key 稳定，容器汇总子节点） | 最大，重连通常整片 `same` |
| 按事件变化：随轮次、分钟级 | 会话摘要、`state`、列表顺序、活动集合 | 实体加 hash 校验加比较式推送；列表用视图窗口 | 明显：只重传变了的少数对象 |
| 高频：每秒或更快 | token 增长、PTY 输出、进度、心跳、相对时间 | 流（`sync.append`），或者不进入 hash | 不缓存，也不需要缓存 |

**视图窗口的定义：**
- 一个视图就是一次查询：`{view: "sessions.recent", ws, labels?, source?, after?, limit}`，结果是有序的 `[(id, 排序键)]`。
  - `after` 是现有的键集游标 `(updatedAt, id, workspace)`。
  - 视图的身份就是规范化后的查询串，例如 `sessions.recent?ws=w_1&limit=100`，在 `known` 和已告知 hash 表中作为键。
- 拥有方在内存读模型的有序索引上计算视图（`PageCatalog.order` 已经是按 `(updatedAt, id, workspace)` 排序的 `BTreeMap`），代价与窗口大小成正比，不存放结果。
- 视图带 `watch` 时，排序或成员变化会让该视图变脏，然后用与其他节点相同的比较函数推送新的 id 列表。条目的内容由各自的实体节点推送。
- **页面**：首屏订阅 `limit=100` 的头部视图；向下滚动时把 `limit` 加大到 200、300，最多 1,000。跳到很深的位置时改用 `after` 锚定的窗口。页面不需要自己管理游标。
- **CLI**：`--limit/--cursor` 就是 `limit/after`，与页面同一个机制；列全部时不翻页，见 8.1。
- **筛选与其他排序**：标签、来源是视图参数，在内存读模型上过滤。搜索和按标题排序之类同样是视图，只是通常不订阅。
- 已声明的视图：`sessions.recent`、`sessions.archived`、`sessions.active`（全机活动集合，通常不足 100 条，不分页）、`workspaces`、`agents`、`processes`。

**为什么不追求完美也够用。** 用户说得对：只要变化不是每秒都在发生，缓存就仍然有收益。
- **收益估算**：重连时只需重传"上次核对以来变了的对象"。
  - 列表顺序大约每轮变一次。以 5 个 Agent 工作、手机断线 10 分钟为例：头部视图的 id 列表约 3 KB，变了的摘要约 5–20 条、不超过 12 KB；不用缓存则要重传 100 条摘要，约 60 KB。
  - 列表静止时，回复只有几百字节。
- **最坏情况**：几乎所有对象都变了，这时就是一次全量读取，只比不用缓存多上传一份 `known`（约 5 KB）。所以缓存的代价有上界，收益没有下限风险。
- **刻意不做的**：
  - 不做段内或窗口内的增量操作（insert/move/delete），整窗替换的成本已经足够低。
  - 不建全局排序的 hash 树。
  - 不对"页"做稳定缓存。
  - 测量证明需要时，再参考 JMAP 的 `queryChanges` 增加增量。

### 3.5 体验旅程

| 旅程 | 发生什么 |
| --- | --- |
| 打开工作台，三台机器 | 先显示本地缓存中每台机器的头部视图和摘要，标为"上次状态"；每台机器一次 `check`，带上视图和摘要的已知 hash，核对后标为"已核对"；一台离线时只标它为未知 |
| 进入项目页看团队进展 | 订阅 `workspace/<id>` 和视图 `sessions.recent?ws=<id>&limit=100`；成员摘要按 ID 读取 `session/<id>/summary`，已有的不重复下载 |
| 打开 3,000 轮的会话并继续对话 | 只读 `summary`、`state`、时间线的最后几个分段和活动尾部；往上滚动时再取更早的分段，不需要游标；发送消息是动作（`messageId`） |
| Agent 在后台请求权限 | 运行状态变化后，依赖表更新 `state`、摘要和 `sessions.active`；各订阅者在一条通知里收到各自范围内的变化 |
| 在 Finder 里改项目文件夹名 | 对账发现根路径不存在，项目节点标为"根路径不可用"，会话标为未知；重新定位后恢复 |
| 外部编辑器改文件或执行 `git checkout` | 有订阅的目录和 Git 节点由 watcher 触发更新 |
| PM 脚本看全队状态 | `--watch` 订阅，空闲时没有流量；远端机器由本地 daemon 的副本提供 |
| 手机断线 10 分钟后恢复 | 一次 `check` 带上订阅范围内的已知 hash，拥有方一次返回全部变化节点（通常是头部视图的 id 列表和几条摘要）；时间线按 `tailSeq` 续接 |
| 把会话 fork 到另一台机器 | 新会话用 `machineId + sessionId` 关联父会话；父会话变化不影响子会话的 hash |
| 改一个 Agent 的显示名 | 只有 `agents/<id>` 及其祖先节点变化；会话列表展示时按 ID 取名字 |

## 4. 分层架构与内核规则

| 层 | 唯一所有者 | 只负责 |
| --- | --- | --- |
| L0 事实源 | 现有模块（Store、registry、文件系统、进程、Hub SQLite） | 持久事实与原子写入，格式不变 |
| L1 内存读模型与发布者（每族一个） | 与 owning 模块放在一起 | daemon 内唯一的一份内存数据（见 4.1）；把事实投影为节点；在写入点或观察到变化时更新；声明依赖表；按路径提供节点数据 |
| L2 同步内核 | 一份合同，有 Rust 和 TS 两个实现 | 节点 hash 表（daemon 端不存数据）、hash 汇总、视图计算、订阅范围、比较函数（`check` 与推送共用）、已告知 hash 表、流尾、有界传输、本地持久化 |
| L3 传输 | 现有 Client、endpoint、Fabric、`/cli` | 承载 3 种同步帧和现有动作 RPC |
| L4 消费者 | 页面、CLI、团队脚本、其他机器 | 选择订阅范围（路径、深度、视图窗口），解码数据 |

**内核规则（由合同测试覆盖）：**
1. **单一写者。** 每个节点只有拥有方能写，而且只能在事实提交或观察到变化之后写。
2. **hash 确定。** hash 由节点数据和子节点 hash 决定。相同内容得到相同的值，daemon 重启后不变。
3. **先订阅后比较。** 推送在一条有序连接上按顺序到达。断线重连后，必须重新比较所有已订阅的入口，因此丢失的通知一定会被发现。
4. **推送不排队，只做比较。** 拥有方只把变化记为"脏路径"。连接可写时，对脏路径中落在订阅范围内的节点做比较：当前 hash 与已告知的不同才发送。所以连续多次变化只发最后一次，变化后又改回原值则不发，慢消费者也不会积压无界队列。
5. **未知不等于空。** 拥有方离线、读取范围出错或容量超限时，节点标为 `unknown` 并附原因。客户端保留上次内容，不当作删除。
6. **有界。** 每次响应和推送都有字节数和节点数上限（256 KiB、512 个节点），超出部分由拥有方在后续帧中继续发送，直到 `done`。
7. **动作语义。** 回复区分 `committed`、`rejected`、`unknown`。"设为某值"类操作可以安全重试；非幂等操作沿用现有的 `messageId`、`creationId`、`actionId`；结果为 `unknown` 时不自动换 id 重发。

**"已同步"的判定标准：** 本次连接中，订阅入口的 hash 与拥有方最近一次告知的值一致，并且订阅范围内没有尚未发完的节点（已收到 `done`）。同步过程中允许短暂地新旧混合，但不会被标为"已核对"。

### 4.1 daemon 内存层

**现状：同一份会话目录在内存里有多份。**
- `PageCatalog.files` 为每条会话常驻一份完整的 `Arc<SessionMeta>`，另有 `order` 和 `by_id` 两个索引（`store.rs` 第 975–1018 行）。
- `CatalogProjection.rows` 又为每条会话存一份 etag 行，外加 dirty 和 removed 集合。
- 每个打开的会话还有 `Live`，含 `meta`、`items`、每轮一条的 `rounds`、`blob_hints`（`manager.rs` 第 152–174 行）。
- 翻页时 `metadata_window` 会逐条克隆 `SessionMeta`（`store.rs` 第 1686–1696 行）。

按 v4 原文再加一张存数据的节点表，就会变成第三份副本。

**原则：数据只在 L1 存一份，L2 只记 hash。**

| 内容 | 存放位置 | 估算（12,000 条会话，20 个打开的会话） |
| --- | --- | --- |
| 会话摘要投影、摘要 hash、排序索引 | L1 会话读模型（由 `PageCatalog` 改造），整份 `SessionMeta` 不再常驻，详情按需从 L0 读 | 摘要约 600 B × 12,000 ≈ 7 MB；索引约 0.6 MB |
| 路径 → `(hash, 子节点 hash)` | L2 hash 表 | 约 120 B × 12,500 ≈ 1.5 MB |
| 打开会话的 `state`、时间线尾部 | `Live`（保留，作为该会话的读模型） | 与现状相同 |
| 已封存的时间线分段 hash | 按需计算，LRU 缓存 | 有上限 |
| 文件、Git、日志、预览节点 | 只在有订阅时维护，最后一个订阅者离开就丢弃，下次 `check` 时重算 | 受订阅范围约束 |
| 每个连接的已告知 hash 表 | L2 | 每项约 60 B，上限 20,000 项 ≈ 1.2 MB/连接 |

**规则：**
- **常驻**的只有目录类（会话、工作区、Agent、设置、进程），因为活动提示和通知离不开它们。其余按订阅维护。
- **hash 在写入时计算**：摘要投影更新时顺便算 hash，发送时不再序列化。启动时对 12,000 条摘要算 hash，要按 `WorkBudget` 分片让出；没算完时视图标为 `unknown(warming)`。
- **读取不克隆**：读模型对外给 `Arc` 引用；同一节点被多个读者同时请求时只构建一次。
- **总预算**：L1 与 L2 合计设一个 daemon 级上限（初值 64 MiB，S2 实测后定）。超出时先淘汰按订阅维护的节点，常驻目录不淘汰；仍然超出时拒绝新的订阅范围，返回明确错误。
- **删除**：`CatalogProjection` 的 etag 行和 dirty/removed 集合、`summary_etag`、`catalog_row`，整份 `SessionMeta` 的常驻缓存。

## 5. 协议：3 种同步帧

### 5.1 帧格式

```json
{"type":"sync.check","payload":{"watch":true,
  "scope":[{"view":"sessions.recent","ws":"w_1","limit":100},{"path":"session/s_1","depth":2},{"view":"sessions.active"}],
  "known":{"sessions.recent?ws=w_1&limit=100":"9f…","session/s_9/summary":"c2…","session/s_1/state":"5a…"}}}
```

```json
{"type":"sync.nodes","nodes":[
  {"path":"sessions.recent?ws=w_1&limit=100","hash":"a1…","data":[["s_9",1762571000000],["s_3",1762570400000]]},
  {"path":"session/s_9/summary","hash":"d4…","data":{"title":"…"}}],
 "removed":[],"unknown":[],"done":true}
```

```json
{"type":"sync.append","path":"session/s_1/timeline","seq":8813,"data":"…"}
```

- **`scope`** 说明需要哪些节点：
  - `path` 加 `depth` 表示实体及其下几层。
  - `view` 表示一个视图窗口。视图里列出的实体摘要也自动纳入范围，所以列表和它显示的摘要一次就能拿齐。
  - 用户滚动或展开时，再发一个只包含新增范围的 `check`；撤销订阅时带 `unwatch`。
  - 不带 `watch` 的 `check` 就是一次普通查询，CLI 的列表和筛选都走这条路。
- **`known`** 是客户端在这个范围内已有节点的 `{路径或视图身份: hash}`。
- **`sync.nodes`** 既是回复，也是推送。它只包含变化了的节点；在 `known` 里却没有出现在回复中的节点，就是没变。删除的节点列在 `removed` 中。

### 5.2 断线恢复：通常一次往返

拥有方拿到 `scope` 和 `known` 后，在自己的 hash 表上一次完成全部比较：
- 子树的 hash 与 `known` 一致，就整棵跳过。
- 不一致时继续往下，一直比到实体节点。

最后只返回变化了的节点，不需要客户端一层一层地下钻请求。

- **冷启动**时 `known` 为空，一次返回范围内的全部节点，在预算内分帧发送。
- **`known` 的大小**只与订阅范围有关，与历史总量无关。例如订阅 3 个项目各一个 100 条的视图、加上活动集合，大约 330 项，约 20 KB。旧 `catalog.sync` 要上传最多 12,000 项全部缓存。
- **范围较大时**（比如文件树展开很多层），客户端可以只发容器节点的 hash（只适用于 key 稳定的实体容器）。拥有方对变化的容器直接附上它的实体节点，多传一些冗余数据，但换来请求更小，请求次数仍然是一次。

### 5.3 推送复用比较机制

拥有方为每个连接维护一张**已告知 hash 表**，记录这个连接订阅范围内已经发给它（或它在 `known` 中声明过）的节点 hash。

- **初始化**：`check` 完成后，表中就是客户端当前持有的内容。
- **推送**：节点变化时只把它标为"脏"。连接可写时，对脏节点运行与 `check` 相同的比较函数，有差异才发，并更新这张表。
- **效果**：
  - 合并和去重是自动的。
  - 多个重叠的订阅共享同一张表。
  - 慢消费者只会积累脏路径，路径数受订阅范围约束，不会无限增长，也就不需要 `reset`。
  - 断线后这张表直接丢弃，重连时由 `check` 重建。
- **内存**：每个连接的表限制在 20,000 项以内，超出时要求客户端缩小订阅范围，返回明确错误，不静默丢弃。

**其他规则：**
- **`sync.append`** 只用于流的活动尾部，到达即发，保持现有时序和背压；断线后从 `tailSeq` 续接，超出尾部窗口时按分段节点补齐。
- **动作**仍然是现有各族的 typed RPC。回复中附带受影响的节点，并同步更新已告知 hash 表，所以随后的推送不会把同一份内容再发一次。
- **授权**：已认证的完整连接可以读该 OS 用户名下的全部节点；只读展示分享只能读分享范围内的路径。

### 5.4 核心协议全景

重构后，daemon 对外只有四类协议和两份共享合同。

| 协议 | 内容 | 现状 → 重构后 |
| --- | --- | --- |
| **连接与控制** | `hello`、认证、能力协商、配对、Hub 票据、`connection`、`caller` | 保留；`hello` 增加 `sync.v1` 能力位 |
| **同步（含查询）** | `sync.check`、`sync.nodes`、`sync.append`；视图窗口承担列表、分页、筛选和搜索 | 新增。替代 11 种推送帧中的 9 种（`Catalog`、`Event`、`PtyOutput`、`PtyClosed`、`UpdateDownloadChanged`、`AgentsChanged`、`AgentRequestOpened`、`AgentRequestClosed`、`BackgroundProcesses`）和 `Desync`，以及 33 个只读请求（`SessionList/Page/Get/Inspect/Narrative/Rounds/Context`、`RoundTrunk*`、`Blob*Get`、`WorkspaceList`、`AgentList`、`ProcessList`、`FileTree`、`DirectoryList`、`GitStatus/Diff`、`LogTail`、`SettingsGet`、`DeviceList` 等，统计自 `packages/proto/src/rpc.rs`） |
| **动作** | 现有 typed 命令（约 90 个） | 保留变体；回复统一为 `{outcome: committed\|rejected\|unknown, nodes?, error?}`，非幂等操作带 `messageId`/`creationId`/`actionId` |
| **实时媒体与输入** | RTC、语音、`shell` 标准输入、PTY 输入、远程桌面 | 不变 |

**两份共享合同**（不是帧，但 Rust 和 TS 必须逐字节一致，最先冻结）：
- **路径与编码合同**：
  - 实体路径语法：段由 `[A-Za-z0-9_.-]` 组成，文件路径段做百分号编码。
  - 视图身份：视图名加按键排序的查询参数。
  - 规范编码：键排序的 JSON，不含浮点数，不含多余空白。
  - `hash = SHA-256(编码)` 截取前 128 位。
  - 附一组共享测试向量（JSON fixture），Rust 和 TS 必须算出相同的结果。
- **预算与错误合同**：单帧 256 KiB 和 512 个节点；视图 `limit` 最大 1,000；`unknown` 原因枚举为 `offline`、`scope`、`budget`、`warming`、`error`；订阅范围超限的错误码。

推送帧从 11 种减为 3 种：`sync.nodes`、`sync.append`、`Notice`。协议类型继续由 ts-rs 从 Rust 生成到 `packages/proto/bindings/index.ts`，前端不手写类型。

### 5.5 协议流转与三层一致性

**三层要一致的是"对象语义"，不是存储表示。** 数据源（L0）、daemon 内存（L1 和 L2）、应用端，三层看到的是同一个对象：身份相同，含义相同，核对状态明确。但 L0 的表示可以不同。例如 `meta.json` 一个文件里同时存放标题、草稿、权限和执行围栏，而摘要节点只是其中一部分的投影。

| 层 | 对象的表示 | 身份 | 谁保证一致 |
| --- | --- | --- | --- |
| L0 数据源 | 存储格式：`meta.json`、`chat.jsonl`、registry、文件系统；C 类运行观察没有 L0 | 会话 id、工作区 id、文件路径 | 现有原子写入 |
| L1 内存读模型 | 节点的规范数据：L0 事实（加上 C 类观察）的投影 | 实体路径或视图身份 | 发布者：投影是确定的纯函数 |
| L2 同步内核 | 只存 `路径 → hash` 和已告知 hash 表 | 同上 | 内核：hash 只在这里算 |
| 应用端 | 与 L1 逐字节相同的数据和 hash，外加核对状态 | 同上 | TS 内核：原样保存，不再自行派生 |

**四条一致性合同，以及它们在协议中的体现：**

| 合同 | 内容 | 协议与规则中的体现 |
| --- | --- | --- |
| C1 身份一致 | 同一对象在三层用同一个 id 和路径；关联只写 id | 路径与编码合同；关联字段只写 ID（3.3） |
| C2 投影确定，先落盘再发布 | L1 节点只由 L0 事实和带 epoch 的运行观察决定，没有隐藏状态，所以重启后相同的 L0 得到相同的 hash。写入顺序固定为：L0 原子提交，更新 L1，标脏。L1 不得先于 L0 改变，否则崩溃后客户端会看到从未持久化的状态 | 内核规则 1（单一写者）和 2（hash 确定）；发布者合同的 `publish` 时机 |
| C3 传输逐字节 | 应用端保存的就是 L1 的规范编码和 hash，可以校验 `H(data) == hash`；应用端不再自己拼装摘要，现在 `MachineSummaryDirectory` 和 `store.ts` 各自派生目录的做法删除 | `sync.nodes` 携带规范数据和 hash；共享测试向量 |
| C4 状态显式 | 应用端每个节点处于"已核对""上次状态""未知（原因）"之一。视图是查询结果，不是事实：不在窗口里不等于被删除，只有 `removed` 才表示删除 | `unknown`、`removed`、`done` 字段；内核规则 5（未知不等于空） |

C2 中"先落盘再发布"和 C3 中"应用端不自行派生"，在之前的版本里没有写明，这次补上。

**流转时序：**

```text
读取 / 打开页面
  应用端：先显示本地节点（上次状态）
  → sync.check(scope, known)            一次往返
  → L2：按 hash 比较，跳过一致的部分
  → L1：read(path) 只取变化的节点
  → sync.nodes → 应用端原样写入 IndexedDB → 标为已核对

用户动作（例如改名）
  应用端 → session.rename{actionId}
  → L1 命令 → L0 save_meta 原子提交 → L1 更新摘要投影和 hash → L2 标脏
  → 回复 {committed, nodes}，同时更新该连接的已告知 hash 表
  → 其他连接：可写时用同一个比较函数推送

运行状态变化（C 类）
  运行时 → L1 更新 state（带 epoch）→ L2 标脏 → 比较式推送

外部改动（B 类）
  watcher 或对账 → L1 重新投影 → L2 标脏 → 比较式推送

daemon 重启
  L1 从 L0 重建 → 相同 L0 得到相同 hash（C2）→ 应用端重连 check，大多是 same
  C 类节点的 epoch 变了 → 重新下发

跨机器
  页面：直接连各台机器，各自核对
  CLI --machine：经本地 daemon 的长链路和远端节点缓存，同样走 check
```

## 6. 发布者合同

```text
publisher session:
  sources:  A meta.json / chat.jsonl / rounds / blobs；C 运行状态与内存权限；B 协调投影
  nodes:    session/<id>/summary | state | timeline(流)          实体
  views:    sessions.recent | archived | active                   按 updatedAt 排序，参数 ws/labels/source/after/limit
  links:    workspaceId、agentId、lineage(machineId + sessionId)
  depends:  meta.title|labels|archived|updatedAt → summary；updatedAt|archived → 视图顺序
            运行状态 → summary + sessions.active
            协调投影 → summary + state
            inbox/待处理权限 → state + summary
  publish:  在 Store::save_meta、append_round、write_trunk、运行状态变化、协调投影变化时
            调用 kernel.set(path, data) / kernel.remove(path)，由内核汇总祖先 hash 并推送
  actions:  现有 session.* 命令；回复附带内核返回的 nodes
```

**内核 API：**

```text
set(path, data) / remove(path)
append(path, seq, data) / seal(path)
check(scope, known, watch) / unwatch(paths)
view(name, order, filter)   # 声明视图：内核按订阅计算窗口和 hash，不存放结果
read(path) -> data     # 由发布者实现：内核发送时按路径向 L1 取数据，自己不存
```

- daemon 端的 hash 表放在内存中，有预算，启动时由发布者从 L0 重建，不落盘；数据只在 L1，见 4.1。
- 客户端的节点表持久化在 IndexedDB 中，以路径为键，值为 `{hash, data, children}`，按"账号范围 + 机器 + 指纹"隔离，总预算 64 MiB。超出时整机淘汰最久未用的；配额失败时退回内存。

**评审发布者的检查清单：**
- 每个数据源都有变化检测方式。
- B 类、C 类节点带观察时间或 epoch。
- 关联字段只写 ID。
- 依赖表覆盖所有派生字段。
- 易变字段不进入 hash。

## 7. 全部信息族的映射

27 个方法族逐一归入下表。各族的数量与所有者见 [v1 接口审查](layered-sync-interface-audit-20261108.md) 第 11–41 行。

| 信息族（v1 族名） | 节点路径 | 变化来源 | 被替换的旧路径 |
| --- | --- | --- | --- |
| 会话目录（`catalog`、`session.list/page`） | 视图 `sessions.recent`、`sessions.archived`、`sessions.active`，外加实体 `sessions/errors` | `save_meta`、运行状态、协调投影、registry | `catalog.sync` 与 `Catalog` 帧、已知清单、浏览器目录缓存、前端第二份目录、翻页循环 |
| 会话（`session`、`round`、`blob`、`subscribe`、`unsubscribe`） | `session/<id>/summary\|state\|timeline` | `save_meta`、`append_round`、`write_trunk`、`Live::publish` | `subscribe` 重放与快照、`read_view` 全量构造、`Event` 帧、`inspect/narrative/rounds/context` 的读取实现 |
| 工作区与 Space（`workspace`、`agentSpace`、`fileAccess`） | 视图 `workspaces`；实体 `workspace/<id>/head\|status` | registry、Space 发现、文件夹存在性观察 | `workspace.list` 重读 |
| Agent 与 Provider（`agent`、`provider`） | `agents/<id>`（凭证不进入节点） | registry、配置保存、provider 操作 | `AgentsChanged`、`agent.list` |
| 设置与语音配置（`settings`、`speech`） | `settings/<section>` | 配置保存 | `settings.get` 重读 |
| 进程、PTY、Shell（`process`、`pty`） | `processes/<id>`；`pty/<id>/state\|output(流)` | 进程注册表、PTY 回调 | `BackgroundProcesses`、`PtyOutput` |
| 文件与目录（`file`、`directory`） | `files/<ws>/<path>`，存目录清单，截断时标 `complete:false` | 有订阅时的 watcher 加对账；文件写入动作 | 手动刷新、静默截断 |
| Git（`git`） | `git/<ws>/status`，`git/<ws>/diff/<path>` | watcher 监听 `.git/HEAD`、`.git/index` 和工作树，去抖 | 手动刷新 |
| 日志与诊断（`log`、`diagnostics`） | `logs/<name>`（流）、`diagnostics` | 追加写入、诊断环 | 尾部轮询 |
| 预览与制品（`preview`） | `preview/<id>`，bundle 清单 | 制品完成、批注保存 | 重复读取 |
| 更新与设备（`update`、`device`） | `updates`、`devices/<id>` | 更新器回调、设备存储 | 重读 |
| Hub（`hub` 与 Cloud HTTP） | 由 Hub 拥有的 `hub/machines`、`hub/placements` | Hub 事务提交 | Console 各页面各自请求 |

**不纳入本模型的部分：**
- `connection`、`caller`、`client.debug`：属于控制面。
- RTC、语音音频、`service.preview`、远程桌面输入：属于实时媒体，有严格的时序语义。
- 更新包签名：保证的是另一种安全性。

这些部分可以把状态摘要发布为节点，但数据通道保持不变。

## 8. 消费者

- **页面**
  - 只订阅当前视图需要的路径和深度。
  - 启动时先显示本地节点（上次状态），再比较 hash。
  - 每台机器独立核对。
  - `store.ts` 和 `MachineSummaryDirectory` 只读同步内核，不再保留自己的目录副本。
- **CLI**
  - 命令面不变，内部改为直接读本地 daemon 的内存读模型，输出增加 `hash`、`complete`、`unknown` 三个字段。
  - 新增 `--watch`：先输出一次当前值，之后以 JSONL 逐行输出变化。
  - `--machine X` 由本地 daemon 中 X 的副本提供，第二次读取只需一次 hash 比较。
- **团队脚本**：`board.py`、`team.py` 改用 `--watch`。已经部署到用户机器上的旧副本，因为命令面没变，仍然可以运行。
- **其他机器与未来的 worker**：使用同一协议。这里只说明边界已经留出，不承诺实现。

### 8.1 CLI：风险与解决方案

CLI 是薄转发器：每次调用启动一个进程，经回环 `POST /cli` 交给 daemon，由 daemon 在进程内执行（`apps/cli/src/invoke.rs`、`cli_front/rpc.rs`）。本地这一跳很便宜，风险主要在下面几处。

| 风险 | 现状证据 | 对策 |
| --- | --- | --- |
| 列全部会话随总量线性增长，结果还可能不一致 | `session list` 不带 `--limit` 时，以每页 100 条循环 `SessionPage` 直到翻完（12,000 条约 120 次），再在 CLI 一侧按标签和来源过滤（`cli_front/query.rs` 第 798–866 行），另多一次 `WorkspaceList` 校验 | 在读模型上一次取出 id 快照，筛选在 daemon 内完成，流式输出 JSONL；处理量与结果大小成正比 |
| 脚本轮询时进程启动开销成倍放大 | 团队脚本每轮为每个 Agent 调用一次 CLI，每次都要启动进程、认证、发请求 | `--watch` 长连接；支持一次查多个 id（`session get a b c`）；团队模板改用 `--watch` |
| `--machine X` 每次调用都新建远程链路 | `connect_selected` 每次调用都 `connect_remote`，或先向本地 daemon 要 Hub 票据再连接（`cli_front/query.rs` 第 1161–1201 行），而且每次读取都要走网络 | 本地 daemon 与 X 保持一条长链路，并维护 X 的已订阅节点副本；CLI 读副本，副本用 `known` 一次往返核对 |
| 大结果阻塞单线程 Host | WASM Host 是 current_thread；一次序列化 12,000 条摘要约 7 MB JSON，会卡住页面事件循环 | 按 256 KiB 分块流式输出，块与块之间让出；单次请求设字节上限，超出时标 `complete: false` |
| 大量 `--watch` 占内存 | 每个连接一张已告知 hash 表 | 每表上限 20,000 项；daemon 级总预算（4.1）；超限时拒绝新订阅，返回明确错误 |
| 同一时刻多个 CLI 读同一节点 | 现状各自构建 | 同一节点只构建一次，由读模型的 `Arc` 共享 |

**解决原则：**
- **CLI 不建自己的缓存。** 进程很短命，自建缓存只会带来过期和不一致。daemon 就是缓存。
- **CLI 与页面走同一个机制。** 读取都是 `check`；列表和筛选都是视图；`--watch` 就是带 `watch` 的 `check`。
- **代价与结果大小成正比。** 与会话总量、调用次数无关。

**具体改法（命令面不变，只增不改）：**

| 命令或场景 | 改法 | 代码位置 |
| --- | --- | --- |
| `session list`（不带 `--limit`） | daemon 内一次视图查询：在读模型有序索引上取 id 快照，在 daemon 内按工作区、标签、来源过滤，按 256 KiB 分块经现有 `/cli` 记录流输出。去掉 `SessionPage` 循环和多余的 `WorkspaceList` 校验 | `cli_front/query.rs` 的 `Query::SessionList`；会话读模型新增 `view()` |
| `session list --limit N --cursor C` | 就是 `limit/after` 的视图窗口；输出 `nextCursor`、视图 hash，两次调用之间视图变了就输出 `changed: true` | 同上 |
| `session get a b c` | 新增多 id 形式，一次取多个实体；单 id 形式不变 | `cli_front/query.rs` |
| `--watch`（`session list/get`、`agent list`、`process list` 等） | `/cli` 记录流保持打开：先输出一次当前值，之后每次推送输出一行 JSONL；空闲时没有流量 | `cli_front` 加 L2 订阅；`apps/cli/src/invoke.rs` 已经按行读取记录流，基本不用改 |
| `--machine X` | 本地 daemon 维护到各远端机器的链路池（空闲 5 分钟关闭）和远端节点缓存（LRU，上限 16 MiB）。CLI 请求经本地 daemon 发出 `check(scope, known)`，内容没变时远端只回 `same` | `cli_front/query.rs` 的 `connect_selected` 改为从链路池取连接；新增远端节点缓存 |
| 所有读命令的输出 | 增加 `hash`、`complete`、`unknown` 字段；已有字段不变 | `cli_front/output.rs` |
| 团队脚本 | `board.py`、`team.py` 改用 `--watch` 或多 id 形式；已部署的旧副本因为命令面不变，仍然可以运行 | 团队模板 |

**落地顺序：**
- 列表单次查询、多 id `get` 和输出字段只依赖会话读模型，随 S2 一起交付。
- `--watch` 依赖 L2 订阅，在 S2 末尾交付。
- `--machine` 的链路池和远端缓存随 S5 交付。
- 团队模板随 S6 迁移。

## 9. 验收（均未执行）

| 场景 | 通过条件 |
| --- | --- |
| hash 确定性 | 相同输入得到相同 hash；daemon 重启后不变 |
| 内容不变时重连，订阅 10 个入口 | 1 个请求，回复小于 1 KB；拥有方读取 0 个 L0 文件 |
| 单次改名，同一工作区有 10,000 条会话 | 看着该列表的连接收到 1 条推送：1 条摘要加 1 个视图的 id 列表，总量小于 8 KB；只打开详情的连接只收到摘要 |
| 关闭期间改名 1 条、删除 1 条，并重启 daemon | 1 次 `check` 往返就得到正确结果，`known` 小于 64 KB；删除项不会复活 |
| 分页 | 页面滚动加载只按段取，不使用游标；CLI 用键集游标翻完 10,000 条，不重不漏（期间无修改时）；有修改时输出 `changed: true` |
| 推送合并与慢消费者 | 同一节点 1 秒内变化 10 次，暂停读取的连接恢复后只收到 1 次；变化后又改回原值，收到 0 次；拥有方内存不随暂停时长增长 |
| 推送丢失、断线 | 重连后重新 `check` 并收敛；同步期间不会标为"已核对" |
| 某工作区 scope 出错、拥有方离线 | 标为未知，保留上次内容；其他工作区正常 |
| 项目文件夹改名、移走或卷离线 | 对账后项目显示"根路径不可用"，会话显示未知而非删除；重新定位后恢复 |
| 关联与派生 | 改 Agent 名时，会话节点变化数为 0；运行状态跳变一次，恰好更新摘要、活动集合及其祖先 |
| 会话正文 | 读取 10,000 轮会话的最后一页，处理量与该页大小成正比；1,000 个 token 不触发任何目录节点变化 |
| 文件与 Git | 外部改动 2 秒内反映到面板；超过上限时显示"未完整" |
| PTY | 重连后不丢、不重复；输入回显延迟的 p95 不比现状差 |
| CLI 与团队 | 100 个并发读者时，同一节点只构建一次；`--watch` 空闲时 daemon CPU 接近 0 |
| 多机 | A 正常、B 慢、C 离线时，A 正常显示，C 标为未知 |
| 防回流 | 测试断言消费者代码中没有已迁移族的旧读 RPC 和旧推送帧 |
| 易变列表的缓存收益 | 5 个 Agent 工作期间断线 10 分钟后重连，传输量不超过不用缓存时的 30%；列表静止时回复小于 1 KB；运行状态变化不改变视图 hash |
| 三层一致性 | 应用端对每个收到的节点校验 `H(data) == hash`，全部通过；在 L0 提交前注入崩溃，重启后客户端没有看到未提交的状态；内容不变时重启 daemon，所有实体和视图的 hash 不变 |
| daemon 内存 | 12,000 条会话、20 个打开会话、10 个连接时，L1 加 L2 不超过预算；内存中只有一份摘要数据（不再常驻整份 `SessionMeta` 和 etag 行） |
| CLI 列表 | 列出 12,000 条会话只走一次读模型扫描，耗时与输出大小成正比；列表期间有会话更新时，结果不漏不重 |
| CLI 远端 | 同一台远端机器连续执行 10 次读命令，只建立 1 条链路；内容不变时，第 2 到第 10 次各只需一次往返 |
| 单线程 Host | CLI 输出 7 MB 结果期间，页面交互的 p95 延迟不超过 100 ms |

所有数字都是设计目标，需要在实施时用真实的 daemon、浏览器和 WASM Host 测量确认。

## 10. 重构步骤与删除

**兼容策略（已简化）：**
- 新客户端只支持 `sync.v1`，遇到旧 daemon 时提示更新。
- 某一族迁移完成后，立即删除它的旧推送帧和旧读接口。
- CLI 与 daemon 同一个二进制发布，命令面不变。
- 跨机器时两端都需要升级。
- 浏览器旧缓存直接删除。

**代码落点：**

| 位置 | 新增或改造 |
| --- | --- |
| `packages/proto/src/` | 新增 `sync.rs`：三种同步帧、视图参数、统一动作回执、路径与规范编码、hash 函数；新增共享测试向量 fixture；ts-rs 生成到 `bindings/index.ts` |
| `apps/daemon/src/sync/` | 新增内核：`table.rs`（路径 → hash，汇总祖先）、`view.rs`（在读模型有序索引上计算视图窗口）、`scope.rs`（订阅范围与已告知 hash 表）、`flush.rs`（脏集合与按比较推送）、`budget.rs` |
| `apps/daemon/src/session/` | `PageCatalog` 改造为会话读模型（摘要投影、hash、排序索引）；新增 `publish.rs` 声明节点、依赖和 `read(path)`；删除 `catalog.rs` |
| `apps/daemon/src/router.rs`、`transport/` | 路由同步帧；写端在可写时调用 `flush` |
| `apps/daemon/src/cli_front/query.rs` | 见 8.1：列表单次视图查询、多 id `get`、`--watch`、链路池 |
| `packages/workbench/src/protocol/sync/` | 新增 TS 内核：IndexedDB 节点库、`known` 构造、应用 `sync.nodes`、订阅范围管理 |
| `packages/workbench/src/session/store.ts`、`protocol/client.ts` | 只从 TS 内核选取数据；删除 `protocol/summary-directory.ts`、`summary-directory-cache.ts`、`session-pages.ts` 及 `catalog.sync.v1` 分支 |

**步骤（每步都有通过门槛，前一步不过不进入下一步）：**

| 步骤 | 交付 | 通过门槛 | 同时删除 |
| --- | --- | --- | --- |
| S0 合同冻结 | 路径语法、规范编码、hash、帧结构、预算与错误码、共享测试向量 | Rust 和 TS 对全部测试向量算出相同的 hash | 无 |
| S1 内核 | Rust 和 TS 两版内核，用模拟发布者驱动 | 合同测试：确定性、一次往返恢复、推送合并、脏集合背压、未知语义、帧上限、视图窗口推送、三层一致性 | 无 |
| S2 会话族 | 会话读模型与发布者、时间线流、页面会话列表与详情、CLI 会话命令 | 第 9 节会话相关验收，加真实浏览器和 testctl 专项 | `catalog.sync` 与 `Catalog` 帧、`CatalogProjection`、`SessionList/Page/Get/Inspect/Narrative/Rounds/Context`、`RoundTrunk*`、`Blob*Get`、`subscribe` 重放与快照、`Event` 与 `Desync` 帧、`read_view` 全量读路径、前端三个目录文件、CLI 翻页循环 |
| S3 运行态 | 工作区、Agent、设置、进程、PTY、日志 | 对应验收；PTY 回显延迟不劣化 | `AgentsChanged`、`AgentRequestOpened/Closed`、`BackgroundProcesses`、`PtyOutput/Closed`、`UpdateDownloadChanged` 及对应读请求 |
| S4 文件 | 文件、Git、预览，以及 watcher 与对账 | 外部改动 2 秒内可见；超限显示"未完整" | `FileTree`、`DirectoryList`、`GitStatus/Diff` 的读取实现与手动刷新 |
| S5 多机与 Hub | daemon 维护远端长链路和副本；Hub 发布者；Console 接入 | 多机验收；`--machine` 第二次读取只需一次往返 | Console 各页面的自有请求与轮询；CLI 每次新建的远程链路 |
| S6 收尾 | CLI `--watch` 全覆盖，迁移团队模板 | 防回流测试通过 | `board.py`/`team.py` 的轮询；v1 原型目录 |

S0 到 S2 作为第一个候选，在 dev-3 实现，用现有 testctl 专项和真实浏览器验收后，交给 release-beta 发布。之后每一步可以独立发布。完成后，推送帧从 11 种减为 3 种，33 个只读请求由同步帧（含视图）取代。

**回滚：** L0 格式不变，读模型和 hash 表都可以重建，回退二进制即可，不涉及用户数据迁移。

## 11. 取舍

| 方案 | 结论 |
| --- | --- |
| 各族继续各自优化 | 每族都要重新发明缓存、恢复和推送，这正是现状的根因 |
| 修订号 | 重启或跨进程后无法比较，仍然需要整份修复 |
| v3（Git 式不可变版本） | 能做到一次往返取得差异，也能提供一致快照，但要付出对象库、保留根、回收和版本链的代价，超出了"判断是否需要更新"的需要 |
| 按 id 的 hash 分桶做列表 | 分区稳定，但与浏览顺序无关，看第一页要先拿全部成员（v4 初稿） |
| 按 `updatedAt` 分段、由内容决定切点（第二次修订） | 能做到重启不变，但只为一种列表引入一套切分算法，属于过度设计；改为视图窗口 |
| 视图内增量操作（JMAP `queryChanges`、Discord 式插入删除） | 能省带宽，但要多一套操作类型；按现有变化频率，整窗替换（100 条约 3 KB）就够了，等测量证明需要时再加 |
| 本方案（分层节点 + 校验 hash + 比较式推送） | 概念最少；恢复通常一次往返，推送不排队。代价是拥有方要为每个连接维护已告知 hash 表，同步过程中可能短暂新旧混合 |

## 12. 实施前必须测清楚的问题

1. **WASM Host 单线程下汇总 hash 的开销。** 计算需要按 `WorkBudget` 分片让出；S1 测量前台 p95。
2. **变化频率。** 运行状态、协调投影、Git 在高负载下的变化频率是多少？比较式推送已经能自动合并，还要测出是否需要额外的最小发送间隔，比如 100 ms。
3. **内存。** daemon 的读模型加 hash 表，在 12,000 条会话、20 个打开会话时的 RSS 是多少？据此设定 4.1 的预算。
4. **watcher 的三平台差异。** Linux inotify 有数量上限，macOS 用 FSEvents，Windows 用 ReadDirectoryChangesW；只监听有订阅的目录，再用对账兜底。
5. **PTY 流延迟。** 改走 `sync.append` 后，输入回显延迟不能增加。
6. **发布窗口。** 设备 daemon 版本混杂期间，"需要更新"的提示必须可以直接操作，需与 release-beta 确认。
7. **已告知 hash 表的内存。** 测量 100 个连接（浏览器加 `--watch`）时的表总量，确认 20,000 项的上限是否合适。
8. **草稿保存刷新排序。** `replace_drafts` 刷新 `updatedAt`，打字时会话会被顶到列表最前，也会触发移段。需要产品确认草稿是否应该影响"最近活动"排序。
9. **读模型启动预热。** 12,000 条摘要的投影和 hash 在 WASM Host 上要多久？预热期间视图标为 `unknown(warming)`，页面先显示缓存，这个过渡是否可以接受？
