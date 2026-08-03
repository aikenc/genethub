# GeneHub Daemon 规格

> 用户 PC 上唯一的常驻进程。Rust 实现，随桌面端分发。  
> 上位文档：[architecture.md](./architecture.md)。本文只展开 daemon 内部。

---

## 1. 设计原则

| 原则 | 含义 |
|------|------|
| **按 MVP 裁剪** | 成熟实现有几十个模块；我们只做闭环需要的那几个，不做"以后可能有用"的 |
| **内核不认识具体 agent** | 具体知识全部关在 adapter 里，见 [architecture.md](./architecture.md) §2 |
| **无状态优先** | 除会话记录外不缓存；重启后靠磁盘恢复，不靠内存 |
| **单进程** | 不拆微服务，不引数据库服务；SQLite 或 JSONL 落盘 |

体积目标：release 二进制 **< 20MB**，加上内置 agent 与 Tauri 壳，整包仍在下载 80MB 内。

---

## 2. 模块划分

```
apps/daemon/src/
├── main.rs           启动、单实例锁、优雅退出
├── config.rs         配置与数据目录
├── transport/
│   ├── local.rs      本地 HTTP + WebSocket（127.0.0.1，回环）
│   ├── lan.rs        局域网直连（同网段客户端，免走公网）
│   ├── uplink.rs     出站长连接到 Hub 转发层，供远端客户端接入
│   └── auth.rs       客户端鉴权：本地 token / 配对凭证
├── proto/            由 packages/proto 生成 + 手写辅助
├── session/
│   ├── manager.rs    会话生命周期、订阅广播、断线重放
│   ├── store.rs      落盘（JSONL 追加 + 索引）
│   └── timeline.rs   TimelineItem 装配与增量合并
├── adapter/
│   ├── mod.rs        AgentAdapter / AgentSession trait + 注册表
│   ├── registry.rs   发现、probe、catalog 缓存
│   ├── genet/        内置 agent（stdio JSONL）
│   └── acp/          通用 ACP（stdio NDJSON）
├── workspace.rs      项目与工作区
├── files.rs          目录树、读写、监听
├── git.rs            status / diff / commit（调 git 命令，不引 libgit2）
├── pty.rs            终端会话
├── updates.rs        有没有更新的版本（有人问才查，见 §7）
└── pairing.rs        设备配对、Hub 登记
```

MVP **不做**：定时任务、浏览器自动化、语音、worktree 编排、MCP 注入、插件系统、会话 fork/rewind。

---

## 3. 客户端协议

### 3.1 传输

| 通道 | 用途 | 优先级 |
|------|------|--------|
| `ws://127.0.0.1:<port>/ws` | 同机客户端（桌面壳内的 WebView） | ① 最优 |
| 局域网直连 | 同网段的手机与另一台电脑 | ② |
| 出站长连接到 Hub 转发层 | 公网访问；daemon 主动连出，不监听公网端口 | ③ 兜底 |

三条通道**说同一套消息**，差别只在鉴权与加密层。客户端按优先级依次尝试，对用户不可见。daemon 永远不在公网监听端口。

### 3.2 消息形状

请求/响应 + 服务端推送，统一 JSON 信封：

```jsonc
// 客户端 → daemon
{ "id": "c1", "type": "session.send", "payload": { "sessionId": "...", "text": "..." } }
// daemon → 客户端（应答）
{ "id": "c1", "type": "result", "ok": true, "payload": { ... } }
// daemon → 客户端（推送）
{ "type": "event", "topic": "session:<id>", "payload": { /* SessionEvent */ } }
```

### 3.3 MVP 方法集

| 域 | 方法 |
|----|------|
| 握手 | `hello`（版本、能力、机器指纹）、`subscribe` / `unsubscribe` |
| Agent | `agent.list`（含 probe 状态与 catalog）、`agent.refresh` |
| 会话 | `session.create` / `list` / `get` / `send` / `interrupt` / `close` / `archive` / `rename` / `delete` |
| 会话配置 | `session.setModel` / `setMode` / `respondPermission` |
| 设备 | `device.list` / `invite` / `claim` / `revoke` / `remoteAttach` / `remoteDetach` |
| 控制面 | `hub.status` / `pair` / `trial` / `claimLink` / `unpair`（可选，见 [desktop-client.md](./desktop-client.md) §8） |
| 工作区 | `workspace.list` / `open` / `create` |
| 文件 | `file.tree` / `read` / `write` / `watch` |
| Git | `git.status` / `git.diff` / `git.commit` |
| 终端 | `pty.open` / `write` / `resize` / `close`（输出走推送） |
| 更新 | `update.check` / `update.download` / `update.downloadState` / `update.dismiss`（见 §7） |

