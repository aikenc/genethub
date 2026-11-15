# GeneHub 机器目录分层 hash 同步提案 v2

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

> 已被 [v4 统一信息同步架构](unified-state-sync-architecture-v4-20261108.md) 取代：本文只覆盖目录，v4 把全部信息族纳入同一套分层节点与校验 hash；本文目录树设计对应 v4 的 `dir` 节点。

- 状态：待评审。仅为提案，未实现、未部署。
- 日期：2026-11-08
- 取代：[v1 综合提案](layered-file-hash-sync-proposal-20261108.md)。v1 的接口审查与实验记录继续作为历史证据。
- 源码基线：Open `origin/main` `193aa152`（dev-3 槽位 `432e507f`，落后主干 9 个提交，改动文件不重叠）；Cloud `e7dd53e`。
- 适用范围：机器目录，即工作区列表、会话摘要和当前活动集合，以及它在 daemon、协议、浏览器缓存、页面与 CLI 之间的读取链路。会话正文、文件树、Agent 配置等其他数据族不在本版范围内。

## 摘要

**体验影响。** 一台机器的历史越多，浏览器重开或重连就越慢。浏览器必须把最多 12,000 条已知会话的 etag 上传给 daemon，daemon 再逐条重新投影比对。daemon 重启后，增量修订号失效，只能整份修复。页面里有两套会话目录、三种目录 RPC 和至少五段手写翻页循环，行为容易不一致。

**怎么解决（待实施）。** 把目录做成 daemon 内存中的一棵内容寻址树，每个节点以 hash 标识。客户端只需提交自己手里的根 hash：一致就结束，不一致就只取变化的分支。在线推送的事件携带"从哪个根变到哪个根"，用根 hash 本身判断有没有漏事件，不再依赖进程内的修订号。新客户端只走这一条路径，旧目录协议、缓存和降级分支随之删除。

**如何避免复发。** 每层只有一个所有者，并用测试禁止前端再调用旧目录 RPC。验收覆盖以下场景：不变重连只发一个请求、单次改名只更新受影响节点、daemon 重启后内容未变时不重传、事件丢失后能收敛、离线时先显示上次状态、坏数据标为未知而不是删除。全部条件见第 8 节。

## 1. 用户场景

一台机器上有 10,000 条会话。用户关掉浏览器期间，另一台设备改了其中 1 个标题、删除了 1 个会话，daemon 也重启过一次。

| 环节 | 现在 | v2 之后 |
| --- | --- | --- |
| 重开页面，网络尚未就绪 | `refresh()` 先等在线机器列表，之后才读缓存 | 先从 IndexedDB 读出该机器上次的根，立即显示"上次状态" |
| 建连后核对 | 上传已知会话清单（最多 12,000 项 etag），daemon 逐条投影比较 | 只上传一个根 hash；daemon 返回新根和变化的对象 |
| daemon 重启过 | 内存修订号归零，必须按已知清单整份修复 | 内容未变时根 hash 相同，直接判定一致；内容变了就沿树逐层只取变化分支 |
| 本地写缓存 | 每次变化都把整个来源序列化，重算 checksum 后整份写入，最多保留 500 条历史 | 只写入新对象，再切换根引用 |
| 页面数据 | `store.ts` 和 `MachineSummaryDirectory` 各持一份目录，靠 `acceptSessionSummary` 互相同步 | 只有一个目录所有者，页面只读它 |

## 2. 相对 v1 的收窄

