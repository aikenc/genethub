# Roadmap

> 原则：先打通「最简单能用」，再补设备、协作与加密。  
> 关联：[architecture.md](./architecture.md) · [daemon.md](./daemon.md) · [web-workbench.md](./web-workbench.md) · [security-model.md](./security-model.md) · [third-party-agents.md](./third-party-agents.md)

---

## 总览

| 阶段 | 名称 | 用户能得到什么 | 状态 |
|------|------|----------------|------|
| **MVP** | 能装、能挂、能跑、能接力 | 安装 → 托盘后台 → 真跑起一条任务 → 换设备继续 | 进行中 |
| **自成闭环** | 不依赖任何外部服务 | 只部署 relay + 静态工作台，就能远程用自己的电脑 | ✅ |
| **M2** | 能带走 · 能多选 | 手机 App、设备管理、分屏 | 计划 |
| **M3** | 能协作 | 正式账号、多人共用一台机器、会话 fork / rewind | 计划 |
| **M4** | 能不信任中转 | 端到端加密：relay 只见密文 | 计划 |

---

## MVP

**成功标准：** 新用户安装后跳过登录就能在本机**真的跑起一条 agent 任务**（不必先装任何外部 CLI）；同一个工作台也能驱动一个外部 agent；关掉主窗口后托盘与 daemon 仍在；配对之后能在另一台设备的浏览器里打开同一台机器。

第二条是刻意加的：**只接一种 agent 的抽象等于没有抽象**（[architecture.md](./architecture.md) §2 B3）。

### 范围与状态

| 模块 | 交付 | 状态 |
|------|------|------|
| 协议 | `packages/proto`：归一化 `TimelineItem` / `SessionEvent` / `ToolCallDetail`，生成两端类型 | ✅ |
| Agent | `apps/agent`：agent loop、provider、技能、会话持久化、工具集 | ✅ |
| Daemon | `apps/daemon`：会话内核、本地 WS、出站长连接、文件 / git / PTY、配对 | ✅ |
| Adapter | `genet` ✅ · `acp` ✅ · `opencode` ✅ · `claude` ✅ · `codex` ✅ | ✅ |
| Relay | `apps/relay`：帧转发、契约、限额、撤销订阅 | ✅ |
| Web | `packages/web`：会话、文件、变更、终端、设置、打开项目、开箱即用的首个会话 | ✅ |
| Desktop | Tauri 壳：托盘、关窗驻留、单实例、sidecar daemon、看门狗与接管遗留进程 | ✅ |
| 测试 | 跨部件集成 + 全栈旅程（浏览器客户端 → daemon → agent → 脚本化模型） | ✅ |
| 打包 | 安装包体积实测与自动校验 | ✅ |
| 真实模型 E2E | 用真实 API key 跑完整旅程（含外部 agent） | ✅ |

### 明确不做

