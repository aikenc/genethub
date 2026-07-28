# GeneHub Roadmap

> 原则：先打通「最简单能用」的 MVP，再补准入、观测与运营能力。  
> 关联：[architecture.md](./architecture.md) · [daemon.md](./daemon.md) · [web-workbench.md](./web-workbench.md) · [product-ux.md](./product-ux.md) · [security-model.md](./security-model.md)  
> 本页已按 2026-07 架构修订重排：多 agent 适配、自研前端、转发折进 Hub。

---

## 总览

| 阶段 | 名称 | 用户能得到什么 | 状态 |
|------|------|----------------|------|
| **MVP** | 能装、能挂、能跑、能接力 | 安装 → 托盘后台 → 先体验并真跑起一条任务 → 换设备继续 | 当前聚焦 |
| **M2** | 能带走 · 能多选 | 手机扫码、设备管理、接入 Claude Code / Codex、分屏 | 计划 |
| **M3** | 能协作 | 正式账号、公开机器、受约束的租用 | 计划 |
| **M4** | 能看见 | 观测仪表盘、审计查询、告警 | 计划 |
| **M5** | 能运营 | 管理后台、配额、容器化隔离、SLO | 更后 |

---

## MVP

**成功标准：** 新用户下载安装后，跳过登录就能在本机**真的跑起一条 agent 任务**（不必先装任何外部 CLI）；同一个工作台也能驱动一个外部 ACP agent；关掉主窗口后托盘与 daemon 仍在；用一次性链接在另一台设备打开并看到同一台机器。

第二条是刻意加的：**只接一种 agent 的抽象等于没有抽象**（[architecture.md](./architecture.md) §2 B3）。

### 范围

| 模块 | 交付 |
|------|------|
| 协议 | `packages/proto`：归一化 `TimelineItem` / `SessionEvent` / `ToolCallDetail`，生成两端类型 |
| Agent | `apps/agent`（Rust）：Agent Loop、provider、SKILL、session 持久化、7 个工具 — **已完成** |
| Daemon | `apps/daemon`（Rust）：会话内核，`genet` + `acp` + `opencode` 三个 adapter，本地 WS、局域网直连、出站长连接，文件/git/PTY |
| Web | `packages/web`：自研工作台，范围见 [web-workbench.md](./web-workbench.md) §2 |
| Hub | `control/`：设备码授权、机器登记与撤销、机器目录、心跳；`forward/`：哑管道转发 + 身份准入 |
| Desktop | Tauri 安装包；托盘；关窗驻留；单实例；sidecar daemon；体积实测 |
| 身份 | 临时用户 + 恢复密钥；一次性设备会话链接（≤15 分钟、可撤销） |
| 安全预埋 | `audit_logs` 表 + 关键事件写入；结构化日志 + trace_id |
| 测试 | 全链路集成（不含 LLM）+ 真实模型 E2E，规格见 [testing.md](./testing.md) |
| 文档/官网 | 极简下载页 |

### 明确不做

- 邮箱 / GitHub 正式登录（M3）
- 手机原生 App（M2；MVP 用手机浏览器）
- Claude Code / Codex 专用 adapter（M2；MVP 用通用 ACP 覆盖一批）
- 公开租用池与管理后台（M3）
- 观测仪表盘与审计查询 UI（M4）
- 应用内自动更新（手动重装）
- 容器化隔离（M5）
- 前端长尾能力：语音、定时任务、分屏、fork/rewind、PR 面板等，清单见 [web-workbench.md](./web-workbench.md) §4
- Agent 的 subagents / extensions / MCP / 真压缩 / 图片输入（见 [builtin-agent.md](./builtin-agent.md) §8）

### 验收清单

**闭环**

- [ ] Windows / macOS 至少一端可安装并出现在开始菜单或 Applications
- [ ] 关主窗口后托盘仍在、daemon 进程仍在；退出后子进程全部结束
- [ ] 干净机器上「先体验」后能用内置 Agent 跑完一条任务（含至少一次工具调用）
- [ ] 流式输出、工具调用详情、diff 在工作台正常渲染

**抽象是否成立**

- [ ] 同一段前端代码分别驱动内置 agent 与一个真实 ACP agent，渲染结果形状一致
- [ ] daemon 内核代码中不存在按 agent 名字分支的逻辑
- [ ] 未知工具类型走 `Unknown` 兜底渲染，不白屏、不丢事件

**接入与安全**

