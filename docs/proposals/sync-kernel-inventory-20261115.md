# 同步内核 v9 明细清单：可简化的协议与模块

状态：待评审；只是清单，尚未实施。日期：2026-11-15。

**本文是 [v9](sync-kernel-v9-20261115.md) 第 8 节的明细展开**，把"可以简化"落到具体的协议项、文件、函数和行号上。执行顺序和门槛见[落地与迭代打磨方案](sync-kernel-landing-20261115.md)。和这两份文档冲突时：
- 数字和位置以本文为准，本文是逐项实测的结果；
- 架构以 v9 为准；
- 执行以落地方案为准。

**修订记录（2026-11-15，第二轮 Human 决定）：** 不做兼容，"删除"指该阶段结束时代码已不存在；阶段按 v9 新的划分重排（会话目录从 P3 提前到 P2，P3 只做汇聚转发；原"收尾"的项目并入 P1 或 P5）；团队模板不改，第 2.4 节改为团队模板依赖的 CLI 接口清单；`hooks/mod.rs` 不新增 `change` 事件；修正特性字符串的计数（删除 16 个、移进 `hello` 5 个）。

**基线：** Open 主干 `158d7351`。所有位置都用 `git show origin/main:<文件>` 读取，行号是该版本的行号；不含测试代码。

**口径：**

| 写法 | 含义 |
| --- | --- |
| 删除 | 该阶段结束时，代码不再存在（不做兼容，没有兼容窗口） |
| 替换 | 由新原语承担，原位置留下很薄的调用 |
| 搬移 | 逻辑保留，挪进数据源或意图处理器 |
| 保留 | 不变 |

"阶段"指 v9 第 10 节的 P0–P5。

## 0. 结论

**协议：**
- 131 个 `Request` 变体中：
  - 26 个状态读取改为节点或视图订阅；
  - 2 个会话订阅控制（`subscribe/unsubscribe`）并入 `sync` 流；
  - 6 个按需计算的读取保留为只读调用；
  - 8 个历史和内容读取中：`session.narrative` 改为轮次节点加实时流；`round.trunk.*` 3 个改为不可变节点（含内联缩略图，有大小上限）；`blob.*`、`git.diff`、`session.forkExport` 4 个保留，不走同步；
  - 10 个流式方法中，PTY 的 4 个合并为 1 条流，上传的 4 个可选合并为 1 条流，2 个保留；
  - 2 个连接方法中，`connection.identity` 在 P1 并入 `hello`；
  - 77 个写操作改为意图。其中有 18 个名字可以合并（第 1.7 节），不做兼容，P0 直接定下合并后的约 59 个意图名。
- 11 种推送帧：9 种删除（其中 `Notice` 是现在就可以删的死代码），2 种（PTY 输出）改为独立流。
- 8 个 exchange 方法：删除 3 个（`protocol.identity` 在 P1，`events` 在 P5，`rpc` 在 P5 只剩写操作后并入 `call`），新增 5 个（`hello`、`sync`、`call`、`live`，以及每个终端一条的 `pty` 流）。方法数从 8 个变为 10 个，但每个方法只做一件事：原来挤在 `events` 一条流里的会话增量和终端输出各自独立。业务语义只剩 `sync` 和 `call` 两个入口。
- 21 个特性字符串：16 个删除，进入 schema 的读形状和意图名单；5 个是流能力或传输能力，在 P1 移进 `hello`。团队模板依赖的 `session.create-id.v1`、`session.prepare.v1` 由 CLI 继续在 `genet context` 里报告（第 1.9 节）。

**框架边界（v9 第 4.3 节，2026-11-15 Human 决定）：**
- 同步框架只承载会收敛的状态和小的不可变内容；
- 流式输出是框架之上的补充，只在有人观看时推送；
- 大文件、高清图片和视频、终端、shell 都不走同步，也不为它们做续传。

本清单按这个边界给出每一项的去向。

**修正 v9 第 8 节（早先版本）：**
- 方法共 131 个，早先版本漏掉了 `subscribe` 和 `unsubscribe`（`rpc.rs` 里没有带点号的名字）。
- "32 个状态读取"细分为 26 个可订阅，加 6 个按需计算。
- 特性字符串早先写的是"删除 14 个、保留 7 个"，逐项核对第 1.9 节的表是删除 16 个、移进 `hello` 5 个。

**模块：** 第 2 节逐文件、逐函数列出动作和行号。两处早先的估计已修正：
- 工作台 `protocol/client.ts`：早先估计删除 600–900 行。实测这个文件没有按 RPC 写的包装（调用方直接 `client.call({type})`），可删除的部分是目录订阅 143 行、事件流 151 行、协议身份 32 行，**约 330 行**。
- daemon `router.rs` 读取分支：实测 **约 340 行**。这些分支很薄，读取逻辑在 `session/manager.rs` 等处，迁移时是搬进数据源，不是删除。

团队模板不改之后，合计删除估计为**约 4,530–5,530 行**（第 3 节），v9 第 8.5 节已同步。

**另外两项发现：**
- `Notice` 推送帧在生产代码里没有任何发送点，只在测试里构造（`endpoint.rs` 的测试模块从 1696 行开始），工作台却一直在监听（`client.ts:1577`）。它是死代码，可以在 P0 直接删除。
- `session.forkImportRouted` 和 `workspace.create` 在工作台和 CLI 里都没有调用方，只出现在测试和 Cloud 的反馈诊断白名单里（第 1.11 节）。P0 评审时确认有没有外部调用方，没有就直接删除。