- 手机原生 App（M2；MVP 用手机浏览器，界面已按小屏适配）
- Codex 的原生协议适配（其 `app-server` JSON-RPC）：计划在 M2 做，见下方「M2」一节；在此之前 Codex 官方维护的 ACP wrapper 已经够用且经真实探测验证过，不会为了赶在 MVP 里做而仓促写一份
- Codex 接 DeepSeek：不是我们的待办，是 Codex（只认 Responses API）与 DeepSeek（只有 Chat Completions）两个上游之间的协议缺口，见 [third-party-agents.md](./third-party-agents.md) §4；换成原生 `app-server` 传输不会让这个缺口消失
- 应用内自动更新（手动重装）
- 端到端加密（M4；当前为传输层加密，见 [security-model.md](./security-model.md) §1.1）
- 前端长尾能力：语音、定时任务、分屏、fork / rewind 等，清单见 [web-workbench.md](./web-workbench.md) §4
- Agent 的 subagents / MCP / 真压缩（见 [builtin-agent.md](./builtin-agent.md) §8）；`genet` 自身的图片输入也在此列——贴图现在能发给 claude / acp / opencode（它们各自把图片转给自己的模型），但 `genet` 的 provider 层（Anthropic / OpenAI / DeepSeek 请求构造）还不接受图片内容块
- 会话中途动态切换 agent：`claude`、`opencode` 各自维护一份进程私有的会话状态（CLI 自己的 `--resume` id、HTTP session），把 `TimelineItem` 转存到另一个 agent 不等于真的迁移了上下文，效果只会更糟；有对话内容后前端直接锁定 agent 选择器（`ComposerControls.tsx`），而不是假装能无缝换
- `mode` 轴的协议级拆分：`genet` 把这条轴用作思考强度，`claude`/`acp` 用作工具审批策略，目前只在前端按 `capabilities.permissions` 打了个临时标签区分（"思考" / "权限"），协议层仍是同一个 `modeId` 字段
- OpenCode 的真实模型目录（当前 `catalog.models` 恒为空，选择器因此不出现）、各 adapter 的速度 / 质量档位、权限的历史面板
- 「/」命令：`genet-agent` 内部已经有 `get_commands` / skill 展开，但 daemon 的 `genet` adapter 从不调用它，前端也没有发现或补全入口——`/skill:<name>` today 只有整行手打、且未经验证是否原样透传到 prompt 才可能生效；第三方 agent（claude / opencode）自己的原生 slash 命令同样没有透传

### 验收清单

**闭环**

- [x] 干净环境下用内置 agent 跑完一条任务（含至少一次工具调用）
- [x] 流式输出、工具调用详情、diff 在工作台正常渲染
- [x] 关主窗口后托盘仍在、daemon 仍在；退出后子进程全部结束
- [x] 新装的机器打开就是一个能说话的会话：默认工作目录由 daemon 备好，只剩密钥需要问
- [x] 重新连上落回最近动过的那个会话，而不是一块空白加一个按钮
- [x] daemon 被杀后自动回来，端口变化推给前端；上一个外壳留下的 daemon 被接管而不是抢锁失败
- [x] Linux 包可安装、出现在应用列表，包内 daemon 能起来（`apps/desktop/scripts/bundle.sh` 自动校验）
- [ ] Windows / macOS 至少一端同样过一遍

**抽象是否成立**

- [x] daemon 内核代码中不存在按 agent 名字分支的逻辑
- [x] 未知工具类型走 `Unknown` 兜底渲染，不白屏、不丢事件
- [x] 同一段前端代码分别驱动内置 agent 与一个真实外部 agent，渲染结果形状一致
- [x] Claude Code（原生 `stream-json`，`adapter::claude`）接 DeepSeek 官方 Anthropic 兼容端点，真实模型端到端跑通并固化为四条回归测试（`testing/tests/claude.rs`）：基本对话、`acceptEdits` 免打扰放行工具调用、daemon 中断请求真的打断生成、拒绝权限请求后工具确实没有落盘
- [x] Codex（经 `codex-acp`）默认注册、探测与选择器展示正常；接 DeepSeek 的已知限制记录在案，不在本项目范围内解决

**接入与安全**

- [x] 配对走设备码流程，机器在控制面显示为在线
- [x] 配对后浏览器经 relay 连到 daemon，daemon 知道这条连接来自转发
- [x] 解除配对后机器从列表消失，本地不再保留登记信息
- [x] relay 不解析任何 payload（依赖方向 + 数据路径检查进 CI）
- [x] 契约摘要两侧一致，改动无法单边发布
- [x] 首次连接显示公钥指纹，与桌面端一致（不一致时明确告警）

**工程**

- [x] 断线重连后事件不丢不重；超出保留窗口时明确回全量快照（含回合进行中掉线）
- [x] 真的重启 daemon 进程后历史还在并能继续对话；停止按钮端到端落 `TurnCanceled`
- [x] 安装包体积达标：实测下载 6MB、安装后 13MB（预算 80MB / 200MB）
- [x] 安装目录内不存在 `node` / `node.exe` / `node_modules`（打包脚本里校验，不靠自觉）

---

## 自成闭环 — 不依赖任何外部服务