**断线重连**：客户端带上最后收到的事件序号，`subscribe` 时 daemon 回补缺口；补不齐（超出保留窗口）就回全量快照并明确告知，不做静默半量。回合进行中掉线也一样：回合不会因为没人看着就停，重连时缺的那段照样补得回来。

**没断线但落后了**也是同一件事:某个连接跟不上广播、事件被丢掉时,daemon 发 `desync{sessionId, missed}`。这是给客户端看的,不是给人看的——时间线上的一个洞不需要用一句话道歉,它需要被补上,而补的办法就是重连时那一个 `subscribe`。客户端收到就自己去补,不打扰用户。（早先这里发的是一句英文提示让人"重连一下":不重连的人留着一个永远不动的半截回答,重连的人以为出了故障。）

### 3.4 WebSocket 之外的两个 HTTP 端点

| 端点 | 用途 |
|------|------|
| `GET /health` | 「有没有人在」。托管它的外壳靠这个判断 daemon 是死是活——进程活着但监听卡死，对用户来说是一回事 |
| `POST /shutdown` | 请求它自己收干净退出。要 token，且**只接受 loopback**：开了局域网监听之后 token 会在内网里走，而「把那台机器关了」不该是一个借来的 token 能干的事 |

关停本该用信号，但 Windows 上没有能送达无窗口子进程的信号。少了这个端点，桌面壳在那里只能强杀——而被杀的 daemon 不会去收它派生的 agent 进程。

**这个请求可能比主循环还早到。** 监听在主循环开始等待之前就已经接受连接了，而「刚启动就退出/重启」是外壳的正常行为。所以停止信号必须是能存住的那一种：早到的通知不能丢。丢了的后果不是「慢一点」，而是端点回了 202、进程却继续活着，外壳等超时后强杀——正好是这个端点存在的意义被完全绕过。

---

## 4. 存储

### 4.1 会话

```
<data>/sessions/<workspace-hash>/<session-id>.jsonl
```

- 一行一个 `TimelineItem`，追加写，永不改写既有行
- 同目录 `meta.json`：agent id、模型、cwd、创建时间、`PersistHandle`
- 恢复时优先让 agent 自己 resume（用 `PersistHandle`）；agent 不支持恢复的，daemon 用本地记录**只读回放**，并在 UI 上标明"历史只读"

流式增量（`ItemDelta`）**不落盘**，只落最终态，否则文件大小会失控。

**标题是可空的。** 新会话没有标题，直到用户说了第一句话（取首行截断）或客户端自己给了一个。daemon 不会填一个「New session」占位——那是一个语言选择，而 daemon 不知道界面是什么语言；界面自己有更合适的词。之前用字符串哨兵判断「要不要自动命名」，副作用是客户端一旦自带标题就再也不会被自动改名，而这件事没人说得清是不是故意的。现在这就是 `Option`，两种情形各自成立。

`session.rename` 把它换成用户自己起的名字。**自动命名只在标题为 `None` 时发生**（`SessionManager::send`），所以改完之后不会被下一条消息盖回去——一个刚起好一秒钟就被改掉的名字，比不能改还糟。改完发一条 `titleChanged`，和 daemon 自己命名时发的是同一条：另一台设备上正开着这个会话的人不必等下一次 `session.list` 才看到。

`session.delete` 是真删：时间线、meta、以及那个会话的 scratch 目录一起没。scratch 里放的是 adapter 存的「CLI 自己那份对话」（`--resume` id、线程文件），留着它等于「删掉的对话在 agent 那边还在」，那不叫删除。没有回收站，也没有撤销——想删掉的对话，通常正是不希望留副本的那种。删一个已经不在的会话不算失败：调用方要的是「它不存在」，而它确实不存在，两个窗口点同一行不该有一个看到报错。

### 4.2 工作区与默认工作目录

已登记的工作区存在 `<data>/config.json` 里，只是 id、名字、根路径三样。

**新机器一定有一个可用的工作区。** 从没用过的机器上，daemon 启动时会在用户 home 下建一个 `GeneHub/` 并登记为工作区。没有这一步，新装用户能做的第一件事就是被拒绝：没有工作区就没有会话，于是第一屏是一个文件选择器，挡在他还没见过的产品前面。

三条约束，都不是随便定的：

| 约束 | 为什么 |
|------|--------|
| 放在 home，不放在 `<data>` 下 | `<data>` 是「卸载即整个删掉」的那个目录（见 [testing.md](./testing.md) §7 的自检项），而这里面装的是用户自己的文件，不是我们能删的东西 |
| 只在工作区列表为空时创建 | 打开过自己项目的人，永远不会看见它凭空冒出来 |
| 建不出来不算致命 | home 不可写很少见，但为此拒绝启动等于把「手动打开一个目录」这条路也一起断了；记一条 warn 继续走 |

