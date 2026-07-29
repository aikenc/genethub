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
| 会话 | `session.create` / `list` / `get` / `send` / `interrupt` / `close` / `archive` |
| 会话配置 | `session.setModel` / `setMode` / `respondPermission` |
| 工作区 | `workspace.list` / `open` / `create` |
| 文件 | `file.tree` / `read` / `write` / `watch` |
| Git | `git.status` / `git.diff` / `git.commit` |
| 终端 | `pty.open` / `write` / `resize` / `close`（输出走推送） |

**断线重连**：客户端带上最后收到的事件序号，`subscribe` 时 daemon 回补缺口；补不齐（超出保留窗口）就回全量快照并明确告知，不做静默半量。回合进行中掉线也一样：回合不会因为没人看着就停，重连时缺的那段照样补得回来。

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

---

## 5. 权限与审批

daemon 不发明自己的审批策略——各 agent 的模式（如只读/写入/放行）已经定义了行为，daemon 做三件事：

1. 把 adapter 抛上来的审批请求排队并推给客户端
2. 把用户的回答投递回 adapter
3. 记审计（谁、何时、批准了什么）

没有客户端在线时：请求挂起并计时，超时按 agent 默认策略处理，同时留下审计记录。**不能默默放行。**

---

## 6. 安全

| 面 | 做法 |
|----|------|
| 本地端口 | 只绑 `127.0.0.1`，带一次性 token；token 存在只有当前用户可读的文件里 |
| 远端接入 | 只走出站 relay 连接，端到端加密，配对凭证可撤销 |
| 工作目录 | 文件与 git 接口限制在已登记的工作区内，拒绝路径穿越 |
| 命令执行 | 以当前用户权限运行，不内建沙箱；隔离由部署形态负责，见 [security-model.md](./security-model.md) |
| 撤销 | Hub 侧撤销后 daemon 进入 revoked 状态并停止重连 |

---

## 7. 与外部服务的关系

daemon 只跟两个外部对象打交道，而且必须当成两件完全不同的事：

- **控制面**（HTTP）：设备码配对、登记这台机器、解除登记。daemon 不理解账号，也不需要理解。
- **relay**（一条出站 WebSocket）：对面只按帧头转发，不解释内容。daemon **不能**因为"反正连的是自己人"就在这条连接上发明文控制消息——那等于把 relay 变成一个需要被信任的东西。

理由与守则见 [architecture.md](./architecture.md) §6 与 [relay.md](./relay.md)。

---

## 8. 验收标准

1. `cargo test`：协议编解码、timeline 装配、adapter 注册、路径穿越防护
2. 冒烟：以 `genet` adapter 建会话、发一条带工具调用的任务、事件序列完整
3. **双 adapter 验证**：同一段前端代码分别驱动 `genet` 与一个真实 ACP CLI，渲染结果一致——这是 [architecture.md](./architecture.md) §2 B3 的验收动作
4. 重启后能加载既有会话并继续对话
5. 拔网线再插回，客户端事件不丢不重
6. 全新数据目录启动一次，`workspace.list` 就已经有一个存在于磁盘上的工作区
