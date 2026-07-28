# GeneHub 架构

> 本文是**全仓最上层的事实来源**。其他文档展开各自领域，冲突时以本文为准。  
> 修订背景：内置 Agent 落地后，两条新约束改变了原设计——(1) 必须同时接入多个 coding agent；(2) 前端要自研并复刻主流工作台约 60% 的能力。

---

## 1. 一句话架构

```
浏览器 / 桌面 / 手机
     │
     │  统一会话协议（GeneHub 自有），三条路走同一套消息：
     │   ① 127.0.0.1（桌面壳内，最常见）
     │   ② 局域网直连
     │   ③ 公网中转 ── app.genethub.com/relay/ws ─┐
     ▼                                            │
┌──────────┐                                      │  ┌──────────────────┐
│  daemon  │ ──────── 出站 WS ────────────────────┴─►│ Hub              │
│ （用户PC）│                                         │ 账号/机器目录/租用 │
└────┬─────┘                                         │ + 转发层（哑管道） │
     │  Adapter 层（每种 agent 一个）                  └──────────────────┘
     ├─ genet    ← 自研内置 agent（stdio JSONL）
     ├─ acp      ← 通用适配，一把覆盖一大票 CLI
     ├─ claude   ← Claude Code CLI
     └─ …        ← 后续
```

用户 PC 上只有一个常驻进程（daemon），它按需拉起 agent 子进程；所有客户端说同一套协议，**看不见背后是哪种 agent**，也看不见走的是哪条通道。

---

## 2. 三条不可让步的边界

这三条是整个架构的承重墙，后面所有取舍都从它们推导：

### B1. Agent 是插件，内核不认识任何具体 agent

daemon 里不允许出现 `if provider == "genet"` 这类分支散落在业务代码。具体 agent 的知识只能存在于它自己的 adapter 文件里。

### B2. 客户端协议是产品资产，不是某个 agent 的协议

**这是本次修订最重要的一条。** 内置 agent 目前发的是它自己形状的事件，如果 daemon 直接转发给前端，等于把某一个 agent 的线格式钉死成产品协议——接第二种 agent 时就只能做反向映射，前端还得知道"这条消息来自哪种 agent"。

所以：daemon 内部定义一套与任何 agent 无关的 `TimelineItem` / `SessionEvent`，每个 adapter 负责把自家格式翻译过来。前端只认这一套。

### B3. 一个 adapter 的抽象等于没有抽象

只接自研 agent 时写出来的"抽象层"必然是自研 agent 的形状。因此 MVP 就必须跑通**两种形状截然不同**的 agent（自研 stdio JSONL + 通用 ACP），抽象才算被证伪过一次。这条决定了 roadmap 的排期，不是可以往后挪的锦上添花。

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

### 3.2 Adapter 契约（Rust trait，草案）

```rust
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &str;                       // "genet" / "acp:cursor" / "claude"
    fn capabilities(&self) -> Capabilities;     // 支不支持中断、切模型、审批、恢复

    /// 二进制在不在、能不能握手。用于机器上的 agent 发现。
    async fn probe(&self) -> Probe;
    /// 模型与模式清单。
    async fn catalog(&self) -> Result<Catalog>;

    async fn start(&self, cfg: SessionConfig) -> Result<Box<dyn AgentSession>>;
    async fn resume(&self, handle: PersistHandle) -> Result<Box<dyn AgentSession>>;
}

#[async_trait]
pub trait AgentSession: Send + Sync {
    /// 唯一的出口：归一化之后的事件流。
    fn events(&self) -> broadcast::Receiver<SessionEvent>;

    async fn send(&self, input: PromptInput) -> Result<TurnId>;
    async fn interrupt(&self) -> Result<()>;
    async fn close(&self) -> Result<()>;

    async fn set_model(&self, id: &str) -> Result<()>;
    async fn set_mode(&self, id: &str) -> Result<()>;      // 权限档位也走这里
    async fn respond_permission(&self, req: &str, r: PermissionReply) -> Result<()>;

    /// 能恢复就返回句柄，不能就返回 None（daemon 自行降级为只读回放）。
    fn persistence(&self) -> Option<PersistHandle>;
}
```

能力差异用 `Capabilities` 声明，**不用返回 `Unsupported` 错误来试探**：前端要在按钮渲染前就知道这个 agent 能不能切模型，而不是点了才报错。

### 3.3 首批 adapter 与优先级

| adapter | 传输 | 覆盖 | 阶段 |
|---------|------|------|------|
| `genet` | 子进程 + stdio JSONL | 自研内置 agent，装完即可跑 | MVP |
| `opencode` | 本地 HTTP + SSE | OpenCode | MVP |
| `acp` | 子进程 + ACP over stdio | 一份代码覆盖 Cursor / Copilot / Gemini / goose 等一批 CLI | MVP |
| `claude` | 子进程 + stream-json | Claude Code，装机量最大 | M2 |
| `codex` | 子进程 + JSON-RPC | Codex | M2 |