## 1. 协议

### 1.1 exchange 方法（`dataplane/endpoint.rs`）

| 方法 | 处理位置 | 动作 | 阶段 |
| --- | --- | --- | --- |
| `protocol.identity` | `handle_protocol_identity` 1147–1180 | 删除，并入 `hello` | P1 |
| `rpc` | `handle_rpc` 1181–1322；业务分发在 `router.rs` 466–2701（195 个分支） | 删除。读取随族改走 `sync`；P5 时只剩写操作，并入 `call` | 随族，P5 结束 |
| `events` | `handle_events` 1568–1609；副作用 `apply_side_effect` 1456–1567（目录订阅、失步） | 删除：状态改走 `sync`，逐字增量改走 `live` | P5 |
| 新增 `live` | — | 实时补充流：有人观看某个会话时打开，只推 `ItemDelta`；不保证可靠，断开或有缺口时重新 `get` 轮次节点 | P5 |
| `asset.preview`、`file.read`、`shell.run`、`service.preview` | 方法分发 `serve_stream` 1096–1146；诊断用的方法名表 `support_stream_operation` 1351–1361 | 保留 | — |
| `rtc.negotiate` | 同上 | 保留 | — |
| 新增 `hello` | — | 数据面版本、每族的 schema 描述、流能力 | P0 定义，P1 实现 |
| 新增 `sync`、`call` | — | v7 第 10.2 节的帧；意图信封 | P0 定义，P1 实现 |
| 新增 `pty` | 替代 `forward_fanout` 487–591 中的终端部分 | 每个终端一条双向流 | P5 |

### 1.2 状态读取 → 节点或视图（26 个）

位置列说明：`router.rs` 是业务分发分支的起始行；工作台列是 `client.call({type})` 的调用文件和次数；CLI 列是 `apps/daemon/src/cli_front/` 下用到它的文件。

| 方法 | 目标 | 阶段 | daemon 处理 | 工作台调用方 | CLI |
| --- | --- | --- | --- | --- | --- |
| `workspace.list` | 视图 `m/<机器>/ws/`（子节点 `ws/<id>/meta`） | P2 | `router.rs:2188` | `app/WorkbenchApp.tsx`×1、`preview/AssetPreviewPage.tsx`×1、`protocol/summary-directory.ts`×1、`session/store.ts`×2 | `query.rs` |
| `session.list` | 视图 `sessions.recent` 与 `m/<机器>/ws/<id>/session/` | P2 | `router.rs:796` | `session/store.ts`×1、`workspace/AgentDetails.tsx`×1 | `query.rs` |
| `session.page` | 同上（有界窗口取代分页） | P2 | `router.rs:813` | `protocol/session-pages.ts`×1、`session/store.ts`×2 | `query.rs` |
| `session.changes` | 同上（令牌续接取代 `since` 游标） | P2 | `router.rs:831` | — | `query.rs` |
| `catalog.sync` | 同上（订阅取代目录同步） | P2 | `router.rs:525` | `protocol/client.ts`×2 | — |
| `session.get` | `m/<机器>/ws/<工作区>/session/<会话>/summary`、`…/state` | P2 | `router.rs:843` | `session/store.ts`×1 | `converse.rs`、`query.rs` |
| `session.drafts` | `m/<机器>/ws/<工作区>/session/<会话>/drafts` | P2 | `router.rs:874` | `session/store.ts`×2 | — |
| `session.previewAnnotations.get` | `m/<机器>/ws/<工作区>/session/<会话>/annotations` | P2 | `router.rs:888` | `preview/PreviewAnnotation.tsx`×1、`session/store.ts`×1 | — |
| `agentSpace.children` | `m/<机器>/ws/<id>/children` | P4 | `router.rs:2267` | — | `space.rs` |
| `agent.list` | `m/<机器>/agent/<id>` | P4 | `router.rs:571` | `app/WorkbenchApp.tsx`×1、`session/store.ts`×2 | `converse.rs` |
| `agent.requests` | `m/<机器>/agent/<id>/request/<请求>` | P4 | `router.rs:628` | `session/store.ts`×1 | — |
| `provider.list` | `m/<机器>/provider/<id>` | P4 | `router.rs:1768` | — | `provider.rs` |
| `settings.get` | `m/<机器>/settings` | P4 | `router.rs:1799` | `app/WorkbenchApp.tsx`×1、`session/store.ts`×2 | — |
| `device.list` | `m/<机器>/device/<id>` | P4 | `router.rs:2107` | `session/store.ts`×1 | `machine.rs` |
| `access.list` | `m/<机器>/access` | P4 | `router.rs:2172` | `settings/AccessSettings.tsx`×1 | `query.rs` |
| `fileAccess.list` | `m/<机器>/fileAccess` | P4 | `router.rs:2178` | `settings/FileAccessSettings.tsx`×1 | `query.rs` |
| `hub.status` | `m/<机器>/hub` | P4 | `router.rs:2007` | `preview/PreviewFloat.tsx`×1、`session/store.ts`×1 | `desktop.rs`、`hub.rs`、`machine.rs` |
| `process.list` | `m/<机器>/process/<id>`（观察者） | P4 | `router.rs:2572` | `session/store.ts`×1 | `process.rs` |
| `process.workspaceList` | 视图 `m/<机器>/process/?ws=<id>` | P4 | `router.rs:2578` | `session/store.ts`×1 | — |
| `update.downloadState` | `m/<机器>/update` | P4 | `router.rs:1992` | `session/store.ts`×1 | — |
| `speech.capabilities` | `m/<机器>/speech` | P4 | `router.rs:1810` | `speech/useSpeechInput.ts`×1 | `speech.rs` |
| `session.components` | `m/<机器>/ws/<工作区>/session/<会话>/components` | P5 | `router.rs:930` | — | `query.rs` |
| `session.rounds` | `m/<机器>/ws/<工作区>/session/<会话>/rounds`（日志索引视图） | P5 | `router.rs:974` | — | `query.rs` |
| `session.context` | `m/<机器>/ws/<工作区>/session/<会话>/context` | P5 | `router.rs:995` | — | `query.rs` |
| `git.status` | `m/<机器>/ws/<id>/git` | P5 | `router.rs:2491` | `changes/ChangesPanel.tsx`×1、`session/store.ts`×1 | — |
| `file.tree` | `m/<机器>/ws/<id>/tree/<路径>`（只含已展开目录） | P5 | `router.rs:2362` | `files/FilesPanel.tsx`×1、`session/store.ts`×1 | — |

