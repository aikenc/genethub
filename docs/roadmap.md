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
| **M4** | 能不信任整个平台 | 独立公钥握手、前向保密、可验证客户端；Control 也不知道会话密钥 | 计划 |

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
- Codex 的 skills 菜单、子 agent 内部步骤：原生 `app-server` 适配器已经落地（`adapter::codex`），`thread/resume` 和贴图也已接上；这两项是它明确还没接的部分，理由见 [third-party-agents.md](./third-party-agents.md) §4 末尾；对应能力位不申报，界面上因此没有对应控件，而不是点了不生效
- Codex 接 DeepSeek：不是我们的待办，是 Codex（只认 Responses API）与 DeepSeek（只有 Chat Completions）两个上游之间的协议缺口，见 [third-party-agents.md](./third-party-agents.md) §4；换成原生 `app-server` 传输不会让这个缺口消失
- 应用内自动更新（手动重装）
- 平台级零知识与前向保密（M4；当前转发业务帧已对 Relay 加密，但托管 Control 生成对称会话 secret，见 [security-model.md](./security-model.md) §1.1）
- 前端长尾能力：语音、定时任务、分屏、fork / rewind 等，清单见 [web-workbench.md](./web-workbench.md) §4
- Agent 的 subagents / MCP / 真压缩（见 [builtin-agent.md](./builtin-agent.md) §8）；`genet` 自身的图片输入也在此列——贴图现在能发给 claude / acp / opencode（它们各自把图片转给自己的模型），但 `genet` 的 provider 层（Anthropic / OpenAI / DeepSeek 请求构造）还不接受图片内容块
- 会话中途动态切换 agent：`claude`、`opencode` 各自维护一份进程私有的会话状态（CLI 自己的 `--resume` id、HTTP session），把 `TimelineItem` 转存到另一个 agent 不等于真的迁移了上下文，效果只会更糟；有对话内容后前端直接锁定 agent 选择器（`ComposerControls.tsx`），而不是假装能无缝换
- OpenCode 的真实模型目录（当前 `catalog.models` 恒为空，选择器因此不出现）、各 adapter 的速度 / 质量档位、权限的历史面板
- 「/」命令的其余半边：Claude Code 的命令表已经透传（`initialize` 握手拿到，composer 里输入 `/` 就是这份表），但 `genet-agent` 自己的 `get_commands` / skill 展开仍然没接上，OpenCode 的命令表也还没读

### 验收清单

**闭环**

- [x] 干净环境下用内置 agent 跑完一条任务（含至少一次工具调用）
- [x] 流式输出、工具调用详情、diff 在工作台正常渲染
- [x] 关主窗口后托盘仍在、daemon 仍在；退出后子进程全部结束
- [x] 新装的机器打开就是一个能说话的会话：默认工作目录由 daemon 备好，只剩密钥需要问
- [x] 重新连上落回最近动过的那个会话，而不是一块空白加一个按钮
- [x] daemon 被杀后自动回来，端口变化推给前端；上一个外壳留下的 daemon 被接管而不是抢锁失败
- [x] Linux daemon/CLI 包可由 `scripts/install.sh` 安装并完成首启自检；Linux 不提供桌面应用，工作台从浏览器打开
- [x] 无图形界面的机器也能装：`scripts/install.sh` 只装 daemon + 内置 agent，校验 `SHA256SUMS`，装不成不留半截二进制（`testing/tests/install.rs`）
- [x] 打 tag 生成 Windows 桌面安装包与各 CLI 目标 tarball，附长度和 SHA-256；Linux 不生成桌面包
- [ ] macOS 完成签名与公证后加入正式桌面安装包发布；源码构建与 macOS CI 门禁已经保留
- [ ] Windows / macOS 的安装包**装完之后**过一遍主旅程：发布流水线只验到"这个平台上 daemon 能起来、工作目录被建出来"，装包与首启仍要手动过（[testing.md](./testing.md) §7）

**抽象是否成立**

- [x] daemon 内核代码中不存在按 agent 名字分支的逻辑
- [x] 未知工具类型走 `Unknown` 兜底渲染，不白屏、不丢事件
- [x] 同一段前端代码分别驱动内置 agent 与一个真实外部 agent，渲染结果形状一致
- [x] Claude Code（原生 `stream-json`，`adapter::claude`）接 DeepSeek 官方 Anthropic 兼容端点，真实模型端到端跑通并固化为四条回归测试（`testing/tests/claude.rs`）：基本对话、`acceptEdits` 免打扰放行工具调用、daemon 中断请求真的打断生成、拒绝权限请求后工具确实没有落盘
- [x] Codex（原生 `app-server`，`adapter::codex`）默认注册、探测（含未登录时报出那一行命令而不是让首个 prompt 挂住）与三个选择器展示正常；接 DeepSeek 的已知限制记录在案，不在本项目范围内解决

**接入与安全**

- [x] 配对走设备码流程，机器在控制面显示为在线
- [x] 配对后浏览器经 relay 连到 daemon，daemon 知道这条连接来自转发
- [x] 解除配对后机器从列表消失，本地不再保留登记信息
- [x] relay 不解析任何 payload（依赖方向 + 数据路径检查进 CI）
- [x] 契约摘要两侧一致，改动无法单边发布
- [ ] canonical daemon 公钥身份、协议签名验证、首次 pin 与变化阻断告警（当前 fingerprint 只是 machine id + secret 的展示摘要）

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
| 目标切换器 | 进行中 | 「我能控制哪些机器」从设备页升到主导航，本机是其中一项而不是唯一项（[web-workbench.md](./web-workbench.md) §2.6.0）。桌面端因此也能切到配对过的另一台 |

**目标切换器为什么在开源侧**：多设备本来就是自建用户的需求——一个人有台式机和笔记本，配对过两台就该能在两台之间切。它跟账号无关，账号只是让这份名单换个来源。`Host.targets()` 保持中性，不含任何账号字段。

验收清单：

- [x] 配对邀请一次性、会过期，用掉之后再用被拒
- [x] 撤销一台设备后它的连接立刻断，且再也连不上
- [x] 伪造凭证、抢占 rendezvous 槽位都被拒
- [x] 只用本仓组件跑通"另一台设备配对后经转发对话"——真的对话，流式分片，历史留在机器上
- [x] relay 被重启后 daemon 自己回来，配对过的设备无需重新配对

---

## M2 — 能带走 · 能多选

- Tauri Mobile 手机 App：扫码 + 已登录设备确认
- 已登录设备列表、撤销、「信任此设备」
- 深链 `genehub://`；桌面端开机自启
- 工作台分屏；工具调用折叠视图
- 托盘在线状态
---

## M3 — 能协作

- 邮箱 Magic Link / GitHub OAuth；临时用户升级迁移（机器归属、设备会话一并迁移）
- 一台机器授权给多个设备会话，按会话撤销
- 会话 fork / rewind；从外部 agent 导入历史会话

---

## M4 — 能不信任中转

当前 v2 已让 Relay 只见初始证明与业务密文；M4 继续把托管 Control 和前端从密钥信任路径移出：daemon 与可验证客户端基于公钥直接协商临时会话密钥，并提供前向保密。

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
