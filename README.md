# GeneHub

在自己的机器上跑 coding agent，从任何设备安全地用它。

装一个桌面端，你的电脑就成了一台可以远程使用的开发机：在电脑前用它，出门用手机接着用，中途换设备不丢上下文。代码、密钥和执行全部留在你自己的机器上。

---

## 它由四部分组成

| 部件 | 是什么 |
|------|--------|
| **daemon**（Rust） | 常驻在你机器上的唯一进程：会话、文件、git、终端，以及按需拉起 agent |
| **agent**（Rust） | 内置的 coding agent，装完即可用。你已经装了别的（OpenCode、Cursor CLI…）也能直接选 |
| **relay**（Node） | 你人在外面时的汇合点。它只搬字节，不解析、不落库，可以自己部署 |
| **workbench**（前端） | 一份代码跑在浏览器、桌面和手机上 |

不需要 relay 也能用：在电脑前是本机直连，同一个 Wi-Fi 下是局域网直连。

## 装上就用

**Linux 与任何没有图形界面的机器**（服务器、VM、只能 SSH 上去的盒子）：

```bash
curl -fsSL https://raw.githubusercontent.com/aikenc/genethub/main/scripts/install.sh | sh
genet-daemon   # daemon + 内置 agent，不需要 Node；启动后打印连接地址与 token
```

把它打印的地址在浏览器里打开就是完整工作台——和桌面端里的是同一份代码。

**Windows**：从[发布页](https://github.com/aikenc/genethub/releases/latest)下安装包，托盘常驻，
关掉窗口机器照样可达。

macOS 这一版没有发布产物（等签名与公证），从源码构建可用。

## 从源码构建

```bash
cargo build --release -p genet-daemon -p genet-agent   # 守护进程与内置 agent
cd packages/web && npm install && npm run build        # 工作台
cd apps/desktop && ./scripts/bundle.sh                 # 桌面安装包
```

自建 relay 见 [self-hosting.md](./docs/self-hosting.md)。发布产物由 `.github/workflows/release.yml` 在打 tag 时构建：每个平台各出一个安装包，另出一份 `genet-<os>-<arch>.tar.gz` 供上面那条命令使用，附 `SHA256SUMS`（`scripts/install.sh` 校验不过就拒绝安装）。

## 文档

先读 [architecture.md](./docs/architecture.md)，它是最上层的事实来源，其他文档与它冲突时以它为准。

| 文档 | 内容 |
|------|------|
| [architecture.md](./docs/architecture.md) | **分层与边界**：多 agent 适配、归一化事件模型、传输取舍、演进顺序 |
| [daemon.md](./docs/daemon.md) | 会话内核：模块划分、客户端协议、会话存储、审批 |
| [builtin-agent.md](./docs/builtin-agent.md) | 内置 agent：RPC 契约、agent loop、provider、技能、会话 |
| [relay.md](./docs/relay.md) | 转发层：帧格式、契约、限额、它为什么什么都不知道 |
| [web-workbench.md](./docs/web-workbench.md) | 工作台：能力边界、四个宿主、移动端 |
| [desktop-client.md](./docs/desktop-client.md) | 桌面端：安装、托盘、后台、体积预算 |
| [security-model.md](./docs/security-model.md) | 信任边界、凭证与撤销、加密现状 |
| [self-hosting.md](./docs/self-hosting.md) | 自建：全部自己跑，或只跑 relay |
| [tech-stack.md](./docs/tech-stack.md) | 技术选型与部署拓扑 |
| [testing.md](./docs/testing.md) | 测试矩阵：跨部件集成与真实模型 E2E |
| [roadmap.md](./docs/roadmap.md) | MVP → 多 agent → 协作 → 端到端加密 |
| [design-review.md](./docs/design-review.md) | 设计复盘：问题清单与处置 |

## 关键决策

| 议题 | 结论 |
|------|------|
| 多 agent | agent 是插件；内核不认识任何具体 agent，MVP 就要跑通两种形状 |
| 客户端协议 | 自有归一化模型，不让任何 agent 的线格式外泄成产品协议 |
| 前端 | 一份产物跑四个宿主，宿主差异收敛在 `packages/web/src/host/` |
| 转发 | relay 独立成服务，不解析 payload、不落库、可自建 |
| 身份 | 本仓不需要账号：准入由每台机器自己判，配对时发一份设备凭证。relay 只按 id 撮合两条连接 |
| 加密现状 | 传输层加密；端到端加密尚未实现，见 [security-model.md](./docs/security-model.md) |
| 安装包 | 下载 ≤ 80MB，安装后 ≤ 200MB，PC 端不依赖 Node 运行时 |

## 代码

| 目录 | 状态 |
|------|------|
| `apps/daemon` | 会话内核 + adapter 层 |
| `apps/agent` | 内置 agent |
| `apps/relay` | 转发层 |
| `apps/desktop` | Tauri 壳，桌面与移动端共用 |
| `packages/web` | 工作台前端 |
| `packages/proto` | 协议定义，生成 TS 与 Rust 类型 |
| `testing/` | 跨部件旅程测试 |

## 许可

AGPL-3.0-or-later，整仓一致。