| v1 | v2 决定 | 理由 |
| --- | --- | --- |
| 覆盖 127 个 RPC、27 个方法族的统一平台 | 只做机器目录 | 用户报告的慢恢复和列表放大都在这条链路上。其他族以后复用同样的分层，本版不承诺 |
| Rust 与 TS 共用规范 JSON（JCS），需要跨语言字节向量 | 只有 daemon 计算 hash，计算对象是它实际发出的字节。客户端原样保存这些字节，用 WebCrypto 对字节做 SHA-256 校验，从不重新编码 | 彻底消除 f64、u64、键排序在两种语言间不一致的风险 |
| 通用对象缓存内核、有界 pack、worker 进程、源格式整代提交、Hub SQLite | 都不做 | 当前问题不需要，留到有测量依据时再立项 |
| 动作 hash 和持久回执表 | 本版的目录修改（改名、标签、归档、删除）都是"设为某值"型操作，天然可以安全重试，不建回执库。发送消息、创建、fork 等非幂等操作继续使用现有的 `messageId`/`creationId` | 少一套持久状态 |
| 事件靠修订号对齐 | 事件 = 基准根 → 新根，事件身份由两个根的 hash 决定 | 进程重启也不会让事件链失效 |
| 保留旧端兼容和降级路径 | 新客户端只支持 `directory.sync.v1`；旧目录协议在客户端和 daemon 两侧都删除 | 用户已同意简化旧项目兼容 |

主干已经合入的能力直接复用，不再重新设计：
- CLI 分页：`session list --limit/--cursor`
- 无历史摘要：`session get --summary`，对应 RPC 参数 `summaryOnly`
- 同查询页读取合并：`page_reads`
- 浏览器先打开已知的缓存会话

## 3. 现状证据（源码阅读，未实测）

| 事实 | 位置 |
| --- | --- |
| `catalog.sync` 上传 `knownSessions`（最多 12,000 项）和 `knownWorkspaces`（最多 4,096 项）；daemon 对已知项和活动项逐条执行 `catalog_row`（即 `project_meta` 加 etag），成本随已知集合线性增长 | [catalog.rs](../../apps/daemon/src/session/catalog.rs) 第 279–387 行 |
| 增量修订号 `CatalogProjection.revision` 只存在于内存；没有观察者时 `dirty/rows` 被直接清空 | 同上第 143–151 行；[store.rs](../../apps/daemon/src/session/store.rs) 第 990–997 行 |
| 现有 etag 已经排除 `lastActivityAtMs` 和 `lineage`，并把预览截断到 200 字；`lastActivityAtMs` 只在打开的会话里通过 live 状态使用 | catalog.rs 第 27–37 行；`Composer.tsx` |
| 摘要不只来自文件，还依赖 Live 的运行状态、协调投影和待处理交互 | [manager.rs](../../apps/daemon/src/session/manager.rs) `project_meta`，第 1872–1898 行 |
| 浏览器缓存按来源整份写入：限 8 MiB、16 个来源、500 条历史；以来源 `activityComplete` 为写入门槛 | [summary-directory-cache.ts](../../packages/workbench/src/protocol/summary-directory-cache.ts) |
| 页面同时有两个目录所有者 | [store.ts](../../packages/workbench/src/session/store.ts)、[summary-directory.ts](../../packages/workbench/src/protocol/summary-directory.ts) |
| 页面同时使用三种目录 RPC：`session.list`（`store.ts:3686`、`AgentDetails.tsx:23`）、`session.page`、`catalog.sync` | 同上；[client.ts](../../packages/workbench/src/protocol/client.ts) 第 874–960 行 |
| 至少五段手写翻页循环，预算各不相同（500、10,000、无上限） | `session-pages.ts`；`store.ts:3302`、`store.ts:3760`；`summary-directory.ts:422`、`summary-directory.ts:499` |
| CLI 只在带标签或来源筛选的完整查询里使用 `session.list` RPC，其余走 `session.page` | 主干的 `cli_front/query.rs` |
| 摘要和工作区类型中的映射都是 `BTreeMap`，按结构体字段顺序序列化，结果是确定的 | `packages/proto/src/domain.rs` |

## 4. 分层与所有者

每层只有一个所有者，只做表中列出的事。上层不得绕过下层直接读写。