### 1.3 保留为只读调用（6 个）

这几项是按需计算，结果不需要订阅，改为 `call` 的只读意图，不进节点。

| 方法 | 原因 | daemon 处理 | 工作台调用方 | CLI |
| --- | --- | --- | --- | --- |
| `session.inspect` | 诊断用的按需计算，结果不需要订阅 | `router.rs:937` | — | `query.rs` |
| `session.importList` | 扫描其他 Agent 的可导入会话，按需计算 | `router.rs:1451` | `session/store.ts`×1 | — |
| `caller.authority` | 调用方身份，按需计算 | `router.rs:1767` | `settings/ProviderConfigurationCard.tsx`×1 | `query.rs` |
| `diagnostics.snapshot` | 诊断快照 | `router.rs:1950` | `protocol/client.ts`×1 | — |
| `directory.list` | 建工作区之前浏览任意目录，不在任何子树里 | `router.rs:2345` | `workspace/OpenProject.tsx`×1 | — |
| `hub.machines` | 机器目录的权威是 Hub（v7 第 15 节第 4 条未决），本期不迁 | `router.rs:2074` | `host/index.ts`×2 | `machine.rs` |

### 1.4 会话订阅控制（2 个）

| 方法 | 目标 | 阶段 | daemon 处理 | 工作台调用方 | CLI |
| --- | --- | --- | --- | --- | --- |
| `subscribe` | `sync` 上 `watch` 轮次节点；正在观看时另开 `live` 流 | P5 | `router.rs:536` | `protocol/client.ts`×2 | `converse.rs` |
| `unsubscribe` | `sync` 上的 `drop`，同时关闭 `live` 流 | P5 | `router.rs:564` | `protocol/client.ts`×1 | — |

### 1.5 历史、内容与流（20 个）

| 方法 | 目标 | 阶段 | daemon 处理 | 工作台调用方 | CLI |
| --- | --- | --- | --- | --- | --- |
| `session.narrative` | 轮次节点 `m/<机器>/ws/<工作区>/session/<会话>/turn/<轮次>`（运行中可变，封存后不可变），加 `live` 流 | P5 | `router.rs:951` | `session/store.ts`×2 | `query.rs` |
| `round.trunk.list` | 不可变节点的视图 `m/<机器>/ws/<工作区>/session/<会话>/turn/<轮次>/trunk/` | P5 | `router.rs:1010` | `session/ForwardDialog.tsx`×1、`session/store.ts`×2 | `query.rs` |
| `round.trunk.get` | 不可变节点 `…/trunk/<n>`（含内联缩略图，有大小上限，令牌就是内容 id） | P5 | `router.rs:1026` | `session/store.ts`×2 | `query.rs` |
| `round.trunk.batchGet` | 一次 `get` 多个键 | P5 | `router.rs:1048` | `session/store.ts`×1 | — |
| `blob.get` | 保留：全文读取，不走同步；节点里只放 `BlobRef` | — | `router.rs:1041` | `session/store.ts`×2 | `query.rs` |
| `blob.batchGet` | 保留，同上 | — | `router.rs:1055` | `session/store.ts`×1 | — |
| `git.diff` | 保留：内容读取 | — | `router.rs:2502` | `changes/ChangesPanel.tsx`×1、`session/store.ts`×1 | — |
| `session.forkExport` | 保留：导出内容 | — | `router.rs:1365` | `app/WorkbenchApp.tsx`×1 | — |
| `pty.open` | 合并为每个终端一条双向 `pty` 流（4 → 1） | P5 | `router.rs:2528` | `terminal/TerminalPanel.tsx`×1 | — |
| `pty.write` | 同上 | P5 | `router.rs:2551` | `terminal/TerminalPanel.tsx`×1 | — |
| `pty.resize` | 同上（流内控制帧） | P5 | `router.rs:2558` | `terminal/TerminalPanel.tsx`×1 | — |
| `pty.close` | 同上（关闭流） | P5 | `router.rs:2565` | `terminal/TerminalPanel.tsx`×2 | — |
| `session.artifact.begin` | 可选：合并为一条上传流（4 → 1） | P0 定 | `router.rs:1190` | `preview/sessionArtifactUpload.ts`×1 | — |
| `session.artifact.chunk` | 同上 | P0 定 | `router.rs:1205` | `preview/sessionArtifactUpload.ts`×1 | — |
| `session.artifact.finish` | 同上 | P0 定 | `router.rs:1222` | `preview/sessionArtifactUpload.ts`×1 | — |
| `session.artifact.abort` | 同上 | P0 定 | `router.rs:1236` | `preview/sessionArtifactUpload.ts`×1 | — |
| `agent.logs` | 保留 | — | `router.rs:617` | `session/store.ts`×1 | `converse.rs` |
| `log.tail` | 保留 | — | `router.rs:1931` | `session/store.ts`×1 | — |
| `connection.identity` | 并入 `hello` | P1 | `router.rs:481` | `protocol/client.ts`×3 | `rpc_wire.rs` |
| `client.debug` | 保留 | — | `router.rs:472` | `client-debug/index.ts`×2 | `client.rs` |

