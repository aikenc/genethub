# GeneHub 架构

> 本文是**本仓最上层的事实来源**。其他文档展开各自领域，冲突时以本文为准。

GeneHub 是一套让你在自己的机器上跑 coding agent、并从任意设备安全访问它的开源软件。本仓包含四个可独立部署的部件与它们之间的协议。

---

## 1. 一句话架构

```
     浏览器 / 桌面 / 手机  ← 同一份工作台前端
              │
              │  protocol-v3 DataEndpoint（本仓 packages/proto 定义）：
              │   ① 同机 127.0.0.1 WebSocket
              │   ② 跨设备 /fabric/v2 E2EE baseline
              │   ③ 网络允许时 WebRTC DataChannel direct
              ▼
        ┌──────────┐         出站 WS        ┌───────────┐
        │  daemon  │ ─── /fabric/v2 ──────► │   relay   │
        │ （你的机器）│                        │ 只搬字节   │
        └────┬─────┘                        └─────┬─────┘
             │  Adapter 层（每种 agent 一个）        │ 四个 Fabric authority 操作
             ├─ genet    自研内置 agent              ▼
             ├─ acp      一份适配覆盖一批 CLI    ┌──────────────┐
             ├─ opencode 本地 HTTP + SSE        │  控制面       │
             └─ …                              │ 本仓之外的服务 │
                                               └──────────────┘
```

你的机器上只有一个常驻进程（daemon），它按需拉起 agent 子进程。所有客户端说同一套协议，**看不见背后是哪种 agent，也看不见走的是哪条通道**。

---

## 2. 四条不可让步的边界

后面所有取舍都从这四条推导。

### B1. Agent 是插件，内核不认识任何具体 agent

daemon 业务代码里不允许出现 `if agent == "genet"`。具体 agent 的知识只能存在于它自己的 adapter 文件里。

### B2. 客户端协议是产品资产，不是某个 agent 的协议

如果 daemon 直接转发某个 agent 的原始事件，等于把它的线格式钉死成产品协议——接第二种 agent 时只能做反向映射，前端还得知道"这条消息来自哪种 agent"。

所以 daemon 内部定义一套与任何 agent 无关的 `TimelineItem` / `SessionEvent`，每个 adapter 负责翻译。前端只认这一套。

### B3. 一个 adapter 的抽象等于没有抽象

只接自研 agent 时写出来的"抽象层"必然是自研 agent 的形状。因此 MVP 就必须跑通**两种形状截然不同**的 agent（stdio JSONL + 本地 HTTP/SSE），抽象才算被证伪过一次。这条决定了排期，不是可以往后挪的锦上添花。

### B4. relay 不理解它搬运的东西

relay 只认 Fabric 帧头与 opaque endpoint/route admission，不 parse E2EE payload，不落库，不做业务鉴权。它有权知道连接元数据和 outer stream 路由，不知道内部 logical stream、method、workspace/path 或内容；这一点写在 [security-model.md](./security-model.md) 里，并由 CI 静态检查守住（§6.4）。

---

## 3. Adapter 层

### 3.1 三段式

```
Registry        ── 有哪些 agent、装没装、有哪些模型和模式
   ↓
Transport       ── 怎么跟它说话（子进程 stdio / JSON-RPC / HTTP）
   ↓
Normalizer      ── 把它的事件翻成 GeneHub 的 TimelineItem
```

### 3.2 Adapter 契约

```rust
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &str;                       // "genet" / "acp:cursor" / "opencode"
    fn capabilities(&self) -> Capabilities;     // 支不支持中断、切模型、审批、恢复

    async fn probe(&self) -> Probe;             // 二进制在不在、能不能握手
    async fn catalog(&self) -> Result<Catalog>; // 模型与模式清单

    async fn start(&self, cfg: SessionConfig) -> Result<Box<dyn AgentSession>>;
    async fn resume(&self, handle: PersistHandle) -> Result<Box<dyn AgentSession>>;
}
```

能力差异用 `Capabilities` 声明，**不用返回 `Unsupported` 错误来试探**：前端要在按钮渲染前就知道这个 agent 能不能切模型，而不是点了才报错。

模型、**思考强度**、**模式**是三条独立的轴，不要混用。思考强度是「想多久」（`ModelInfo.efforts` 里由模型自己报出档位，`session.setEffort` 切换）；模式是「动手前问不问」（`Catalog.modes`，`session.setMode`）。这两件事曾经共用一个 `modeId` 字段——内置 agent 拿它当思考档位，Claude 拿它当工具审批策略——于是同一个控件在不同 agent 下是两个毫不相干的意思，唯一的区分办法是去读另一个能力位。一条轴一件事之后，前端不需要知道是哪个 agent 就能把控件画对。

### 3.3 首批 adapter