| 层 | 唯一所有者 | 负责 | 不负责 |
| --- | --- | --- | --- |
| L0 事实文件 | 现有 Store、workspace registry、coordination 文件、Live 运行状态 | 持久事实和原子写入（不变，仍为 `SESSION_FORMAT=10`） | 不新增文件，不存放 hash 树 |
| L1 目录树 | daemon 的 `PageCatalog` | 由 L0 增量维护的内存 hash 树；保留最近 8 个根以计算差异；进程启动时从现有扫描重建 | 不落盘，不复制正文，不替代写事务 |
| L2 同步协议 | daemon router 与 workbench `Client` | 一个请求 `directory.sync`，一个推送 `directory.changed` | 不理解页面视图，不做分页语义 |
| L3 客户端对象库 | `MachineSummaryDirectory` 加新的 `directory-store.ts` | IndexedDB 中的 `objects`（按 hash 存字节）和 `roots`（每台机器的根）；校验、按需补齐、回收 | 不保存排序、筛选、loading 等派生状态 |
| L4 视图 | React 组件；`store.ts` 只做消费者 | 从 L3 读出成员并在本地排序筛选，只为可见行补取摘要 | 不持有目录副本，不直接调用目录 RPC |

CLI 是 L1 的直接消费者：本地调用经 `/cli` 进入同一 daemon router，`session.page` 由 L1 的排序索引直接提供，不经过 hash 同步，也不使用 L3。

四个核心约束在本版中的落点：
- **数据分层**：L1 的树结构，见第 5 节。
- **结构友好的文件**：L0 保持不变，树可以从文件随时重建。
- **数据 hash**：见第 5 节。
- **事件 hash**：见第 6 节。

## 5. 数据 hash 与树结构（拟议）

**对象与 hash。** 对象是 daemon 用 serde 按固定结构序列化出的 UTF-8 JSON 字节。hash 的计算方式为：

```text
hash = "sha256:" + hex(SHA-256("gh-dir-v1\n" + kind + "\n" + bytes))
```

`kind` 的取值为 `root | workspace | activity | errors | sessions | bucket | summary`。客户端按 hash 原样保存字节，读取时才解析，不重新编码。树中的引用一律是 hash 字符串，结构里不出现循环。

```text
root       {"spaces":[[workspaceId, workspaceHash, sessionsHash, count], ...] 按 id 排序,
            "activity": hash, "errors": hash}
├ workspace   WorkspaceInfo
├ sessions    {"buckets": {"<0..63>": bucketHash}}      稀疏，空桶省略
│  └ bucket   [[sessionId, updatedAtMs, summaryHash], ...] 按 id 排序
│     └ summary   目录摘要（SessionSummary 去掉 lastActivityAtMs、lineage，预览截至 200 字）
├ activity    [[workspaceId, sessionId, summaryHash], ...]  当前活动集合
└ errors      [CatalogScopeError, ...]
```

**结构规则：**
- 树固定为四级，不做自适应分裂。
- 会话按 `SHA-256(sessionId)` 首字节右移 2 位（取值 0–63）分桶。单个工作区有 12,000 条会话时，每桶约 190 项。
- 桶内条目带 `updatedAtMs`，客户端不取摘要也能完整排序，再只为可见行补取摘要。
- 活动集合和工作区内的会话列表引用同一个摘要对象，同一个 hash 只取一次。

**容量上限**沿用现有边界，超出时明确报"目录容量超限"，不静默截断：
- 每台机器最多 12,000 条会话、4,096 个工作区。
- 单个对象不超过 1 MiB。按每个工作区约 180 字节估算，4,096 个工作区的根约 740 KB（估算，待测）。

**维护方式：**
- 现有的 `dirty` 标记、Live 状态变化、协调投影变化、registry 变化和 scope 错误，仍通过现有的 `catalog_wake` 和 discovery 任务触发 `refresh`。
- 一次 refresh 只重算变化的摘要，以及从它们到根这条路径上的节点，工作量约为"变化条数 × 桶大小"。
- 去掉"没有观察者就清空 dirty"的捷径，改为把 dirty 累积到下次 sync 或 refresh 时统一处理。这样 CLI 和页面在任何时刻读到的都是当前树。
- 节点用 `Arc` 共享未变的子树，保留 8 个历史根的额外内存只花在变化过的路径上。
- 正文 token 不进入摘要（现有行为），所以流式输出不会产生目录事件。

## 6. 协议与事件 hash（拟议）

### 6.1 `directory.sync`

