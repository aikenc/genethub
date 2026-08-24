# GeneHub Daemon 规格

> 用户 PC 上唯一的常驻业务服务。Rust 业务代码编进 `genehub_guest.wasm`，由原生 `genehub-host` 常驻装载；随桌面端或 Linux 三件套分发。
> 上位文档：[architecture.md](./architecture.md)。本文只展开 daemon 内部。
> 状态（2026-08-24）：默认 WASM、Fabric/RTC 与 Linux 能力 parity 已落地；Windows host 的 owner-only ACL 已实现，并在 GitHub `windows-latest` 上跑过 `fs_perms::tests`。尚未用待发布三件套关闭 Windows 安装后首启与主旅程。组件自动更新、签名与无损切换也尚未落地，见 [roadmap.md](./roadmap.md)“WASM 持续交付”。

---

## 1. 设计原则

| 原则 | 含义 |
|------|------|
| **按 MVP 裁剪** | 成熟实现有几十个模块；我们只做闭环需要的那几个，不做"以后可能有用"的 |
| **内核不认识具体 agent** | 具体知识全部关在 adapter 里，见 [architecture.md](./architecture.md) §2 |
| **无状态优先** | 除会话记录外不缓存；重启后靠磁盘恢复，不靠内存 |
| **单服务实例** | daemon 是一个 host + guest 实例，不拆微服务、不引数据库服务；agent/外部工具仍按需独立进程，SQLite 或 JSONL 落盘 |
| **只有 WASM 业务运行时** | 产品全面切换到 `genehub_guest.wasm`。没有原生 daemon/agent 模式，缺件或不匹配即失败，禁止任何回退 |
| **启动 ABI 配对** | host 与 guest 都嵌入 `sha256(wit/genehub-host.wit)`；装载、instantiate 之前比对，不一致则拒绝启动并要求成对重建 |
| **崩溃可自动回收** | 无锁时清掉残留 `endpoint.json`，并删除旧版遗留的整个 `wasm-cache`；guest trap 不二次拖死 Store，进程退出后由 supervisor 只重启 daemon |
| **编译只在内存** | host 用 `from_binary` 在本进程编译 guest；不写 `.cwasm`。内置 agent 是另一个 host 进程，同样从 wasm 字节编译，不读磁盘预编译像 |

体积门以真实 installer/tarball 为准：下载 ≤80MB。2026-08-22 本槽位分项是 launcher 2.35MB、host 11.17MB、guest 6.83MB；不能再用旧“单 daemon 二进制”口径验收。

---

## 2. 模块划分

```
apps/daemon/src/
├── lib.rs / run.rs   guest 常驻入口、启动与 reload/shutdown outcome
├── config.rs         guest 读的 `Config`；磁盘布局与权限加固来自 `packages/frontdoor`
│                     （原生前门要创建并检查同一批文件，见 cli-thin-forwarder.md §6）
├── transport/
│   ├── local.rs      本地 HTTP + WebSocket（127.0.0.1，回环）
│   ├── fabric.rs     endpoint-neutral /fabric/v2 出站 uplink
│   ├── ws.rs         WebSocket 客户端；原生直连，guest 经 wasi:sockets + wasi:tls
│   └── admission.rs  loopback/device/hosted/RTC peer admission
├── dataplane/
│   ├── handshake.rs  protocol-v3 PSK 双向证明
│   ├── frame.rs      16 KiB record 内的 logical-stream frame
│   ├── endpoint.rs   Exchange、流控、公平 writer、handler 隔离
│   ├── preview.rs    ≤64 MiB workspace 文件 Preview
│   ├── rtc.rs        共享 signaling/policy 常量
│   ├── rtc_guest.rs  guest admission、名额、超时与 Fabric 回落
│   ├── rtc_host.rs   原生构建的连接实现（guest 构建改走 typed host resource）
│   └── client.rs     daemon/CLI 使用的 v3 client endpoint
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
├── files.rs          目录树、精确 Preview 读取、写入
├── git.rs            status / diff / commit（调 git 命令，不引 libgit2）
├── pty.rs            终端会话
├── updates.rs        有没有更新的版本（有人问才查，见 §7）
└── devices.rs        设备配对、凭证与即时撤销
```