### 1.6 写操作 → 意图（77 个）

写操作的处理器逻辑都保留。变化在于：
- 统一走 `call` 信封，本机和远程同路；
- `ifToken` 替代 `expected_revision`（目前用在 `agentSpace.configure`、`agentSpace.changePlan`）；
- 意图名单写进各族的 schema，替代对应的特性字符串。

| 族 | 方法 | 数量 | 阶段 |
| --- | --- | --- | --- |
| 会话属性（改为对 `m/<机器>/ws/<工作区>/session/<会话>` 的意图，`ifToken` 取会话摘要令牌） | `session.setModel`、`session.setMode`、`session.setEffort`、`session.setFast`、`session.setRuntimeAxis`、`session.rename`、`session.label`、`session.describe`、`session.archive`、`session.delete`、`session.drafts.replace`、`session.previewAnnotations.upsert`、`session.previewAnnotations.remove` | 13 | P2（属性与草稿、批注） |
| 会话执行 | `session.create`、`session.createRouted`、`session.send`、`session.interrupt`、`session.close`、`session.respondPermission`、`session.ask`、`session.switchAgent`、`session.route`、`session.fork`、`session.forkRouted`、`session.forkImport`、`session.forkImportRouted`、`session.import` | 14 | P5 |
| 工作区与 Space | `workspace.open`、`workspace.addRoot`、`workspace.create`、`workspace.rename`、`workspace.remove`、`workspace.terminate`、`workspace.resume`、`agentSpace.configure`、`agentSpace.changePlan`、`directory.mkdir` | 10 | P2（工作区）、P4（Space 配置） |
| Agent 与 Provider | `agent.refresh`、`agent.action`、`agent.reload`、`agent.reset`、`agent.test`、`agent.requestAnswer`、`provider.operation`、`settings.setProvider`、`settings.setAgentPreferences`、`settings.forgetProvider` | 10 | P4 |
| 机器、设备、Hub、权限 | `device.invite`、`device.claim`、`device.revoke`、`device.remoteAttach`、`device.remoteDetach`、`hub.pair`、`hub.trial`、`hub.claimLink`、`hub.connect`、`hub.unpair`、`access.request`、`fileAccess.configure` | 12 | P4 |
| 更新、语音、进程、反馈 | `update.check`、`update.appCheck`、`update.download`、`update.dismiss`、`speech.runtime.probe`、`speech.runtime.configure`、`speech.context.preview`、`speech.feedback.record`、`process.kill`、`process.killAll`、`process.serviceStop`、`preview.feedback` | 12 | P4 |
| 文件与 Git | `file.write`、`file.mkdir`、`file.copy`、`file.move`、`file.delete`、`git.commit` | 6 | P5 |

### 1.7 可以合并的名字（P0 决定）

| 现在 | 合并为 | 减少 |
| --- | --- | --- |
| `session.setModel`、`setMode`、`setEffort`、`setFast`、`setRuntimeAxis` | `session.configure {model?, mode?, effort?, fast?, axes?}` | 4 |
| `session.rename`、`label`、`describe`、`archive` | `session.updateMeta {title?, labels?, description?, archived?}`，`ifToken` 取摘要令牌 | 3 |
| `session.create`、`createRouted` | `session.create {route?}` | 1 |
| `session.fork`、`forkRouted` | `session.fork {route?}` | 1 |
| `session.forkImport`、`forkImportRouted` | `session.forkImport {route?}` | 1 |
| `update.check`、`appCheck` | `update.check {kind}` | 1 |
| `process.kill`、`killAll` | `process.kill {scope}` | 1 |
| `pty.open/write/resize/close` | 一条 `pty` 流（第 1.1 节） | 3 |
| `session.artifact.begin/chunk/finish/abort` | 一条上传流（可选） | 3 |
| **合计** |  | **18** |

`agent.refresh` 的作用是强制刷新 Agent 目录。改为观察者数据源之后可能不再需要；是否删除，在 P4 实测后决定，不计入上表。

### 1.8 推送帧（11 种，`rpc.rs` 1396–1480）