```json
{"type":"directory.sync","payload":{"knownRoot":"sha256:…","want":["sha256:…"],"follow":true}}
```

```json
{"type":"directory","data":{"root":"sha256:…","unchanged":false,
  "objects":[{"hash":"sha256:…","kind":"summary","bytes":"{…}"}],
  "missing":[],"more":false}}
```

**请求处理：**
1. 当 `knownRoot` 等于当前根且 `want` 为空时，返回 `unchanged: true`，不附带任何对象。
2. 当 `knownRoot` 在 daemon 保留的 8 个根之内时，daemon 计算新旧两棵树的差异，直接附带"新树里有、旧树里没有"的对象。
3. 其他情况（未知根、daemon 重启后内容已变）只返回根对象，由客户端沿树逐层用 `want` 补齐。
4. `want` 只能取当前根可达的对象。不可达或已过期的 hash 列入 `missing`，客户端随后重新从根开始。hash 本身不授予额外的读取权限，连接认证和授权沿用现有机制。
5. 每次响应不超过 256 KiB 或 512 个对象，单个大对象可以独占一次响应；剩余部分用 `more: true` 表示，由客户端继续请求。
6. `follow: true` 时，沿用现有"先订阅后取快照"的时序登记推送。

**正确性只依赖一件事：客户端检查自己需要的根是否闭合（所需对象都在本地并通过校验）。** 差异预取只是一种优化；预取错了或缺了，客户端照样能用 `want` 补齐。

### 6.2 `directory.changed` 推送与事件 hash

```json
{"type":"directory.changed","base":"sha256:A","root":"sha256:B","event":"sha256:E",
 "objects":[{"hash":"sha256:…","kind":"bucket","bytes":"[…]"}], "more":false}
```

- `event = SHA-256("gh-dir-event-v1\n" + base + "\n" + root)`，用于去重和诊断。
- 客户端只在 `base` 等于自己已核对的根时才应用推送：先写入对象，再切换根。
- `base` 不匹配、`more: true`，或现有广播落后（Lagged）时 daemon 发出的 reset，都由客户端执行一次 `directory.sync`。由于 daemon 保留了最近 8 个根，这次 sync 通常一个请求就能收敛。
- 同一事件 hash 重复到达时直接忽略。
- 推送和请求走同一条有序连接，断线后重连必然先 sync，因此不需要心跳携带根。

### 6.3 目录修改

- `session.rename`、`label`、`archive`、`delete` 以及工作区移除，接口保持不变。
- 回复额外携带受影响的新摘要对象（hash 加字节），调用方可以立即写入 L3，后续推送里的同一对象会按 hash 去重。
- 这些操作是"设为某值"或"删除，已删也算成功"，安全重试不需要回执表。
- 如果以后加入非幂等的目录操作，再按现有 `creationId` 的模式引入动作身份。

## 7. 客户端缓存与视图（L3/L4）

**存储结构：**
- IndexedDB 数据库 `genehub-directory-v2`，含两个 store：
  - `objects`：键为 hash，值为 `{bytes, kind, size, usedAt}`。
  - `roots`：键为"账号范围 + deviceHandle + 指纹"，值为 `{root, savedAt}`。这组键沿用现有隔离规则。
- 首次运行删除旧库 `genehub-directory-v1`，不做迁移。缓存本来就可以从服务端重建。

**启动顺序：**
1. 确认当前本地账号范围后，读取每台机器的根，检查机器视图（根、工作区、活动集合及其摘要、错误）是否闭合。闭合就立即显示，标为"上次状态"。
2. 建连后发送 `directory.sync{knownRoot}`。收到 `unchanged` 后标为"已核对"；否则补齐对象，闭合后切换根。
3. 某台机器离线或失败，不影响其他机器的显示。

**按需补齐：**
- 用户展开某个工作区时，才补齐它的 `sessions` 和桶。
- 可见行的摘要按 50 行一批补取，不为未展开的工作区下载历史。

**写入与切换：**
- 收到的对象先分批写入，中断后已写入的对象仍可复用。
- 根引用只在所需对象闭合后才切换。
- 多个标签页以最后写入者为准，不需要排序。原因是缓存的根只是"上次状态"提示，每次连接都会重新核对；写错的根最多让下次多取几个对象，不会把错误内容当作最新。