`$GENEHUB_WORKSPACE_DIR` 可以改这个位置。它存在的理由和 `$GENEHUB_DATA_DIR` 一样：跑测试的人的 home 目录不该因为跑了一次测试而多出一个文件夹。

### 4.4 日志

```
<data>/logs/daemon.log      daemon 自己写，4MB 滚动一份 .log.1
<data>/logs/startup.log     桌面壳捕获的 daemon stderr，每次启动清空
<data>/logs/shell.log       桌面壳自己的启动记录
```

三件事值得写下来，因为它们各自修掉了一个「查不出来」：

**日志由 daemon 自己写，不靠启动它的人重定向。** 需要看日志的人经常不在那台机器前面——手机上拿到一个 `C:\Users\...\logs\daemon.log` 是没用的。文件在 daemon 手里，它才能通过同一条连接把内容递过去（`log.tail`，见 §3）。

**stderr 只在有人看的时候写。** stderr 是终端时（有人自己在命令行里跑）照常输出；是管道时（桌面壳、systemd 接着）只写文件，否则同一批行会在同一个目录里存两份。

**第三方 agent 的 stderr 会留下来。** 以前它走 `tracing::debug!`，而默认级别是 `info`——CLI 临死前说的那句话被我们自己丢掉了，用户看到的是「Claude Code stopped unexpectedly.」，这句话对每一种原因都成立、对每一种原因都没用。现在每一行都进日志（`target: "agent"`），最后二十行还会拼进那条失败消息里：退出码 + 它自己的说法。

`$GENEHUB_LOG` 控制级别（默认 `info`），和 `RUST_LOG` 同样的语法。

---

## 4.3 已授权设备

```
<data>/devices.json
```

一行一台设备：id、名字、共享秘密、首次接入时间、最后活跃时间。文件权限 600。**这台机器允许谁远程连进来，这份列表说了算**——不是 relay，也不是任何服务端（[security-model.md](./security-model.md) §4）。

秘密是明文存的，因为它要参与双向证明：daemon 得能算出自己那一半的应答，只存哈希就做不到。它和 `state.json` 里的机器身份是同一个量级的东西，同样是 600。

配对邀请**不落盘**，只在内存里，一次性、15 分钟过期。重启 daemon 等于作废所有还没用掉的邀请，这是对的：邀请是"此刻我在等一台新设备"，不是一份长期配置。

---

## 5. 权限与审批

daemon 不发明自己的审批策略——各 agent 的模式（如只读/写入/放行）已经定义了行为，daemon 做三件事：

1. 把 adapter 抛上来的审批请求排队并推给客户端
2. 把用户的回答投递回 adapter
3. 记审计（谁、何时、批准了什么）

没有客户端在线时：请求挂起并计时，超时按 agent 默认策略处理（当前是拒绝），同时留下审计记录。**不能默默放行。**

计时只在**没有任何客户端订阅这个会话**的时候走。有人正看着审批卡片时不计时——盯着请求思考不是空闲，在人的光标底下把工具调用拒掉，比等着更糟。反过来，所有窗口都关掉时那张卡片不在任何屏幕上，回合、agent 进程、以及那个工具本来要做的事会一直等到 daemon 退出。宽限期 120 秒，结果记成 `PermissionOutcome::TimedOut { appliedDefault }` 而不是伪装成用户的选择——审计要能区分这两者，agent 也要能：它会照着收到的话写下一句,所以超时给它的理由是「没有人在,因此被拒绝」,不是「用户拒绝了」。

**同一种 agent 一次只起一个进程(仅限启动那一段)。** 第三方 CLI 的"第一次运行"做的是整机范围的事:OpenCode 会在用户数据目录里建它自己的 SQLite 并跑建表迁移。两个实例同时做,有一个会输在 `CREATE TABLE workspace` 上直接退出,用户看到的是「OpenCode 还没就绪就退出了」后面挂一段 SQL。同时开两个会话各问一句是很正常的事,能不能用不该取决于谁先摸到 schema。所以 `ensure_started` 里按 agent 种类串行化**启动**:不同 agent 仍然并行起,进程起来之后就完全离开这条路径。门闩挂在进程上而不是挂在 SessionManager 上——它保护的东西不是我们的,是那台机器上属于那个 CLI 的状态。

**一次只跑一个回合。** 会话正在 `Running` 时进来的 `session.send` 被拒(`conflict`)。这条在 daemon 里判,不靠"UI 把发送按钮藏起来"——同一个会话开两个窗口就是两个发送按钮。回合中被塞进第二个提问的 agent 不会干净地失败,它会把两段对话织成一段。

---

## 6. 安全