MVP **不做**：定时任务、浏览器自动化、语音、worktree 编排、MCP 注入、插件系统、会话 fork/rewind。

---

## 3. 客户端协议

### 3.1 传输

| carrier | 用途 |
|---|---|
| `ws://127.0.0.1:<port>/ws` | 同机 client；loopback 一次性 admission |
| daemon 出站 `wss://<relay>/fabric/v2` | 所有跨设备连接的 E2EE baseline；一条 uplink 接收多条 routed peer carrier |
| ordered reliable WebRTC DataChannel | 远端 peer 的可选 direct carrier；通过 baseline 内的 E2EE Exchange 协商。默认 WASM 下 host typed resource 提供 ICE/DTLS/SCTP 连接，guest 保留 admission、权限、超时与 baseline 回落，见 [wasm-guest-network.md](./wasm-guest-network.md) |

三个 carrier 都承载同一套 protocol-v3 E2EE record、`DataEndpoint` 和 Exchange。daemon 永远不在公网或局域网监听特权协议；旧 `lanEnabled: true` 会明确失败。同 Wi-Fi 也先走 WSS Fabric，RTC 成功后新请求才 direct；只有 literal loopback 可使用明文 WS。

### 3.2 消息形状

peer carrier 先用配对 PSK、hosted peer secret、loopback proof 或 RTC 临时 secret 完成 `PeerHello/PeerWelcome` 双向证明。之后每个 carrier message 是最多 16 KiB 的 AES-256-GCM record；record 内是一条业务无关 logical-stream frame。

```text
OPEN  RequestHead { version, method, metadata, bodyLength?, timeoutMs? }
DATA* request bytes
FIN

HEAD  ResponseHead { status, metadata, bodyLength?, error? }
DATA* response bytes
FIN
```

每个客户端主动请求各占一条 logical stream。stream 有独立 sequence、256 KiB credit、receive queue、task、timeout、FIN/RESET 和精确 body-length 校验。writer 以 round-robin 每个 runnable stream 每轮一帧，因此 Preview 或慢 RPC 不会独占应用层发送链。

carrier reader 只验证/decrypt 一条 record、decode 一条 frame 并投递到有界队列，不 await 文件 IO、Agent 或 handler。每个 incoming stream 在独立 task 中处理；原生构建的阻塞 Preview 读取使用有界槽，WASM guest 则分块并 cooperative yield，不能调用 `spawn_blocking`。单 peer 最多 256 active streams；daemon RTC registry 最多 32 peers。

完整 framing、Relay 可见性和 RTC 取舍见 [e2ee-data-plane.md](./e2ee-data-plane.md)。

### 3.3 MVP 方法集

DataEndpoint method 只有四个：

| Exchange method | 用途 |
|---|---|
| `rpc` | 现有版本化 `Request/Reply` 业务 schema，作为 body；不再是 connection envelope |
| `events` | 长期 response stream；`u32be length + ServerFrame JSON` |
| `asset.preview` | workspace-relative、完整或失败、≤64 MiB 的文件 Preview |
| `shell.run` | 在 workspace 内跑一条命令；metadata 带 argv 数组、cwd、env 与可选 `timeoutMs`，**request body 即命令的 stdin**（≤1 MiB，一次给全；需要一问一答的交互输入用 `pty.open`）。response 是 `u32be length + ShellFrame JSON`，stdout/stderr 分开、末帧带退出码与 `timedOut`。与 `pty.*` 同属 `pty` 能力，隔离决策也共用一处 |
| `rtc.negotiate` | 在已认证基线连接内交换非 trickle SDP |

`rpc` body 的 MVP 方法集：