**回收与校验：**
- 启动空闲时做标记清扫：从全部机器根出发标记，删除不可达的对象。
- 总预算 64 MiB，超出后先淘汰最久未用机器的根。
- 读到的对象 hash 不符就丢弃并重取，不会留下"已完整"的假标记。
- 配额不足或 IndexedDB 不可用时退回内存缓存，页面照常可用。
- 没有 WebCrypto 的非安全上下文中跳过校验，连接本身仍受认证保护。

**三种显示状态：**

| 状态 | 含义 |
| --- | --- |
| 上次状态 | 本地闭合，本次连接尚未核对 |
| 已核对 | 本地根与 daemon 当前根一致 |
| 未知 | scope 错误、离线或容量超限 |

处于"未知"的工作区保留缓存内容，不当作空，也不当作已删除。

**视图层：**
- `store.ts` 删除自己的 `sessions/activitySessions` 目录副本以及 `refreshSessions`、`readSessionPages`，改为订阅 `MachineSummaryDirectory`。
- 打开会话、正文、composer 等现有路径不变。

## 8. 验收（均未执行）

| 场景 | 可观察的通过条件 |
| --- | --- |
| 10,000 条会话，内容不变时重连 | 1 个请求、响应小于 1 KB；daemon 读取 0 个 meta 文件、序列化 0 个摘要 |
| 在线改名 1 次 | 1 条推送，对象不超过 5 个；同一工作区 10,000 条会话时字节数小于 64 KB；其他工作区无写入 |
| daemon 重启，内容未变 | `unchanged`，不传任何对象 |
| 关闭期间改名 1 条、删除 1 条，并重启 daemon | 逐层补齐后成员正确，已删除项不复活，请求数不超过 6；只有摘要和桶的对象被重取 |
| 断网时重开浏览器 | 网络请求发出之前就显示"上次状态"的机器视图；恢复网络后变为"已核对" |
| 推送丢失、broadcast 落后、`base` 不匹配 | 自动 sync 并收敛到 daemon 当前根，不整页闪烁 |
| 对象损坏或被驱逐 | 检出 hash 不符或缺失后重取，不显示为完整 |
| 某工作区出现 scope 错误 | 该工作区显示"未知"，其会话不被删除；其他工作区正常 |
| Agent 输出 1,000 个 token | 0 条目录事件；运行状态从 running 变为 idle 时恰好 1 条 |
| 第 12,001 条会话或第 4,097 个工作区 | 明确报"目录容量超限"，已有视图保持可用 |
| daemon 未声明 `directory.sync.v1` | 机器行提示"需要更新此机器"；不会调用 `session.list`、`session.page` 或 `catalog.sync` |
| 防止旧路径回流 | 测试断言 workbench 源码里没有 `session.list` 和 `catalog.sync` 调用，且只有 `directory-store.ts` 直接打开 IndexedDB |
| 输出确定性 | Rust 测试：相同输入产生相同字节和 hash；TS 测试：对收到的字节校验 hash |
| CLI 与页面并发（1、20、100 个读者） | `session list --limit 50` 在预热后读取 0 个 meta 文件；现有 CLI 专项全部通过；记录 daemon RSS 和前台 p95，与主干对照 |

字节和请求数上限是设计目标，需要在实施阶段用真实 daemon 加浏览器测量后确认，不沿用 v1 原型的数字。

## 9. 重复模块清理