| adapter | 传输 | 覆盖 | 阶段 |
|---------|------|------|------|
| `genet` | 子进程 + stdio JSONL | 自研内置 agent，装完即可跑 | MVP |
| `opencode` | 本地 HTTP + SSE | OpenCode | MVP |
| `claude` | 子进程 + 原生 `stream-json` stdio | Claude Code，直接拉起 `claude` 二进制 | MVP |
| `codex` | 子进程 + 原生 `app-server` JSON-RPC | Codex，直接拉起 `codex app-server` | MVP |
| `acp` | 子进程 + ACP over stdio | 一份代码覆盖 Cursor / Gemini / goose 等一批 CLI | MVP |

五个各有各的理由：`genet` 是兜底，`acp` 是**一份适配换一批 agent**，`opencode` 是**形状差异最大的那个**——它不是 stdio 而是本地 HTTP + SSE，`claude` 和 `codex` 是**我们绕开 ACP、直接说其原生协议的两个**。

这两个为什么值得自己写一份：ACP 是一份公开、双方都维护的契约，代价小；原生协议翻译要我们自己跟着对方的版本走。当前 ACP 已有 `session/request_permission` 和标准 `session/resume`，足够覆盖 Cursor 等通用接入；Claude 和 Codex 的原生协议仍提供更完整的模型、思考档位、模式、提问语义与会话恢复能力。`codex` 的 `model/list` 会报出每个模型自己的思考档位，而 `turn/start` 每回合都带 model / effort / 审批策略，所以三个选择器都是真的。两个都曾经挂在额外 ACP 桥接包上，也都因此让只装了官方 CLI 的人被告知「未安装」。详见 [third-party-agents.md](./third-party-agents.md)。

### 3.4 Agent 权限与暂停恢复

GeneHub 面向长期无人值守的机器，默认权限不是“先拦住再等人点”，而是**在操作系统账户允许的范围内尽量放权**。已知 CLI 在启动层和 Agent 自身模式层都选择最高权限；daemon 不再添加工作区写入沙箱。用户显式选择只读或 plan 时才降低权限。

仍然出现的权限请求与真正的 Agent 问题都被建模成一个持久化的“暂停点”，但二者类型分开：批准权限时用 Agent 的最高默认模式恢复，回答问题时保持原模式。daemon 在写入 session meta 后结束当前回合并关闭 Agent 子进程；不保留等待中的 RPC、进程、WebSocket 或浏览器连接。稍后响应时，通过原生 session handle 恢复并开启新的继续回合。状态只有 `running → waiting → running/idle`，重启 daemon 也不丢请求。

这里的“全盘可写”不等于提权：子进程继承 daemon 登录用户的 OS 权限，GeneHub 不绕过 ACL、UAC、macOS 隐私授权、只读文件系统或设备管理策略。

**外部 agent 一律不随包分发**，只检测用户自己安装的。除了体积与授权，还有一条更硬的理由：有些 agent 自带 Node 或其他运行时，打包它们等于把它们的运行时依赖变成我们的，而 PC 端零 Node 运行时是硬约束（[desktop-client.md](./desktop-client.md) §4.1）。

用户自定义 agent 走配置声明，不需要改代码：

```jsonc
{ "agents": { "goose": { "extends": "acp", "command": ["goose", "acp"] } } }
```

---

## 4. 归一化事件模型

前端和存储只认这一套，它是 daemon 对外契约的核心，定义在 `packages/proto`。

```rust
enum TimelineItem {
    UserMessage { text, attachments },
    AssistantMessage { text },
    Reasoning { text },              // thinking / reasoning 统一为这个
    ToolCall { id, name, status, detail: ToolCallDetail },
    Todo { items },
    Compaction { reason },
    Error { message },
    TurnSummary { stats },           // 时间、耗时、token、工具数与可选 fork checkpoint
}

enum ToolCallDetail {                // 决定前端用哪个渲染器
    Overview { tool_kind, overview, input, output }, // session 边界后唯一保留的形状
    Shell { command, output, exit_code },
    Read  { path, content, truncated },
    Edit  { path, diff },
    Write { path, content },
    Search{ query, matches },
    Fetch { url, summary },
    Plan  { markdown },
    SubAgent { agent, prompt, items },
    Unknown { raw },                 // 兜底：永远不允许丢事件
}
```

四条规则：

1. **`Unknown` 是必需品**。新 agent 冒出没见过的工具时必须仍能展示，不能白屏，也不能丢事件。
2. **工具名归一化在 adapter 内做**，各家自己维护映射表。不要做一张全局大表，那会变成所有 adapter 的耦合点。
3. **增量与全量都要有**。`ItemDelta` 给流式打字机效果，`Item` 给最终态；断线重连只回放 `Item`。
4. **session 只保留 overview**。adapter 可以在边界内产出详细形状，但进入 session 内存、磁盘和客户端
   前一律变成 `Overview`。有 Agent overview 时先截到 48 字符，再追加 input 补足为最多 64 字符；没有时
   直接拿 input 作最多 64 字符的标题。input 被压成一行、最多 64 字符；output 只留前两行和后两行，
   每行最多 64 字符。思考过程仍最多 24 字符，没有 Plan 或 Unknown 例外。`tool_kind` 是跨 Agent 的
   语义类别，只用来选择稳定的活动图标，不依赖各平台不同的工具名。