| 帧（线上名） | daemon 发送位置 | 工作台接收位置 | 动作 | 阶段 |
| --- | --- | --- | --- | --- |
| `Catalog`（`catalog`） | `endpoint.rs:1476`（`apply_side_effect`） | `client.ts:1558` → `receiveCatalog` 944–1017 | 删除，改为视图订阅 | P2 |
| `Event`（`event`） | 构造函数 `rpc.rs:1478`，经 `handle_events` 发出 | `client.ts:1559` → `receiveEvent` 1556–1602、`fillGap` 1608–1649 | 删除：已完成的条目进轮次节点，逐字增量走 `live` 流；`fillGap` 不再需要 | P5 |
| `Desync`（`desync`） | `endpoint.rs:1551` | `client.ts:1597` | 删除，由令牌续接处理 | P5 |
| `AgentsChanged`（`agents`） | `lib.rs:305` | `client.ts:1587` | 删除，改为 Agent 节点 | P4 |
| `AgentRequestOpened`（`agentRequest`） | `lib.rs:263`、`279` | `client.ts:1590` | 删除，改为请求节点 | P4 |
| `AgentRequestClosed`（`agentRequestClosed`） | `lib.rs:269`、`284` | `client.ts:1593` | 同上 | P4 |
| `BackgroundProcesses`（`processes`） | `processes.rs:123` | `client.ts:1580` | 删除，改为进程节点 | P4 |
| `UpdateDownloadChanged`（`updateDownload`） | `updates.rs:686` | `client.ts:1584` | 删除，改为更新节点 | P4 |
| `Notice`（`notice`） | **无**：生产代码里没有发送点，只在 `endpoint.rs` 的测试模块中构造 | `client.ts:1577` | 删除（死代码）；需要机器通知时再按节点设计 | P0 |
| `PtyOutput`（`pty`） | `endpoint.rs:504`、`519`；`transport/local.rs:58` | `client.ts:1571` → `terminal/TerminalPanel.tsx` | 改为独立 `pty` 流 | P5 |
| `PtyClosed`（`ptyClosed`） | `endpoint.rs:509`；`transport/local.rs:60` | `client.ts:1574` | 同上（流结束即关闭） | P5 |

工作台里订阅这些帧的监听器分布在：`protocol/client.ts` 9 处、`session/store.ts` 8 处、`session/TimelineView.tsx` 8 处，另有 `WorkbenchApp.tsx`、`SessionProcessesDialog.tsx`、`ForwardDialog.tsx`、`TerminalPanel.tsx` 各 1 处。

### 1.9 特性字符串（21 个，`router.rs` 497–522）

| 特性 | 工作台判断次数 | 其他使用方 | 动作 | 阶段 |
| --- | --- | --- | --- | --- |
| `catalog.sync.v1` | 11 | — | 删除 | P2 |
| `session.page.v1` | 8 | — | 删除 | P2 |
| `session.active-page.v1` | 3 | — | 删除 | P2 |
| `session.changes.v1` | 0 | `cli_front/query.rs` | 删除 | P2 |
| `session.summary.v1` | 0 | `cli_front/query.rs`；内置 Skill `multi-machine.md` | 删除 | P2 |
| `session.previewAnnotations.v1` | 0 | `preview/reviewDraft.ts` | 删除，进入会话族 schema | P2 |
| `workspace.terminate.v1` | 4 | `cli_front` | 删除，进入意图名单 | P2 |
| `process.services.v1` | 1 | — | 删除，进入进程族 schema | P4 |
| `access.status.v1` | 1 | — | 删除，进入权限族 schema | P4 |
| `provider.configuration.v1` | 0 | `cli_front/query.rs` | 删除，进入意图名单 | P4 |
| `preview.feedback.v1` | 3 | — | 删除，进入意图名单 | P4 |
| `session.input.v1` | 3 | — | 删除，进入意图名单 | P5 |
| `session.create-id.v1` | 0 | 团队模板 `tasks.py`、`team.py`；`cli_front` | 删除，进入意图名单 | P5 |
| `session.prepare.v1` | 0 | 团队模板 `tasks.py`、`team.py`；`cli_front/query.rs` | 删除，进入意图名单 | P5 |
| `session.switch-agent.v1` | 0 | — | 删除，进入意图名单 | P5 |
| `agent-tag-routing.v1` | 1 | — | 删除，进入意图名单 | P5 |
| `fabric.channels.v1` | 1 | — | 保留，移进 `hello` 的传输能力 | P1 |
| `asset.preview.image.v1` | 3 | — | 保留，移进 `hello` 的流能力 | P1 |
| `asset.preview.machine-file.v1` | 4 | — | 同上 | P1 |
| `service.preview.v1` | 1 | — | 同上 | P1 |
| `session.file-upload.v1` | 2 | — | 同上，随上传流是否合并一起决定 | P0 定 |

删除 16 个，移进 `hello` 5 个（`session.file-upload.v1` 随上传流是否合并一起决定）。

团队模板通过 `genet context` 的 `daemon.features` 判断 `session.create-id.v1` 和 `session.prepare.v1`（`tasks.py:106-108`、`team.py:724-726`、`team.py:1248-1252`）。P5 删除 daemon 的特性表之后，CLI 从会话族的意图名单推导出这两个名字，继续放在 `daemon.features` 里，团队模板不用改（v9 第 4.5 节）。