| 域 | 方法 |
|----|------|
| 连接/订阅 | `connection.identity`、`subscribe` / `unsubscribe` |
| Agent | `agent.list`（含 probe 状态与 catalog）、`agent.refresh` |
| 会话 | `session.create` / `list` / `get` / `send` / `interrupt` / `close` / `archive` / `rename` / `delete` |
| 会话配置 | `session.setModel` / `setMode` / `respondPermission` |
| 设备 | `device.list` / `invite` / `claim` / `revoke` / `remoteAttach` / `remoteDetach` |
| 控制面 | `hub.status` / `pair` / `trial` / `claimLink` / `unpair`（可选，见 [desktop-client.md](./desktop-client.md) §8） |
| 工作区 | `workspace.list` / `open` / `create` |
| 文件 | `file.tree` / `file.write` / `file.mkdir` / `file.copy` / `file.move` / `file.delete`；用户可见读取只走 `asset.preview`，没有 `file.read` |
| 目录选择 | `directory.list`（`path: ""` 为机器根/盘符）/ `directory.mkdir`（选夹时新建） |
| Git | `git.status` / `git.diff` / `git.commit` |
| 终端 | `pty.open` / `write` / `resize` / `close`（输出走推送） |
| 后台进程 | `process.list` / `process.kill` / `process.killAll`；回合结束时 daemon 主动推 `BackgroundProcesses`（见 §5.1） |
| 更新 | `update.check` / `update.download` / `update.downloadState` / `update.dismiss`（见 §7） |

**断线重连**：客户端带上最后收到的事件序号，`subscribe` 时 daemon 回补缺口；补不齐（超出保留窗口）就回全量快照并明确告知，不做静默半量。回合进行中掉线也一样：回合不会因为没人看着就停，重连时缺的那段照样补得回来。

**没断线但落后了**也是同一件事:某个连接跟不上广播、事件被丢掉时,daemon 发 `desync{sessionId, missed}`。这是给客户端看的,不是给人看的——时间线上的一个洞不需要用一句话道歉,它需要被补上,而补的办法就是重连时那一个 `subscribe`。客户端收到就自己去补,不打扰用户。（早先这里发的是一句英文提示让人"重连一下":不重连的人留着一个永远不动的半截回答,重连的人以为出了故障。）

### 3.4 WebSocket 之外的两个 HTTP 端点

| 端点 | 用途 |
|------|------|
| `GET /health?challenge=…` | 返回 pid、machine id、fingerprint 与 bearer 绑定的 HMAC；challenge 必填且受长度/字符限制。外壳/CLI 必须校验 proof，不能把旧端口上任意 200 服务当 daemon |
| `POST /shutdown` | 请求它自己收干净退出。只接受 loopback，并校验与 health 分域的 challenge-HMAC；请求不发送长期 bearer |

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

已登记项目与 device-local root mapping 都存在 `<data>/config.json`。直接打开 folder 与打开 `.code-workspace` 是不同项目来源，因此使用不同、可恢复的项目 id；同一 canonical directory 则复用一个项目无关的随机 `rootHandle`。项目只声明 root 成员关系，folder label 只负责显示，文件路径统一为 `<rootHandle>/<relative-path>`。第一个目录仍是 Agent、会话、终端和 Git 的根。

多个项目可以共享第一个物理目录；写入锁按 session 而不是 `.genethub/` 或 workspace 划分，所以不同 channel 能在同一目录并行写不同会话。会话 meta 不持久化本机随机 workspace id，而是保存同一 session home 内稳定的 project key；folder key 可被另一安装直接采用，workspace 文件 key 由其 canonical source 派生，因此两种项目视图不会互相冒充会话。

`workspace.remove` 只把登记项标成隐藏并从当前会话存储索引卸载，绝不删除项目文件或 `.genethub/`。重新打开同一 folder source 或同一 `.code-workspace` source 会复用各自原 id，会话随即重新可见。运行中或等待交互的会话必须先结束，避免移除动作截断正在写入的历史。旧配置在启动时一次性补齐全局 rootHandle；运行时没有 folder-prefix fallback。

**新机器一定有一个可用的工作区。** 从没用过的机器上，daemon 启动时会在用户 home 下建一个 `GeneHub/` 并登记为工作区。没有这一步，新装用户能做的第一件事就是被拒绝：没有工作区就没有会话，于是第一屏是一个文件选择器，挡在他还没见过的产品前面。

三条约束，都不是随便定的：