| 面 | 做法 |
|----|------|
| 本地端口 | 只绑 `127.0.0.1`，带一次性 token；token 存在只有当前用户可读的文件里 |
| 远端接入 | 只走出站 relay 连接；**准入由本机的已授权设备列表判断**（§4.3），逐台可撤销 |
| 工作目录 | 文件与 git 接口限制在已登记的工作区内，拒绝路径穿越 |
| 命令执行 | 以当前用户权限运行，不内建沙箱；隔离由部署形态负责，见 [security-model.md](./security-model.md) |
| 撤销 | Hub 侧撤销后 daemon 进入 revoked 状态并停止重连 |

---

## 7. 与外部服务的关系

daemon 只跟两个外部对象打交道，而且必须当成两件完全不同的事：

- **relay**（一条出站 WebSocket）：对面只按帧头转发，不解释内容。daemon **不能**因为"反正连的是自己人"就在这条连接上发明文控制消息——那等于把 relay 变成一个需要被信任的东西。自建部署里 relay 是唯一的外部对象。
- **控制面**（HTTP，只在托管部署里存在）：设备码配对、登记这台机器、解除登记。daemon 不理解账号，也不需要理解。它更不把准入权交出去：控制面说的话只是一份身份声明，放不放行仍然是 daemon 查自己的列表。

理由与守则见 [architecture.md](./architecture.md) §6 与 [relay.md](./relay.md)。

**第三个对象只在有人点了「检查更新」的那一刻存在。** `update.check` 去取一个固定地址上的 `latest.json`（默认是本仓库 releases 里那个不带版本号的文件名，所以地址不会变），比一比版本号就回来。没有定时器，启动时不查——产物是一句话、发布页地址（`url`）和本平台安装包地址（`downloadUrl`）。

**下载也是 daemon 干的，但仍然只在有人按了之后。** `update.download` 把安装包拉进 `<data>/updates/`，边下边把 `UpdateDownload` 推给每个连着的客户端（`ServerFrame::updateDownload`）。放在 daemon 而不是桌面壳，理由和检查那一半一样：Linux 上根本没有那个壳，而这样一来在手机上按下的下载也能在手机上看着它走完。要下的地址**不从线上来**——请求里没有这个字段，daemon 自己重新查一遍 manifest；一个能指定下载地址的客户端，就是一个能让别人的机器去取互联网上任意文件的客户端。写的时候先写 `.part` 再改名，所以一个下到一半的文件永远不会被当成装得了的安装包；上限一 GiB，免得一份出了岔子的发布把谁的硬盘填满。

**装还是用户点。** 下完之后屏幕右下角出一个小框（`UpdateToast`），「立即安装」由桌面壳执行（`install_update`），而且只肯运行 `<data>/updates/` 里的文件——"去跑这个文件"是唯一一句绝不能照单全收的话。「稍后」只是不再问，文件留着：让人为读了一个提示而重下一百兆是种惩罚。装的时候 daemon 会被停掉，正在跑的会话跟着断（`installer.nsh`），所以什么时候付这个代价是用户的决定。壳按 `/UPDATE /P /R` 拉起安装包——覆盖装、进度条、装完自己开回来，中间没有卸载这一步（[desktop-client.md](./desktop-client.md) §6.4）。

Linux 没有桌面壳，对应入口是 `genet update`。CLI 执行构建时内嵌的、按当前频道盖章的 `install.sh`，由脚本下载 tarball 并强制校验 `SHA256SUMS`；替换完成后脚本从安装目录调用新 `genet daemon restart`，所以成功返回意味着运行中的 daemon 也已经切到新版本。它同样只由人触发，不在后台自动升级。

选文件而不是 GitHub API，是因为 API 按来源地址限 60 次/小时，而一间办公室共用一个出口地址。这个查询要么由人触发，要么不发生，所以它也不需要缓存。

`config.json` 里的 `updateManifestUrl` 是这件事的开关：**留空就彻底不查**（客户端点了会被明确告知这台机器关掉了，而不是收到一句"已是最新"）；自建部署也可以指向自己的文件，不必去看别人的 releases。

---

## 8. 验收标准

1. `cargo test`：协议编解码、timeline 装配、adapter 注册、路径穿越防护
2. 冒烟：以 `genet` adapter 建会话、发一条带工具调用的任务、事件序列完整
3. **双 adapter 验证**：同一段前端代码分别驱动 `genet` 与一个真实 ACP CLI，渲染结果一致——这是 [architecture.md](./architecture.md) §2 B3 的验收动作
4. 重启后能加载既有会话并继续对话
5. 拔网线再插回，客户端事件不丢不重
6. 全新数据目录启动一次，`workspace.list` 就已经有一个存在于磁盘上的工作区
