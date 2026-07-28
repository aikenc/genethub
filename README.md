# GeneHub

团队 coding agent 集群的产品层：账号、PC 接入、跨端接力、公开租用。  
自研 daemon 与工作台，可接入多种 coding agent，并内置一个装完即用的 agent。

## 一句话

装一个 PC App → 可匿名先玩且立刻能跑任务 → 链接/扫码在手机和浏览器之间接力 → 以后再绑邮箱或 GitHub。

## 定位

用户 PC 上跑一个常驻 daemon，它按需拉起各种 coding agent；所有客户端说同一套自有协议，**看不见背后是哪种 agent，也看不见走的是哪条通道**。

## 文档

先读 [architecture.md](./docs/architecture.md)，它是最上层的事实来源，其他文档冲突时以它为准。

| 文档 | 内容 |
|------|------|
| [architecture.md](./docs/architecture.md) | **分层与边界**：多 agent 适配、归一化事件模型、传输取舍、演进顺序 |
| [daemon.md](./docs/daemon.md) | Rust 精简 daemon：模块划分、客户端协议、会话存储、审批 |
| [builtin-agent.md](./docs/builtin-agent.md) | Genet Agent（Rust）：RPC 契约、Agent Loop、provider、SKILL、session |
| [web-workbench.md](./docs/web-workbench.md) | 自研工作台：复刻 60% 的能力边界、优先级、技术选型 |
| [product-ux.md](./docs/product-ux.md) | 产品与用户旅程 |
| [security-model.md](./docs/security-model.md) | 信任边界、凭证与撤销、分享规则、准入 |
| [control-plane.md](./docs/control-plane.md) | 控制面职责、数据模型、授权与租用约束 |
| [desktop-client.md](./docs/desktop-client.md) | PC 客户端：安装 / 托盘 / 后台 / 体积预算 |
| [tech-stack.md](./docs/tech-stack.md) | 技术栈选型与部署拓扑 |
| [testing.md](./docs/testing.md) | 测试规格：全链路集成（不含 LLM）与真实模型 E2E |
| [roadmap.md](./docs/roadmap.md) | MVP → 多选 → 协作 → 观测 → 运营 |
| [design-review.md](./docs/design-review.md) | 设计复盘记录：问题清单与处置 |

## 关键决策

| 议题 | 结论 |
|------|------|
| 多 agent | agent 是插件；内核不认识任何具体 agent，MVP 就要跑通两种形状 |
| 客户端协议 | 自有归一化模型，不让任何 agent 的线格式外泄成产品协议 |
| daemon | 自研 Rust 精简版，按 MVP 裁剪 |
| 默认 agent | 内置 Genet Agent，装完即可跑；用户已装的其他 agent 平级可选 |
| 前端 | 自研，复刻主流工作台约 60% 能力 |
| 传输 | 转发折进 Hub 同域部署，但按可拆分方式分模块；转发层永不解析 payload |
| 连接授权 | 自有机器端到端加密；租用走 Hub 执行通道（可撤销、可审计） |
| 分享链接 | 授予设备会话，一次性 + 短 TTL，不共享账号 |
| 安装包 | 下载 ≤ 80MB，安装后 ≤ 200MB |

## 代码

| 目录 | 状态 |
|------|------|
| `apps/agent` | 内置 Agent（Rust）—— **已可运行**，91 个测试通过 |
| `apps/daemon` | 会话内核 + adapter 层 —— 待实现 |
| `apps/hub` | control/ + forward/ —— 待实现 |
| `packages/web` | 自研工作台 —— 待实现 |
| `packages/proto` | 协议定义 —— 待实现 |

## 状态

当前聚焦 **MVP**（见 [roadmap.md](./docs/roadmap.md)）。