| 阶段 | 删除或替换 | 保留 |
| --- | --- | --- |
| P1 daemon | 新增 `DirTree`、`directory.sync`、`directory.changed`；`CatalogProjection` 的 `rows/dirty/removed/workspaces/errors/revision` 由树替代 | `PageCatalog` 扫描、排序索引、`session.page` |
| P2 workbench | 删除 `summary-directory-cache.ts`、`Client.followCatalog/repairCatalog/receiveCatalog`、`store.ts` 的目录副本和 `session.list` 降级、`AgentDetails.tsx` 的全量 `session.list`、`useAgentActivity.ts:42` 以及 `store.ts` 中全部按 `catalog.sync.v1` 分支的降级（第 953、1440、3105、3195、3672 行）、`session-pages.ts` 中所有目录翻页循环、`summary-directory.ts` 的翻页和补页 | Forward 选择器的 500 条上限改为从 L3 本地读取 |
| P3 daemon 清理 | 删除 `catalog.sync` 处理、`CatalogBatch/CatalogKnown*/CatalogSessionRow/CatalogWorkspaceRow`、`summary_etag`、`SessionPageResult.catalogEtags/catalogRevision/etag/notModified` 和 `ifNoneMatch`、`manager.rs` 中为旧全量 list 服务的 `list_reads` | `session.list` RPC 只留给 CLI 的筛选完整查询 |
| P4 团队工具 | `board.py:635` 和 `team.py:2604` 的轮询确认改为由 L1 提供（不读 meta）；不新增 CLI 参数 | 用户机器上已部署的旧副本照常运行，只是收益较少 |
| 实验产物 | `prototypes/layered-file-hash-sync/`、`layered-sync-lab.ts`、两个 `layered-*` 专项不合入主干；P1 合入后从槽位分支删除 | 运行记录和证据保留在 `spaces/dev-3` |

daemon 中其他 digest 实现（`provider_control`、`config`、`inbox`、`agent_space_plan`）用途不同，不在本次合并范围内。

P1 到 P3 在同一个 dev-3 分支上依次提交，作为一个候选整体验收和发布，不单独发布其中任何一步。

## 10. 兼容、发布与回滚

**兼容边界（已按用户要求简化）：**

| 组合 | 行为 |
| --- | --- |
| 新客户端 + 旧 daemon | 机器行提示更新，目录不可用 |
| 旧客户端 + 新 daemon | 由于 `catalog.sync.v1` 不再声明，旧客户端会按其自带逻辑降级到 `session.page`/`session.list` 轮询，可用但较慢 |

两种组合下都只是变慢或不可用，不会丢数据。

**发布顺序：** 先发 daemon（Beta 设备更新），再发 Console。期间旧 Console 只是退化为轮询。

**回滚：**
- L1 不落盘，L0 文件格式不变，L3 可丢弃，因此回退二进制即可。
- 回退到旧客户端后，旧库 `genehub-directory-v1` 已被删除，冷启动一次即可恢复。
- 不涉及用户数据迁移。

## 11. 取舍与替代方案

| 方案 | 结论 |
| --- | --- |
| 保持 `catalog.sync` 加已知清单 | 改动最少，但重连成本随已知集合线性增长，daemon 重启后仍需整份修复，前端重复也解决不了 |
| 修订号加持久变化日志 | 可以短路补齐，但要持久化、截断并处理重启，比内容 hash 多一套状态 |
| v1 通用平台 | 目标正确但范围过大，跨语言编码和通用内核的风险集中在一期 |
| 本方案 | 只增加一棵内存树和两个消息，同时删除三套旧路径。代价是每次变化要重算路径 hash，并保留 8 个根的内存 |

## 12. 实施前必须关闭的问题

1. **摘要抖动频率。** 团队高负载时，Live 状态和协调投影每分钟会触发多少次目录事件？是否需要 200 ms 合并窗口？在 P1 用真实团队负载测量。
2. **L1 内存。** 12,000 条会话加 8 个保留根的 RSS 估计在数十 MB 级，未测量。P1 必须给出测量值；超过预算时把保留根降为 2 个。
3. **冷启动开销。** 扫描后构建整棵树（10,000 次序列化和 SHA-256）额外增加多少时间？主干基线的冷恢复是 3,356 ms（v1 实测）。若增量超过 10%，需要说明原因。
4. **发布窗口。** 发布期间设备上 daemon 版本参差不齐，用户看到的"需要更新"提示必须可以操作，需要由 release-beta 确认这个窗口是否可以接受。
5. **根对象过大。** 若有机器工作区数量接近上限，根对象接近 1 MiB，需要评估是否给根再分一层。默认不分。