### 1.10 版本与握手

| 项 | 位置 | 动作 | 阶段 |
| --- | --- | --- | --- |
| `WEB_PROTOCOL_VERSION = 4` | `packages/identity/src/lib.rs:26` | 删除，由 `hello` 的数据面版本取代 | P1 |
| `DATA_PLANE_VERSION = 4` | 同上 `:32` | 保留；每个改变线上协议的阶段提升一次，版本不同就显示"需升级"（v9 第 12 节） | 随阶段 |
| `protocol.identity` 方法 | 同上 `:36`；`endpoint.rs:1147` | 并入 `hello` | P1 |
| `connection.identity` 请求 | `router.rs:481` | 并入 `hello` | P1 |
| `HelloResult.features` | `packages/proto/src/domain.rs:1612` | 改为 schema 描述加流能力 | P0 |
| 工作台版本适配器 | `protocol/versions/v4.ts`（26 行） | 删除；不做兼容，不需要版本适配 | P1 |

### 1.11 跨仓库与生成物的依赖

改名或删除方法时，以下位置必须同步修改，否则会在别处静默失效：

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| Cloud `server/src/http/app-api.ts` 934–993 `SAFE_MACHINE_OPERATIONS` | 反馈诊断中允许记录的方法名，共 58 项 | 和意图名单同步；最好改为从 schema 生成 |
| `packages/proto/bindings/index.ts` | 由 Rust 类型生成的 TS 类型，其中第 1518 行是 `ServerFrame` | 随 schema 重新生成 |
| 团队模板 `tasks.py`、`team.py` | 通过 `genet context` 判断 `session.create-id.v1`、`session.prepare.v1` | 不改团队模板；CLI 继续报告这两个名字（第 1.9 节、第 2.4 节） |
| 内置 Skill `apps/daemon/builtin-skills/genehub/references/multi-machine.md` | 提到 `session.summary.v1` | P2 时更新说明 |
| `testing/` 下的 journey 和 specialty | 直接调用 RPC 名 | 随族迁移，同阶段改为新原语 |

### 1.12 补充流的合同

| 流 | 用途 | 合同 |
| --- | --- | --- |
| `live` | 有人观看会话时的逐字输出 | 无人观看不推送；不保证可靠；断开或有缺口时重新 `get` 轮次节点；`ItemDelta` 契约不变 |
| `pty` | 终端的输入、输出、窗口大小 | 每个终端一条，用 credit 做背压；慢的观看者只拖慢自己的流；终端是否存在、是否已退出的状态作为节点 |
| `shell.run` | 一次性命令 | 保持现状 |
| `asset.preview`、`file.read`、`blob.get` | 大内容读取：预览、下载、工具输出全文 | 保持现状，不做续传扩展；不走同步 |
| `service.preview` | 本地服务的 HTTP/WS 隧道，实时音视频 | 保持现状 |
| `agent.logs`、`log.tail` | 日志尾部 | 保持现状 |

**统一规则：** 流只负责实时性和大块内容，不承担正确性。需要知道"现在是什么状态"时，一律读节点。

## 2. 模块

### 2.1 工作台（`packages/workbench/src`）

| 文件 | 区域（行） | 行数 | 动作 | 阶段 | 替代 |
| --- | --- | --- | --- | --- | --- |
| `protocol/summary-directory.ts` | 全文件 | 654 | 删除 | P2 | `useView("sessions.recent")` |
| `protocol/summary-directory-cache.ts` | 全文件 | 142 | 删除 | P2 | 副本端的节点缓存 |
| `protocol/session-pages.ts` | 全文件 | 54 | 删除 | P2 | 视图窗口 |
| `protocol/machine-connections.ts` | `retain` 109–180 | 72 | 删除（目录来源保留连接的规则） | P3 | 订阅持有链路；连接池只管直连 |
| `protocol/client.ts` | `followCatalog` 875–893、`repairCatalog` 899–943、`receiveCatalog` 944–1017 | 143 | 删除 | P2 | `sync` |
|  | `runEvents` 1499–1555、`receiveEvent` 1556–1602、`fillGap` 1608–1649 | 151 | 删除 | P5 | 轮次节点与 `live` 流 |
|  | `protocolIdentityOn` 1467–1498 | 32 | 删除 | P1 | `hello` |
|  | 拨号、握手、心跳、RTC、重连（1031–2060） | — | 保留 | — | — |
| `session/store.ts` | `refreshCatalog` 3195–3242、`loadWorkspaces` 3244–3283、`loadSessions` 3721–3775、`readSessionPages` 3779–3872、epoch 记录 3715–3720 | 243 | 删除 | P2 | `useView` |
|  | `refreshSessions` 1128–1143、`refreshWorkspaces` 1144–1149、`loadMoreSessions` 1111–1116、`loadMoreSessionList` 1117–1127 | 39 | 删除 | P2 | 视图窗口 |
|  | `refreshSessionDrafts` 647–660、`refreshPreviewReview` 661–682 | 36 | 删除 | P2 | `useNode` |
|  | `withSnapshotStatus`、`reconcileObservedActivity`、`adoptSnapshotStatus`、`applySessionStatus`（3914–3998） | 68 | 删除 | P2 | 摘要节点即状态 |
|  | `attach` 924–1091 | 168 | 替换（只留连接切换，状态重置交给副本端） | P2 | 副本端 |
|  | `refreshAgents` 2859–2866、`refreshAgentRequests` 2894–2921、`loadSettings` 2712–2719、`checkUpdate` 2730–2743、`checkUpdates` 2744–2760、`refreshHub` 3008–3012、`refreshDevices` 3043–3047、`refreshBackgroundProcesses` 3059–3068 | 95 | 删除 | P4 | `useNode` |
|  | `loadTree` 2655–2667、`refreshGit` 2668–2677 | 23 | 删除 | P5 | 观察型节点 |
|  | `polledTurnFinished` 694–716、`refreshRound` 804–839、`scheduleRoundRefresh` 840–859 | 79 | 删除 | P5 | 轮次节点 |
|  | `trunkReads`、`oneAtATime` 782–803，`loadRound` 1610–1662，`loadOlderTrunks` 1663–1689，`loadTrunk` 1690–1715，`fetchTrunkDetails` 2230–2264 | 163 | 替换为不可变节点读取，专用的去重和缓存删除（按一半计入） | P5 | `useNode`、副本缓存 |
|  | `loadBlob` 1716–1732、`fetchBlobPayloads` 2265–2295 | 48 | 保留（全文读取不走同步） | — | — |
|  | 时间线、编辑器、标签页、发送、预表现 | — | 保留 | — | — |
| `app/MachineDirectoryLists.tsx` | 30 秒刷新与前台刷新 105–110 | 6 | 删除 | P2 | 订阅 |
| `app/WorkbenchApp.tsx` | 配对期间每 2 秒刷新 Hub，533–539 | 7 | 删除 | P4 | Hub 节点 |
| 15 个特性字符串的 48 处判断 | 见第 1.9 节 | — | 删除 14 个特性对应的判断 | 随族 | schema 协商 |
| `protocol/versions/v4.ts` | 全文件 | 26 | 删除 | P1 | — |