MVP 三个各有各的理由：`genet` 是兜底，`acp` 是**一份适配换一批 agent**，`opencode` 则是**形状差异最大的那个**——它不是子进程 stdio 而是本地 HTTP + SSE。用它来证伪 B3 最狠：如果归一化层能同时吃下 stdio 流和 HTTP 事件流，那它多半是真抽象而不是某一种传输的马甲。

用户自定义 agent 走配置声明，不需要改代码：

```jsonc
{ "agents": { "goose": { "extends": "acp", "command": ["goose", "acp"] } } }
```

---

## 4. 归一化事件模型

前端和存储只认这一套，它是 daemon 对外契约的核心。

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
    Unknown { raw },                 // 兜底：JSON 折叠展示，永远不允许丢事件
}

enum SessionEvent {
    TurnStarted { turn_id },
    Item { item: TimelineItem, turn_id },
    ItemDelta { item_id, delta },    // 流式增量
    TurnCompleted { turn_id, usage },
    TurnFailed { turn_id, error },
    PermissionRequested { request },
    PermissionResolved { request_id, outcome },
    ModelChanged / ModeChanged { .. },
}
```

三条规则：

1. **`Unknown` 是必需品**。新 agent 冒出没见过的工具时必须仍能展示，不能白屏，也不能丢事件。
2. **工具名归一化在 adapter 内做**，各家自己维护映射表（`Bash`→`Shell`、`str_replace_editor`→`Edit`…）。不要试图做一张全局大表，那张表会变成所有 adapter 的耦合点。
3. **增量与全量都要有**。`ItemDelta` 给流式打字机效果，`Item` 给最终态；断线重连时只回放 `Item`。

---

## 5. daemon 职责边界

| 归 daemon | 不归 daemon |
|-----------|-------------|
| 会话生命周期、持久化、断线重放 | 跟模型说话（agent 的事） |
| Adapter 注册、发现、启停 | 工具执行（agent 的事） |
| 文件读写 / 目录树 / git 查询 | 账号与租用（Hub 的事） |
| PTY 终端 | 流量中转（relay 的事） |
| 审批请求的排队与投递 | 审批策略本身（各 agent 的模式） |
| 与 Hub 的登记、与 relay 的出站连接 | |

细节见 [daemon.md](./daemon.md)。

---

## 6. 传输：转发折进 Hub，但保持哑管道（决策变更）

原方案是独立部署一个第三方中转服务。改为**同域名同进程的一个转发端点**，理由与约束如下。

### 6.1 为什么不能没有转发

用户 PC 在 NAT 后面，没有公网入口。要让手机或另一台浏览器访问它，必须有一个双方都能连到的汇合点。这是硬需求，叫 relay 还是叫 Hub 只是命名。

### 6.2 为什么折进 Hub

| 收益 | 说明 |
|------|------|
| 一个域名一套证书 | 运维成本减半 |
| 准入问题自动消失 | 独立中转认不出用户，所以本来要专门做邀请码；折进 Hub 后只有已登记机器与已授权设备能开通道 |
| 去掉外部协议依赖 | 自己写的转发器只有一张配对表加字节搬运，不必为了搬字节背别人的配对语义 |

### 6.3 代价与守则

拆开原本是有道理的：数据面和控制面的**扩展曲线、故障半径、信任级别都不同**——带宽尖峰不该拖垮登录，中转不该有能力读明文。合并之后这三条风险仍在，靠一条守则兜住：

> **转发层永远不 parse payload。** 它只认路由信息，把加密帧从一端搬到另一端。

### 6.4 模块边界：合并部署，但按可拆分的方式写

"以后能拆"如果只是口头承诺，半年后一定拆不动。所以边界要写成能被检查的规则。

```
apps/hub/
├── main             组装：按 ROLES 环境变量决定本进程跑哪些角色
├── control/         控制面：账号、机器目录、租用、审计
├── forward/         转发层：配对表 + 帧搬运，无任何业务依赖
├── contract/        两者之间唯一允许的接口
└── shared/          只放配置、日志、指标这类真正共用的基础件
```

五条硬规则：

| 规则 | 为什么 |
|------|--------|
| `forward` 不得 import `control` 的任何模块，只依赖 `contract` | 依赖方向一旦反过来就再也拆不开 |
| `contract` 的接口必须是**可远程化形状**：异步、参数可序列化、无共享内存、无共享事务 | 今天是进程内调用，拆开时只换实现不改调用方 |
| 两者**不共享数据库表与事务**。转发层要知道"这个票据对应哪台机器"，只能问 `contract`，不能直接查表 | 共享一张表等于共享一次部署 |
| 转发层不持有业务数据。它自己的状态（在线连接表）是内存态，随时可丢弃重建 | 无状态才能水平扩，也才能独立重启 |
| 单进程期就要有隔板：独立的连接上限、独立的背压与限流，不共用一个池 | 否则带宽尖峰仍会拖垮登录，合并的风险就白担了 |

`contract` 的全部内容大致就这么多——面越小越拆得动：

```ts
interface ChannelAuthority {
  authorizeDaemon(ticket): Promise<DaemonGrant | null>;   // 机器出站登记
  authorizeClient(ticket): Promise<ClientGrant | null>;   // 客户端接入某台机器
  reportPresence(machineId, state): Promise<void>;        // 在线状态回报控制面
  onRevoked(handler): void;                               // 撤销指令推给转发层
}
```

### 6.5 怎么验证还拆得开

不验证的架构约束等于没有。两件事进 CI：

1. **依赖方向检查**：静态规则禁止 `forward → control` 的 import，违反即构建失败。
2. **单角色启动冒烟**：定期以 `ROLES=forward` 单独启动，断言它能起来、能接受连接，只在需要鉴权时因为够不到控制面而拒绝。能通过，就说明没有偷偷长出隐式耦合。

真正触发拆分的信号：转发带宽或连接数开始影响控制面延迟，或者两者的发布节奏打架。到那天拆出去应该是**改配置加改 `contract` 的一处实现**，不是重写。

### 6.6 加密边界

| 场景 | 通道 | 服务端能否读明文 |
|------|------|------------------|
| 自己的机器 | 转发层哑管道 | **不能**（端到端加密） |
| 租用他人机器 | Hub 执行通道 | 能——这是租用可审计、可撤销的前提 |

诚实说明：端到端加密防的是服务端被动留存与中转节点被攻破，**防不住我们自己发一个恶意前端**。它的价值是让我们不成为一个存着客户源码的目标，不要当成万灵药宣传。

### 6.7 常见路径根本不走转发

桌面壳内的 WebView 直连 `127.0.0.1`，同局域网可直连内网地址。只有"人在外面用手机连家里电脑"才经过公网转发，所以这条链路的容量压力比直觉小得多。客户端按 ①→②→③ 顺序尝试，对用户不可见。

---

## 7. 前端：从 fork 改为自研（决策变更）

原方案是 fork 成熟工作台再魔改，纪律是"只改主题、导航、鉴权，不碰会话与协议层"。**这条前提已经不成立**：

- daemon 是自研的，协议是自有的 —— fork 来的前端说的是别人的协议，魔改面必然从三处扩散到整个会话层，fork 纪律当场破产；
- 目标本来就是"复刻最重要的 60%"，而 fork 得到的是 100% 再往下砍——砍别人的代码比写自己的更贵；
- 顺带解掉 AGPL 衍生与观感上的抄袭风险。

因此改为**自研前端，按能力清单复刻约 60%**。范围、技术选型与页面结构见 [web-workbench.md](./web-workbench.md)。

---

## 8. 仓库结构

```
apps/daemon      ← Rust：会话内核 + adapter 层 + 本地 WS + 出站长连接
apps/agent       ← Rust：内置 Genet Agent（众多 adapter 中的一个后端）
apps/hub         ← control/（账号·机器目录·租用·审计）+ forward/（哑管道）
                    同一部署两个角色，边界与拆分规则见 §6.4