5. **turn 结束时形成持久统计**。`TurnSummary` 保存完成时间、耗时、四类 token、工具调用数和结果；
   Agent 若提供原生 checkpoint 才附带它并开放真实 fork，绝不拿已经裁剪的时间线伪造可继续的分支。

---

## 5. 部件职责

| 部件 | 归它 | 不归它 |
|------|------|--------|
| **daemon**（Rust，本仓） | 会话生命周期、持久化、断线重放；adapter 注册与启停；文件 / git / PTY；出站长连接 | 跟模型说话、执行工具（agent 的事）；身份与授权（控制面的事） |
| **agent**（Rust，本仓） | 与模型对话、跑工具、技能装载 | 会话持久化、对外协议 |
| **relay**（Node，本仓） | 两端之间搬字节；在线表；背压与限额 | 看 payload、存任何东西、决定谁能连 |
| **workbench**（前端，本仓） | 会话、项目、文件、终端、**自己的设备管理** | 账号体系本身 |
| **控制面**（本仓之外，只在托管部署里） | 账号、机器目录、Fabric endpoint/route/peer capability 准入、presence/revocation | 解析或转发业务 payload |

**谁能连你的机器，由 daemon 自己判断。** 它本地有一份已授权设备列表，撤销即时生效。自建部署因此完全不需要控制面：relay + 静态工作台两个东西就够（[self-hosting.md](./self-hosting.md)）。

细节见 [daemon.md](./daemon.md)、[relay.md](./relay.md)、[web-workbench.md](./web-workbench.md)。

---

## 6. relay 与控制面的边界

### 6.1 为什么需要 relay

你的机器在 NAT 后面，没有稳定公网入口。WebRTC 也需要 signaling，而且在严格 NAT、企业网络或 UDP 被禁时会失败。因此跨设备始终先建立 WSS Fabric baseline；网络允许时再升级为 RTC direct。

### 6.2 Relay 只做 opaque admission，不做业务鉴权

Relay 必须防止任何人无限占用 endpoint/route，所以会向 authority 核验短期 opaque ticket；但**最终 peer 身份与 workspace/path 权限在 daemon 完成**。Relay 不持有 peer secret，也不解释 protocol-v3 record。

两种部署使用同一个 FabricCore，只替换 authority：

| 形态 | relay | 客户端凭什么被放行 |
|------|-------|------------------|
| 自建 | rendezvous authority 按稳定 slot 路由，无数据库 | 配对时取得的 device/invite secret，daemon 查本地设备表 |
| 托管 | Control 核验 endpoint/route ticket，维护 presence/revocation | Control 发行短期 peer secret，daemon 兑换后完成双向 proof，并继承 route workspace scope |

坏的 Relay 单独只能观察元数据、延迟、丢弃或重放密文；严格方向 sequence 与 AES-GCM tag 会拒绝重放和篡改。托管 Control 生成 peer secret，因此它仍在信任边界中，平台不是零知识（[security-model.md](./security-model.md) §1.1）。

### 6.3 契约：Relay 只能问 Fabric 的四件事

```ts
interface FabricAuthority {
  authorizeEndpoint(credential): Promise<FabricEndpointGrant | null>
  authorizeRoute(sourceEndpointHandle, routeTicket): Promise<FabricRouteGrant | null>
  reportEndpointPresence(endpointHandle, generation, state): Promise<void>
  onFabricRevoked(handler): void
}
```

线上 wire 定义在 `apps/relay/src/contract/fabric-wire.ts`，并在 Cloud 仓镜像。所有字段都是 opaque handle、expiry、lease 和 generation，没有 account、machine、workspace 或业务 method。撤销走 Relay 主动订阅的 SSE 流；失去初始同步或中途断开时 Relay fail-closed。

自建 `RendezvousFabricAuthority` 在内存里实现同一接口，ticket 是 join token/slot；转发状态机不分 hosted/self-hosted。

### 6.4 怎么保证 relay 保持无知

不验证的架构约束等于没有。三条进 CI（`apps/relay/test/boundaries.test.ts`）：

| 检查 | 防的是什么 |
|------|-----------|
| `forward/` 只准 import `contract/` 与 `shared/` | 依赖方向一旦反过来就再也拆不开 |
| 数据路径上不许出现 `JSON.parse` / `JSON.stringify` | 它一旦开始理解流量，"看不到内容"就不再成立 |
| `package.json` 里不许有任何数据库依赖 | 存东西的 relay 就是需要被信任的 relay |