**为什么排在 M2 前面：** 在这之前，"人在外面连家里电脑"需要一个本仓之外的控制面。也就是说单独部署本仓拿不到这条核心能力，独立部署没有价值。

**成功标准：** 只起 daemon + relay + 静态工作台（无数据库、无账号、无控制面），另一台设备扫码配对后经转发连上并对话成功。

| 项 | 状态 | 说明 |
|---|---|---|
| daemon 设备凭证 | ✅ | 本机已授权设备列表（[daemon.md](./daemon.md) §4.3）；一次性配对邀请换长期凭证；逐个撤销 |
| 双向证明 | ✅ | 客户端与 daemon 用配对时的共享秘密互证，秘密不过线（[security-model.md](./security-model.md) §4.2） |
| relay 汇合模式 | ✅ | `RELAY_MODE=rendezvous`：按 id 撮合两条 socket，不问控制面、不落库（[relay.md](./relay.md) §3.1） |
| 设备管理界面 | ✅ | 配对链接 + 二维码、已授权设备、我的机器（[web-workbench.md](./web-workbench.md) §2.6） |
| 文档 | ✅ | [self-hosting.md](./self-hosting.md) 改成"relay + 静态 web 就够" |
| CI | ✅ | 只用本仓组件的全栈用例挂进了 web job（[testing.md](./testing.md) §8.1「自建全栈」）|

验收清单：

- [x] 配对邀请一次性、会过期，用掉之后再用被拒
- [x] 撤销一台设备后它的连接立刻断，且再也连不上
- [x] 伪造凭证、抢占 rendezvous 槽位都被拒
- [x] 只用本仓组件跑通"另一台设备配对后经转发对话"

---

## M2 — 能带走 · 能多选

- Tauri Mobile 手机 App：扫码 + 已登录设备确认
- 已登录设备列表、撤销、「信任此设备」
- 深链 `genehub://`；桌面端开机自启
- 工作台分屏；工具调用折叠视图
- 托盘在线状态
- Codex 原生 `app-server` JSON-RPC 适配器，替掉 `codex-acp` wrapper：和 Claude Code 换原生协议（MVP，`adapter::claude`）同一个理由——拿回 ACP 不暴露的逐工具权限控制。默认注册表里的 `codex` 条目原地升级，不新增 id，不需要用户改配置

---

## M3 — 能协作

- 邮箱 Magic Link / GitHub OAuth；临时用户升级迁移（机器归属、设备会话一并迁移）
- 一台机器授权给多个设备会话，按会话撤销
- 会话 fork / rewind；从外部 agent 导入历史会话

---

## M4 — 能不信任中转

端到端加密：daemon 与客户端基于公钥直接协商会话密钥，relay 只见密文。

需要一并解决的：

- 公钥分发与指纹核对流程（[security-model.md](./security-model.md) §1.2）
- 密钥轮换后已有设备的重新配对体验
- 多设备同时在线时的密钥协商开销

在它落地之前，任何文案都不能声称平台看不到内容。

---

## 触发式技术演进（不占里程碑）

| 方向 | 触发条件 |
|------|----------|
| relay 换更省内存的实现 | 单机连接数开始受内存限制 |
| 更多 agent adapter | 用户实际在用的 agent 出现在反馈里 |
| 内置 agent 的进阶能力 | 桌面端实际使用反馈决定，不预先承诺 |

---

## 依赖关系

```
协议定稿 ──► daemon 内核 + genet adapter ──► 工作台骨架 ──► acp / opencode（证伪抽象）
                                                                    │
relay + 配对 ─────────────────────────────────────────────────────┤
                                                                    ▼
                                            桌面打包 ──► M2 手机 / 更多 adapter
                                                                    │
                                            M3 账号协作 ──► M4 端到端加密
```

---

## 文档维护

- 阶段完成时更新「状态」列
- 范围变更只改本文件与 [architecture.md](./architecture.md) 的决策段落，避免多处打架
- 架构层面的取舍一律回写 [architecture.md](./architecture.md)，本文只排期