| 约束 | 为什么 |
|------|--------|
| 放在 home，不放在 `<data>` 下 | `<data>` 是「卸载即整个删掉」的那个目录（见 [testing.md](./testing.md) §7 的自检项），而这里面装的是用户自己的文件，不是我们能删的东西 |
| 只在注册表从未有过工作区时创建 | 打开过或主动移除过项目的人，永远不会看见它凭空冒出来 |
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

会话并发与删除使用稳定的结构化 `event` 字段记录：包括 session writer/旧版 workspace writer 竞争、Fork 降级重建、逻辑墓碑、延迟物理清理和清理成功。字段只带会话与工作区的内部 id、持有者和失败阶段，不记录对话正文或完整工作区路径，反馈系统可以据此检索而不依赖自然语言。

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

daemon 不发明一套目录权限系统。已知 Agent 默认以最高模式启动，CLI 启动参数也尽量关闭它自己的审批与沙箱；用户显式选择只读或 plan 时才采用较低模式。这里的最高权限仍是 daemon 登录用户的操作系统权限，不是提权。

极少数仍出现的权限请求，以及必须由用户回答的 Agent 问题，统一成为**持久化暂停点**：

1. adapter 抛出请求后，daemon 先保存请求与 Agent 的原生 session handle。
2. 当前回合记为取消并落盘，随后关闭 Agent 进程；没有待决 RPC、stdio、WebSocket 或浏览器连接。
3. session 保持 `Waiting`。daemon 重启后从 meta 恢复同一张请求卡片，不计时、不超时替用户决定。
4. 用户批准权限时，以该 Agent 的最高默认模式恢复原生 session 并开始一个继续回合；回答普通问题时保持原模式。拒绝或取消则清除暂停点且不重启 Agent。

恢复使用原生会话能力：Claude session id、Codex thread id、OpenCode session id，ACP 则优先使用标准 `session/resume`，只对明确声明旧能力的 Agent 回退到 `session/load`。这样等待时间可以是几天，状态复杂度仍与一次普通的磁盘恢复相同。

**这里的"继续回合"是同一个 round，不是新的一个。** daemon 内核维护一份 `ActiveRound`（`session/manager.rs` 的 `Live::active_round`）：一个用户请求从被接受到不再需要 agent 继续为止都是同一个 round，哪怕它跨了两个 adapter turn。批准或回答问题触发的续做由 daemon 自己判定、自动缝合；用户按下停止后再打一条新消息则不能——daemon 分不清那是"接着做"还是新请求，所以 `session.send` 带一个可选的 `continuesRound`，界面上的"继续"按钮带上它，普通新消息不带。没有这个信号，或者它指向的 round 已经结束，daemon 一律当作新 round，并把之前挂着的那个结算为 `Superseded`——宁可多切一个 round，也不把两个不相干的请求错误地缝在一起。详见 `docs/agent-analysis-substrate-proposal.md` §3.2。

**同一种 agent 一次只起一个进程(仅限启动那一段)。** 第三方 CLI 的"第一次运行"做的是整机范围的事:OpenCode 会在用户数据目录里建它自己的 SQLite 并跑建表迁移。两个实例同时做,有一个会输在 `CREATE TABLE workspace` 上直接退出,用户看到的是「OpenCode 还没就绪就退出了」后面挂一段 SQL。同时开两个会话各问一句是很正常的事,能不能用不该取决于谁先摸到 schema。所以 `ensure_started` 里按 agent 种类串行化**启动**:不同 agent 仍然并行起,进程起来之后就完全离开这条路径。门闩挂在进程上而不是挂在 SessionManager 上——它保护的东西不是我们的,是那台机器上属于那个 CLI 的状态。

**一次只跑一个回合。** 会话正在 `Running` 时进来的 `session.send` 被拒(`conflict`)。这条在 daemon 里判,不靠"UI 把发送按钮藏起来"——同一个会话开两个窗口就是两个发送按钮。回合中被塞进第二个提问的 agent 不会干净地失败,它会把两段对话织成一段。

### 5.1 后台进程