### 6.5 加密的现状，说实话

**当前实现：** 每个 routed peer carrier 先做 protocol-v3 PSK 双向 HMAC proof，再派生本次 peer-link AES-256-GCM key。每个 record 绑定 version、credential context、方向和严格 sequence；AES-GCM 同时提供加密与认证，HMAC 只用于 handshake/key derivation。Relay 能看到 IP、连接时序、长度、outer stream 和初始有界 `PeerHello`，但拿不到 secret，不能读取或伪造 Exchange 内容。

**这仍不等于“整个平台零知识”。** 托管 Control 生成 peer secret，分别返回给浏览器并供 daemon 兑换，因此平台运营方技术上知道该 secret；托管前端也处在浏览器凭证的信任路径里。当前协议是对称 PSK，没有公钥握手与前向保密。

所以可以说“Relay 单独不具备业务内容密钥、数据面不解析也不落库”，不能扩大成“Hub/平台技术上无法查看或控制”。

### 6.6 baseline 与 direct

桌面壳内的 WebView 直连同一台机器的 `127.0.0.1`。跨设备先走 `/fabric/v2` baseline，再通过加密的 `rtc.negotiate` Exchange 协商 ordered reliable DataChannel。RTC connected 后新 logical streams 优先 direct；RTC 失败或关闭时 baseline 继续承载同一 v3 协议。没有 TURN、live migration 或自动重放。

完整数据面见 [e2ee-data-plane.md](./e2ee-data-plane.md)，Relay 实现边界见 [relay.md](./relay.md)。

---

## 7. 前端：一份代码，四个宿主

| 宿主 | 怎么来的 | 连哪里 |
|------|---------|--------|
| 浏览器 | 直接访问 | relay 票据 |
| 桌面（Tauri） | 系统 WebView 加载同一份产物 | 本机 daemon |
| 手机（Tauri Mobile） | 同上 | relay |
| 自建部署 | 静态文件 | 同浏览器 |

宿主差异收敛在 `packages/web/src/host/` 一个模块里，业务组件不允许出现 `if (isTauri)`。范围与移动端约束见 [web-workbench.md](./web-workbench.md)。

**本仓前端的范围是：会话、项目、文件、终端、以及你自己的设备管理。** 账号体系的界面不在本仓——它属于运营控制面的人，跟"用哪个 agent 干活"是两件事。

---

## 8. 仓库结构

```
apps/daemon      ← Rust：会话内核 + adapter 层 + 本地 WS + 出站长连接
apps/agent       ← Rust：内置 Genet Agent（众多 adapter 中的一个后端）
apps/relay       ← Node：转发层。无数据库、无业务、可自建
apps/desktop     ← 仅 Windows/macOS 的 Tauri 2 壳；复用 Web 工作台
packages/web     ← 工作台前端（四个宿主同一份产物）
packages/proto   ← 会话协议的唯一定义处，生成 TS 类型与 Rust 结构
skills/          ← 教 Agent 怎么用 genet CLI 的 Agent Skills
testing/         ← 跨部件旅程测试（daemon + agent + mock 模型）
```

`packages/proto` 单独成包是刻意的：协议只能有一处定义，否则前后端各写一遍，第三次改字段时必然对不上。

---

## 9. 演进顺序与理由

| 顺序 | 做什么 | 为什么是这个顺序 |
|------|--------|------------------|
| 1 | 定协议（`packages/proto`） | 前后端可并行，且改字段的成本此时最低 |
| 2 | daemon 内核 + `genet` adapter | 有了可跑通的最短闭环 |
| 3 | 工作台骨架 | 能看见，才谈得上验收 |
| 4 | `acp` 与 `opencode` adapter | 用另外两种形状证伪抽象；此时改抽象还便宜 |
| 5 | relay + 配对 + 桌面打包 | 从"能跑"到"能装能接力" |
| 6 | 全链路集成测试 → 真实模型 E2E | 见 [testing.md](./testing.md) |

第 4 步刻意排在打包之前：抽象错了要在只有两个调用方时发现，等三端都装上了再改就是全链路返工。

---

## 10. 与参考实现的关系

我们调研过若干开源实现，借鉴的是**公开的接口约定**：[ACP](https://agentclientprotocol.com/)、[Agent Skills 标准](https://agentskills.io/specification)，以及各家 CLI 自己文档化的 stdio / HTTP 协议。这些本来就是发布出来给第三方对接的。

GeneHub 的协议、daemon、前端与内置 agent 均为自有实现：不 fork、不 import、不复制代码。接入某个 agent 时我们实现的是**它对外公开的对接接口**，与任何第三方写客户端的做法无异。