**工作台合计：** 删除约 2,030 行，实测函数行数之和。`attach` 的替换按一半计入；48 处特性判断不计入。

### 2.2 daemon（`apps/daemon/src`）

| 文件 | 区域（行） | 行数 | 动作 | 阶段 | 替代 |
| --- | --- | --- | --- | --- | --- |
| `router.rs` | 26 个状态读取和 2 个订阅控制的分支（第 1.2、1.4 节的行号） | 约 340 | 删除 | 随族 | 数据源和视图 |
|  | 77 个写分支 | — | 替换，改为意图处理器注册 | 随族 | `call` |
| `dataplane/endpoint.rs` | `apply_side_effect` 1456–1567 | 112 | 删除 | P2/P5 | `sync` 订阅表 |
|  | `handle_events` 1568–1609 | 42 | 删除 | P5 | `sync` |
|  | `handle_protocol_identity` 1147–1180 | 34 | 删除 | P1 | `hello` |
|  | `handle_rpc` 1181–1322 | 142 | 删除 | P5 | `call` |
|  | `forward_fanout` 487–591 | 105 | 替换：终端部分改为 `pty` 流，机器状态部分删除 | P4/P5 | `pty` 流、节点 |
| `lib.rs` | Agent 帧推送循环 251–310 | 约 60 | 删除 | P4 | Agent 数据源 |
| `processes.rs` | 推送 123 附近；按请求收集 | — | 搬移为观察者数据源 | P4 | 进程节点 |
| `updates.rs` | 推送 686 附近 | — | 搬移为数据源 | P4 | 更新节点 |
| `session/catalog.rs` | 全文件（目录投影、订阅总线） | 392 | 删除 | P2 | 会话目录数据源加视图 |
| `session/store.rs` | `catalog_changes` 2261–2336（`since` 游标） | 76 | 删除 | P2 | 令牌 |
|  | `sweep_catalog` 2637–2900、`sweep_home` 2901–3053、`reconcile_catalog` 2415–2461 | 465 | 删除全局 sweep，按 home 的有界重列搬进数据源 | P2 | C2 重列 |
|  | `scan_metadata` 3108–3243、`load_catalog` 2503–2636、指纹相关 | 约 270 | 搬移 | P2 | 文件型数据源的 C4 降级实现 |
| `session/coordination.rs` | 全文件 | 156 | 替换为会话族的节点投影，删除两秒缓存和过期判定 | P2 | 会话摘要节点 |
| `workspace.rs` | `scan_spaces` 341 起、`scan_tree` 519、`scanned_workspace` 545–623、`refresh_descriptor` 744–785 | 约 520 | 搬移为 Space 数据源 | P2/P4 | 监听加有界重列 |
| `hooks/mod.rs` | `tick_project` 219–284、`registered_hooks` 285–333、`run_timer` 922–953 | 约 150 | 替换：登记扫描搬进文件型数据源；hook 仍然只有 `timer` 事件 | P4 | 文件型数据源 |
| `cli_front/query.rs` | `parse_session` 477–747、`execute` 837–1408 中的读取分支、`command_schema` 1711–2382 | 约 1,500 涉及 | 替换：读命令改为视图上的薄封装；schema 由 schema 定义生成 | P1 起随族 | 生成的 CLI |
| `cli_front/rpc_wire.rs` | 事件流消费（363 附近） | — | 替换为 `sync` | P5 | — |
| `cli_front/target.rs`、`rpc.rs` | 每次调用建立远端链路 | — | 替换：复用 daemon 的机器间链路池 | P2 | 链路池 |
| 加密、传输、会话执行、adapter、PTY 主机、文件、Git | `dataplane/frame.rs`、`handshake.rs`、`authenticated_channel.rs`、`rtc*.rs`，`transport/*`，`session/manager.rs` 的执行部分，`adapter/*`，`pty.rs`、`pty_host.rs`，`files.rs`，`git.rs` | — | 保留 | — | — |