Agent 就是跑命令的东西,一个回合下来往往起过几十条。有些不会自己结束:`npm run dev`、`cargo watch`、为了 curl 一次而起的测试服务。没有人决定过这些该继续跑,只是回合结束时它们恰好还在,而在一台长期开着的机器上,它们会一直占着端口直到有人发现。

**让人看见就是这个功能的全部。** daemon 不自作主张停任何东西,它回答的是"还有什么在跑、是哪个会话起的",然后由人决定。顺序是刻意的:允许进程活过它那个回合,只有在能看见、能结束它之后才值得拥有。

**归属靠操作系统推断,不在启动时记账**——命令不是我们跑的,是 agent CLI 在它自己的进程里跑的。两条规则互相补位:

- 仍在 agent 的**进程组**里(agent 由 `adapter::owned_child` 起在自己的组里,子进程继承)。这条能抓到父进程已死、被 init 收养的进程。
- 仍是 agent 的**后代**。这条能抓到自己 `setsid` 出去的进程,而那正是一个规矩的命令执行器会对它的子进程做的事。

两条都逃掉的进程已经脱离了两次,那是 POSIX 范围内能表达的最清楚的"我打算活过起我的人"。

**只在 agent 还在时认领。** pid 是会被操作系统重新发出去的小整数;一小时前退出的 agent,它的号可能已经归了别人的编辑器。所以注册表记下观察时刻,认领前先核对 agent 本人还在、且运行时长对得上冒名者对不上。代价是 agent 崩溃后它的遗留物一并失去可见性;反过来的代价是把陌生进程列进别人的会话并提供一个结束按钮,那不是个可以权衡的选项。

**会话结束时先收尾再关 agent。** 关掉 agent 会带走它进程组里的东西,但带不走那些 `setsid` 出去的——而那些恰恰是活得最久的。顺序不能反:agent 一死,后代就被 init 收养,再也认不出是谁的了。

**结束进程是先问后杀**:`SIGTERM` → 2 秒宽限 → `SIGKILL`。被直接硬杀的服务永远跑不到自己的清理代码,socket 文件不删、写到一半的文件停在一半。守规矩的进程毫秒级退出,不付这 2 秒。只有断连这一条路径仍然直接硬杀——那时已经没有人在等这次清理了。

---

## 6. 安全

| 面 | 做法 |
|----|------|
| 本地端口 | 只绑 `127.0.0.1`；长期密钥只在当前用户可读的 `endpoint.json`，客户端拿到的是绑定 pid/机器身份、15 秒有效且单次核销的 HMAC 准入 URL |
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

发布流程仍生成 `latest*.json` 与 `SHA256SUMS`，但它们只用于人工发现版本和检测下载损坏。清单、二进制与摘要来自同一个发布权限边界；发布主机或流水线若被攻破，攻击者可以一起替换三者，所以这不是独立签名根。

在引入可独立固定、公钥可审计的签名机制前，daemon 的 `update.check` 和 `update.download` 都以 `unsupported` 失败关闭；`update.status` 不返回 `downloadUrl`。旧版本留下的下载状态可以查看或清除，但不会形成新的可执行入口。用户应从固定的官方发布页手动下载，并通过独立可信渠道核对 `SHA256SUMS`。

Linux 的 `genet update` 同样失败关闭。`scripts/install.sh` 只保留为用户明确执行的首次安装入口，下载基址和所有重定向均被限制为 HTTPS，并强制校验 `SHA256SUMS`；它不能被解释成安全的自动升级器。

---

## 8. 验收标准

1. `cargo test`：协议编解码、timeline 装配、adapter 注册、路径穿越防护
2. 冒烟：以 `genet` adapter 建会话、发一条带工具调用的任务、事件序列完整
3. **双 adapter 验证**：同一段前端代码分别驱动 `genet` 与一个真实 ACP CLI，渲染结果一致——这是 [architecture.md](./architecture.md) §2 B3 的验收动作
4. 重启后能加载既有会话并继续对话
5. 拔网线再插回，客户端事件不丢不重
6. 全新数据目录启动一次，`workspace.list` 就已经有一个存在于磁盘上的工作区
