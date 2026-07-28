# Roadmap

> 原则：先打通「最简单能用」，再补设备、协作与加密。  
> 关联：[architecture.md](./architecture.md) · [daemon.md](./daemon.md) · [web-workbench.md](./web-workbench.md) · [security-model.md](./security-model.md)

---

## 总览

| 阶段 | 名称 | 用户能得到什么 | 状态 |
|------|------|----------------|------|
| **MVP** | 能装、能挂、能跑、能接力 | 安装 → 托盘后台 → 真跑起一条任务 → 换设备继续 | 进行中 |
| **M2** | 能带走 · 能多选 | 手机 App、设备管理、Claude Code / Codex 专用 adapter、分屏 | 计划 |
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
| Adapter | `genet` ✅ · `acp` ✅ · `opencode` ✅ | ✅ |
| Relay | `apps/relay`：帧转发、契约、限额、撤销订阅 | ✅ |
| Web | `packages/web`：会话、文件、变更、终端、设置 | ✅ |
| Desktop | Tauri 壳：托盘、关窗驻留、单实例、sidecar daemon | ✅ |
| 测试 | 跨部件集成 + 全栈旅程（浏览器客户端 → daemon → agent → 脚本化模型） | ✅ |
| 打包 | 安装包体积实测与自动校验 | ✅ |
| 真实模型 E2E | 用真实 API key 跑完整旅程（含外部 agent） | ✅ |

### 明确不做

- 手机原生 App（M2；MVP 用手机浏览器，界面已按小屏适配）
- Claude Code / Codex 专用 adapter（M2；MVP 用通用 ACP 覆盖一批）
- 应用内自动更新（手动重装）
- 端到端加密（M4；当前为传输层加密，见 [security-model.md](./security-model.md) §1.1）
- 前端长尾能力：语音、定时任务、分屏、fork / rewind 等，清单见 [web-workbench.md](./web-workbench.md) §4
- Agent 的 subagents / MCP / 真压缩 / 图片输入（见 [builtin-agent.md](./builtin-agent.md) §8）

### 验收清单

**闭环**

- [x] 干净环境下用内置 agent 跑完一条任务（含至少一次工具调用）
- [x] 流式输出、工具调用详情、diff 在工作台正常渲染
- [x] 关主窗口后托盘仍在、daemon 仍在；退出后子进程全部结束
- [x] Linux 包可安装、出现在应用列表，包内 daemon 能起来（`apps/desktop/scripts/bundle.sh` 自动校验）
- [ ] Windows / macOS 至少一端同样过一遍

**抽象是否成立**

- [x] daemon 内核代码中不存在按 agent 名字分支的逻辑
- [x] 未知工具类型走 `Unknown` 兜底渲染，不白屏、不丢事件
- [x] 同一段前端代码分别驱动内置 agent 与一个真实外部 agent，渲染结果形状一致

**接入与安全**

- [x] 配对走设备码流程，机器在控制面显示为在线
- [x] 配对后浏览器经 relay 连到 daemon，daemon 知道这条连接来自转发
- [x] 解除配对后机器从列表消失，本地不再保留登记信息
- [x] relay 不解析任何 payload（依赖方向 + 数据路径检查进 CI）
- [x] 契约摘要两侧一致，改动无法单边发布
- [x] 首次连接显示公钥指纹，与桌面端一致（不一致时明确告警）

**工程**

- [x] 断线重连后事件不丢不重；超出保留窗口时明确回全量快照
- [x] 安装包体积达标：实测下载 6MB、安装后 13MB（预算 80MB / 200MB）
- [x] 安装目录内不存在 `node` / `node.exe` / `node_modules`（打包脚本里校验，不靠自觉）

---

## M2 — 能带走 · 能多选

- Tauri Mobile 手机 App：扫码 + 已登录设备确认
- 已登录设备列表、撤销、「信任此设备」
- 深链 `genehub://`；桌面端开机自启
- **`claude` 与 `codex` 专用 adapter**：装机量最大的两个，通用 ACP 覆盖不到的能力（各自的审批语义）在这里补齐
- 工作台分屏；工具调用折叠视图
- 托盘在线状态

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