apps/desktop     ← Tauri 2 壳 + sidecar（daemon）
apps/mobile      ← Capacitor 壳
packages/web     ← 自研工作台（浏览器 / 桌面 / 手机同一份产物）
packages/proto   ← 会话协议的唯一定义处，生成 TS 类型与 Rust 结构
```

`packages/proto` 单独成包是刻意的：协议只能有一处定义，否则前后端各写一遍，第三次改字段时必然对不上。

---

## 9. 演进顺序与理由

| 顺序 | 做什么 | 为什么是这个顺序 |
|------|--------|------------------|
| 1 | 定协议（`packages/proto`） | 前后端可并行，且改字段的成本此时最低 |
| 2 | daemon 内核 + `genet` adapter | 有了可跑通的最短闭环 |
| 3 | 前端工作台骨架 | 能看见，才谈得上验收 |
| 4 | `acp` 与 `opencode` adapter | 用另外两种形状证伪抽象；此时改抽象还便宜 |
| 5 | Hub 接入（含转发层）+ 桌面打包 | 从"能跑"到"能装能接力" |
| 6 | 全链路集成测试 → 真实模型 E2E | 见 [testing.md](./testing.md) |

第 4 步刻意排在打包之前：抽象错了要在只有两个调用方时发现，等三端都装上了再改就是全链路返工。

---

## 10. 与参考实现的关系

我们调研过若干开源实现，借鉴的是**公开的接口约定**：[ACP](https://agentclientprotocol.com/)、[Agent Skills 标准](https://agentskills.io/specification)，以及各家 CLI 自己文档化的 stdio / HTTP 协议。这些本来就是发布出来给第三方对接的。

GeneHub 的协议、daemon、前端与内置 agent 均为自有实现：不 fork、不 import、不复制代码。接入某个 agent 时我们实现的是**它对外公开的对接接口**，与任何第三方写客户端的做法无异。