**daemon 合计：** 删除约 1,600–2,000 行；搬移约 1,300 行；CLI 的替换在生成代码到位后另行统计。

### 2.3 协议包（`packages/proto/src/rpc.rs`，1,501 行）

| 区域（行） | 动作 | 阶段 |
| --- | --- | --- |
| `Request` 枚举 33–997 中的 26 个读取和 2 个订阅控制变体 | 删除 | 随族 |
| `Request` 其余变体 | 替换为 schema 生成的意图参数类型 | 随族 |
| `Reply` 枚举 998–1101 中的读取回复 | 删除 | 随族 |
| 目录类型：`SessionPageRequest` 1102 到 `CatalogBatch` 1205–1230 | 删除 | P2 |
| `ServerFrame` 1396–1480 | 删除（PTY 改为流） | P2–P5 |
| `ErrorCode` 1366、`ProtocolError` 1384 | 保留，增加 v7 的 6 个码 | P0 |

**合计：** 删除约 500–700 行；新增 sync 帧和 schema 描述，计入 v9 第 9.4 节的预算。

### 2.4 团队模板：不改，只核对它依赖的 CLI 接口

团队模板（`apps/daemon/builtin-skills/genehub/references/team-template/tools`，主干 7,988 行）一行不改。它只通过 `genet` CLI 使用平台，下表是它依赖的接口，也是 v9 第 11.3 节 CLI 合同测试的最小清单。

| 团队模板的调用 | 位置 | 依赖的输出 | 背后的变化 | 阶段 |
| --- | --- | --- | --- | --- |
| `session list --workspace … --machine M --since <cursor\|start>` | `team.py:817-849` `_sync_pull` | `sessions`（每行含 `id`、`workspaceId`、`status`）、`removed`、`cursor`、`reset`、`complete` | 读本机的 M 副本；`cursor` 是视图令牌的不透明编码；无法识别的旧游标返回 `reset: true` | P2 |
| `session get/rounds/narrative --machine M` | `team.py` `session_summary`、`session_history` 等 | 现有字段 | 摘要读副本（P2）；轮次和正文读不可变节点（P5） | P2、P5 |
| `context --machine M` 的 `daemon.features` | `team.py:724-726`、`team.py:1248-1252`、`tasks.py:106-108` | 包含 `session.create-id.v1`、`session.prepare.v1` | 由 CLI 从意图名单推导 | P1 起 |
| `shell --machine M --workspace W -- …` | `team.py:477`、`install_remote.py:56` | 现有帧和退出码 | 复用机器间长链路 | P2 |
| `session send/interrupt/describe/archive`、`space open`、`workspace open/remove` | 多处 | 现有字段和退出码 | 改走 `call` 意图 | 随族 |
| `agent list`、`workspace list`、`process list`、`machine show`、`hook list` | 多处 | 现有字段 | 读副本 | P2、P4 |

`_sync_*`、`reconcile`、watchdog、收件箱、看板查询都保持原样；它们背后的 CLI 读取变成本机副本读取。团队以后是否删掉自造的增量同步，由团队自己决定。dev-3 合并主干时，团队模板如果有变化，按落地方案第 3.3 节重新核对本表。

## 3. 合计

| 区域 | 早先的估计 | 本文实测或修正后 |
| --- | --- | --- |
| 工作台 | 2,050–2,620 | 约 2,030 |
| daemon（不含 CLI） | 880–1,620 | 约 1,600–2,000（加上 `session/catalog.rs` 全文件和 endpoint 的事件与目录部分） |
| CLI | 400–800 | 400–800（生成代码到位后再统计） |
| 协议包 | 400–700 | 500–700 |
| 团队模板 | 800–1,200 | 0（不改） |
| **合计删除** | **4,400–6,900** | **约 4,530–5,530** |
| 搬移 | 1,500–2,500 | 约 1,300（daemon） |

新增代码的预算见 v9 第 9.4 节，去掉应用子树和变化触发 hook 之后上限约 8,600 行。v9 第 9.5 节的结论不变：行数大致持平，收益主要在机制数（第 0 节）；不做兼容之后，每个阶段结束时该族的旧代码已经删除。

## 4. 重现方法

本文的数字都可以用下面的方式在主干上重新得到：
- `Request` 变体：读取 `rpc.rs` 中 `pub enum Request` 到 `pub enum Reply` 之间，紧接在 `#[serde(rename = "…")]` 后面的变体名；
- daemon 处理位置：`git grep -n "Request::<变体>\b" origin/main -- apps/daemon/src`；
- 工作台调用方：`git grep -n 'type: "<方法名>"' origin/main -- packages/workbench/src`；
- 函数行号：按函数声明的起始行，到下一个同级声明的前一行。

P0 的状态面盘点脚本（落地方案第 8 节）会把这些规则固化下来。之后以脚本输出为准，替代本文的人工表格。