- [ ] 「登录并绑定这台电脑」走通设备码授权，机器在 Web 上显示为在线
- [ ] 一次性链接在另一浏览器打开后建立独立设备会话；原设备可见并可撤销
- [ ] 链接过期或撤销后不可再用；Hub 撤销后 daemon 进入 revoked 且不再重连
- [ ] 首次连接显示公钥指纹，与桌面端一致
- [ ] 转发层未 parse 任何 payload（代码走查 + 依赖方向检查通过）
- [ ] `ROLES=forward` 单角色可独立启动（拆分能力冒烟）
- [ ] 关键事件（登录、链接核销、机器登记、通道授权）已落 `audit_logs`

**工程**

- [ ] 断线重连后事件不丢不重；超出保留窗口时明确回全量快照
- [ ] 安装包体积达标（下载 ≤ 80MB，安装后 ≤ 200MB）

---

## M2 — 能带走 · 能多选

- Capacitor 手机 App：出码 + 已登录设备确认
- 已登录设备列表、撤销、「信任此设备」
- 深链 `genethub://`；桌面端开机自启
- **`claude` 与 `codex` 专用 adapter**：装机量最大的两个，通用 ACP 覆盖不到的能力（如各自的审批语义）在这里补齐
- 工作台分屏；工具调用折叠视图
- 托盘在线状态

原本排在这里的 **relay 邀请码准入已删除**：转发折进 Hub 之后，只有已登记机器与已授权设备能开通道，身份即准入（[architecture.md](./architecture.md) §6.2）。剩下的只是限额与滥用检测，并入 M4 观测。

---

## M3 — 能协作

- 邮箱 Magic Link / GitHub OAuth；临时用户升级迁移（机器归属、设备会话、审计一并迁移）
- 机器 `private` / `public`；公开前强制校验隔离约束（工作目录白名单、自带 API Key、用量上限）
- 租用：单活跃租约、经 Hub 执行通道代理、随时收回、结束清理
- 公开机器要求正式账号
- 会话 fork / rewind；从外部 agent 导入历史会话

**范围提醒：** M3 的租用只面向组织内部可信成员。对外开放需要容器化隔离，见 M5。

---

## M4 — 能看见

### 观测

| 对象 | 指标 |
|------|------|
| Hub control | QPS、延迟、5xx、设备码授权成功率、登记成功率 |
| Hub forward | 连接数、转发字节、拒绝数、背压触发次数 |
| 机器 | 在线率、心跳间隔、重连次数 |
| 会话 | 按 agent 统计的建会话成功率、turn 失败率、审批超时率 |
| Desktop | 启动次数、daemon 崩溃重启、托盘驻留时长 |

转发层与控制面的指标**分命名空间**，将来拆开时仪表盘不用改（[architecture.md](./architecture.md) §6.4）。

交付顺序：结构化日志 → Prometheus 端点 → 仪表盘 → 核心告警（Hub 宕机、在线机器骤降、授权失败率升高、同一链接多 IP 核销）。

### 审计

事件清单与字段见 [control-plane.md](./control-plane.md)。M4 只加查询与展示：用户可见「最近登录设备 / 最近分享」，管理员可按人/机器/时间检索。保留期默认 90 天可配；导出放 M5。

---

## M5 — 能运营

- 管理后台：用户、机器、租约、在线率
- 漏斗：下载 → 安装 → 先体验 → 首次任务 → 换设备 → 绑定正式账号
- 配额：每用户机器数、并发租约
- **容器化隔离**，租用才可能对外开放
- Tauri 应用内更新
- SLO 报表、审计导出与保留策略 UI

---

## 触发式技术演进（不占里程碑）

| 方向 | 触发条件 |
|------|----------|
| 拆分 Hub 的 forward 与 control | 转发带宽或连接数开始影响控制面延迟，或两者发布节奏打架 |
| Hub 换 Go | 并发或部署密度需要 |
| 更多 agent adapter | 用户实际在用的 agent 出现在反馈里 |
| 内置 Agent 阶段 B/C 能力 | 桌面端实际使用反馈决定，不预先承诺 |

原「Go/Rust 自建 daemon 与 Agent」两项**已提前完成**，触发原因不是体积而是协议自主。

---

## 依赖关系

```
协议定稿 ──► daemon 内核 + genet adapter ──► 工作台骨架 ──► acp adapter（证伪抽象）
                                                                    │
Hub control + forward ──► 设备码授权 + 一次性链接 ─────────────────┤
                                                                    ▼
                                            Desktop 打包 ──► M2 手机 / 更多 adapter
                                                                    │
                                            M3 账号 + 租用 ──► M4 观测审计 ──► M5 运营
```

MVP 起预埋：`audit_logs` 写入 + 结构化日志 + 依赖方向检查（先写后看）。

---

## 文档维护

- 阶段完成时更新「状态」列
- 范围变更只改本文件与 [architecture.md](./architecture.md) 的决策段落，避免多处打架
- 架构层面的取舍一律回写 [architecture.md](./architecture.md)，本文只排期
