# GeneHub 架构

> 本文是**本仓最上层的事实来源**。其他文档展开各自领域，冲突时以本文为准。

GeneHub 是一套让你在自己的机器上跑 coding agent、并从任意设备安全访问它的开源软件。本仓包含四个可独立部署的部件与它们之间的协议。

---

## 1. 一句话架构

```
     浏览器 / 桌面 / 手机  ← 同一份工作台前端
              │
              │  统一会话协议（本仓 packages/proto 定义），三条路同一套消息：
              │   ① 127.0.0.1     桌面/手机壳内直连，最常见
              │   ② 局域网直连     同一个 Wi-Fi
              │   ③ 经 relay 转发  人在外面时
              ▼
        ┌──────────┐         出站 WS        ┌───────────┐
        │  daemon  │ ─────────────────────► │   relay   │
        │ （你的机器）│                        │ 只搬字节   │
        └────┬─────┘                        └─────┬─────┘
             │  Adapter 层（每种 agent 一个）        │ 三个问题（HTTP 契约）
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

relay 只认帧头里的路由信息，不 parse payload，不落库，不做鉴权决策。它有权知道的只有"谁连了谁"，这一点写在 [security-model.md](./security-model.md) 里，并由 CI 里的静态检查守住（§6.4）。

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
| `acp` | 子进程 + ACP over stdio | 一份代码覆盖 Codex / Cursor / Gemini / goose 等一批 CLI | MVP |

MVP 四个各有各的理由：`genet` 是兜底，`acp` 是**一份适配换一批 agent**，`opencode` 是**形状差异最大的那个**——它不是 stdio 而是本地 HTTP + SSE，`claude` 是**唯一一个我们绕开 ACP、直接说其原生协议的第三方 agent**。

`codex`（拉起 `codex-acp`）是 `acp` adapter 的默认注册实例，不是单独的传输实现：这个 CLI 的维护方已经发布了 ACP wrapper，直接复用比照搬它自己的原生 `app-server` JSON-RPC 协议风险更低——原生协议翻译要我们自己跟着它的版本走，ACP 是一份公开、双方都维护的契约。`claude` 最初也是这么接的，后来换成了原生 `stream-json`：ACP 没有把 Claude Code 的逐工具权限控制（每次工具调用先问一遍，而不是要么全放行要么全不放行）暴露给客户端，这条能力只有直连它自己的协议才拿得到，`codex` 的原生 `app-server` 适配器计划在下一版本补上同样的能力（[roadmap.md](./roadmap.md)）。详见 [third-party-agents.md](./third-party-agents.md)。

**外部 agent 一律不随包分发**，只检测用户自己安装的。除了体积与授权，还有一条更硬的理由：有些 agent 自带 Node 或其他运行时，打包它们等于把它们的运行时依赖变成我们的，而 PC 端零 Node 运行时是硬约束（[desktop-client.md](./desktop-client.md) §4.1）。

用户自定义 agent 走配置声明，不需要改代码，`codex` 出厂默认注册也只是同一机制的一个固定实例：

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
}

enum ToolCallDetail {                // 决定前端用哪个渲染器
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

三条规则：

1. **`Unknown` 是必需品**。新 agent 冒出没见过的工具时必须仍能展示，不能白屏，也不能丢事件。
2. **工具名归一化在 adapter 内做**，各家自己维护映射表。不要做一张全局大表，那会变成所有 adapter 的耦合点。
3. **增量与全量都要有**。`ItemDelta` 给流式打字机效果，`Item` 给最终态；断线重连只回放 `Item`。

---

## 5. 部件职责

| 部件 | 归它 | 不归它 |
|------|------|--------|
| **daemon**（Rust，本仓） | 会话生命周期、持久化、断线重放；adapter 注册与启停；文件 / git / PTY；出站长连接 | 跟模型说话、执行工具（agent 的事）；身份与授权（控制面的事） |
| **agent**（Rust，本仓） | 与模型对话、跑工具、技能装载 | 会话持久化、对外协议 |
| **relay**（Node，本仓） | 两端之间搬字节；在线表；背压与限额 | 看 payload、存任何东西、决定谁能连 |
| **workbench**（前端，本仓） | 会话、项目、文件、终端、**自己的设备管理** | 账号体系本身 |
| **控制面**（本仓之外，只在托管部署里） | 身份 | 准入决策、出现在本仓代码里 |

**谁能连你的机器，由 daemon 自己判断。** 它本地有一份已授权设备列表，撤销即时生效。自建部署因此完全不需要控制面：relay + 静态工作台两个东西就够（[self-hosting.md](./self-hosting.md)）。

细节见 [daemon.md](./daemon.md)、[relay.md](./relay.md)、[web-workbench.md](./web-workbench.md)。

---

## 6. relay 与控制面的边界

### 6.1 为什么需要 relay

你的机器在 NAT 后面，没有公网入口。要让手机或另一台浏览器访问它，必须有一个双方都能连到的汇合点。这是硬需求。

### 6.2 relay 为什么不做鉴权

**准入是 daemon 的事**：只有你的机器知道它授权过哪些设备，也只有它能让撤销立刻生效。relay 不参与这个判断，所以它可以由任何人部署（[self-hosting.md](./self-hosting.md)），坏的 relay 能做的最坏的事是不转发。

两种部署形态因此只差一步：

| 形态 | relay | 客户端凭什么被放行 |
|------|-------|------------------|
| 自建 | 纯汇合，按 id 撮合两条 socket | 配对时拿到的设备凭证，daemon 查本地列表 |
| 托管 | 拿票据问控制面 | 同上；控制面额外转达一句"这设备属于账号 A"，daemon 据此自动签发 |

准入实现只有一套。控制面是身份声明的转达者，不是判断者——它宕机或被攻破都影响不到已授权设备（[security-model.md](./security-model.md) §4）。

### 6.3 契约：relay 只能问三个问题（托管形态）

```ts
interface ChannelAuthority {
  authorizeDaemon(ticket): Promise<DaemonGrant | null>;   // 机器出站登记
  authorizeClient(ticket): Promise<ClientGrant | null>;   // 客户端接入某台机器
  reportPresence(machineId, state): Promise<void>;        // 在线状态回报
  onRevoked(handler): void;                               // 订阅撤销
}
```

线上形态是四个 HTTP 端点，定义在 `apps/relay/src/contract/wire.ts`，那是**跨仓库唯一契约**。撤销走 relay 主动订阅的 SSE 流而非控制面回调：这样控制面永远不需要能连上 relay，家里那台自建 relay 也就不必有公网入口。

面越小越好——每加一个方法，都是又一个"relay 知道了它本不该知道的事"的机会。小到自建模式下这个接口有一个什么都不问的实现：ticket 就是 rendezvous id，转发层一行代码都不用改。

### 6.4 怎么保证 relay 保持无知

不验证的架构约束等于没有。三条进 CI（`apps/relay/test/boundaries.test.ts`）：

| 检查 | 防的是什么 |
|------|-----------|
| `forward/` 只准 import `contract/` 与 `shared/` | 依赖方向一旦反过来就再也拆不开 |
| 数据路径上不许出现 `JSON.parse` / `JSON.stringify` | 它一旦开始理解流量，"看不到内容"就不再成立 |
| `package.json` 里不许有任何数据库依赖 | 存东西的 relay 就是需要被信任的 relay |

### 6.5 加密的现状，说实话

**当前实现：** 三条通道都是传输层加密——本机走 loopback，局域网与转发走 TLS。relay 拿到的是 TLS 解密后的应用层字节，它在代码上不解析、不落库，但**技术上具备读取能力**。

**这不等于端到端加密。** 真正的 E2EE 要求 daemon 与客户端基于对方公钥直接握手，relay 只见密文——它在路线图上（[roadmap.md](./roadmap.md)），尚未实现。

在它落地之前，文档与产品文案里都不要出现"平台无法看到你的内容"。可以说的是：relay 不解析、不存储，代码开源且可自建。差别很大，写清楚比含糊过去更值钱。

### 6.6 常见路径根本不走 relay

桌面壳内的 WebView 直连 `127.0.0.1`，同局域网可直连内网地址。只有"人在外面用手机连家里电脑"才经过 relay，所以这条链路的容量压力比直觉小得多。客户端按 ①→②→③ 顺序尝试，对用户不可见。

---

## 7. 前端：一份代码，四个宿主

| 宿主 | 怎么来的 | 连哪里 |
|------|---------|--------|
| 浏览器 | 直接访问 | 局域网地址或 relay 票据 |
| 桌面（Tauri） | 系统 WebView 加载同一份产物 | 本机 daemon |
| 手机（Tauri Mobile） | 同上 | relay，或同 Wi-Fi 直连 |
| 自建部署 | 静态文件 | 同浏览器 |

宿主差异收敛在 `packages/web/src/host/` 一个模块里，业务组件不允许出现 `if (isTauri)`。范围与移动端约束见 [web-workbench.md](./web-workbench.md)。

**本仓前端的范围是：会话、项目、文件、终端、以及你自己的设备管理。** 账号体系的界面不在本仓——它属于运营控制面的人，跟"用哪个 agent 干活"是两件事。

---

## 8. 仓库结构

```
apps/daemon      ← Rust：会话内核 + adapter 层 + 本地 WS + 出站长连接
apps/agent       ← Rust：内置 Genet Agent（众多 adapter 中的一个后端）
apps/relay       ← Node：转发层。无数据库、无业务、可自建
apps/desktop     ← Tauri 2 壳；桌面与移动端共用
packages/web     ← 工作台前端（四个宿主同一份产物）
packages/proto   ← 会话协议的唯一定义处，生成 TS 类型与 Rust 结构
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
