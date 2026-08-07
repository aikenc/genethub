# GeneHub

在自己的机器上跑 coding agent，从任何设备安全地用它。

在 Windows 或 macOS 装桌面端，或者在 Linux 装 daemon/CLI，你的电脑就成了一台可以远程使用的开发机：在电脑前用它，出门用手机接着用，中途换设备不丢上下文。代码、密钥和执行全部留在你自己的机器上。Linux 不提供桌面壳，工作台直接在浏览器里打开。

---

## 它由四部分组成

| 部件 | 是什么 |
|------|--------|
| **daemon**（Rust） | 常驻在你机器上的唯一进程：会话、文件、git、终端，以及按需拉起 agent |
| **agent**（Rust） | 内置的 coding agent，装完即可用。你已经装了别的（OpenCode、Cursor CLI…）也能直接选 |
| **relay**（Node） | 你人在外面时的汇合点。它只搬字节，不解析、不落库，可以自己部署 |
| **workbench**（前端） | 一份代码跑在浏览器、桌面和手机上 |

不需要 relay 也能用：在电脑前由桌面端或 CLI 通过 loopback 直连；跨设备统一走 relay，不在局域网暴露明文的高权限 WebSocket。

## 装上就用

**Linux 与任何没有图形界面的机器**（服务器、VM、只能 SSH 上去的盒子）：

```bash
curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL https://raw.githubusercontent.com/aikenc/genethub/main/scripts/install.sh | sh
genet daemon run   # daemon + 内置 agent，不需要 Node；启动后打印一次性连接地址（genet 同时也是 CLI）
```

预编译包是 **musl 静态链接**的，不依赖宿主机 glibc 版本。把它打印的地址在浏览器里打开就是完整工作台——和桌面端里的是同一份代码。

**Windows**：从[发布页](https://github.com/aikenc/genethub/releases/latest)手动下载安装包并核对 `SHA256SUMS`，托盘常驻，
关掉窗口机器照样可达。

macOS 这一版没有发布产物（等签名与公证），从源码构建可用。

## 从源码构建

```bash
cargo build --release -p genet-cli -p genet-agent       # CLI/守护进程（同一二进制）与内置 agent
cd packages/web && npm install && npm run build        # 工作台
cd apps/desktop && ./scripts/bundle.mjs                 # Windows/macOS 桌面安装包
```

自建 relay 见 [self-hosting.md](./docs/self-hosting.md)。发布产物由 `.github/workflows/release.yml` 在打 tag 时构建：当前发布 Windows 安装包，以及各 CLI 目标的 `genet-<os>-<arch>.tar.gz`，并附 `SHA256SUMS`（`scripts/install.sh` 校验不过就拒绝首次安装）。摘要与产物同源，不能替代独立签名；在签名根落地前，daemon、桌面壳和 `genet update` 的自动下载/执行入口均失败关闭，更新需从官方发布页手动完成。macOS 桌面端源码可构建，正式安装包等待签名与公证；Linux 只发布 daemon/CLI，不发布桌面安装包。

**发一个版本就是打一个 tag**，仓库里没有要跟着改的版本号：`git tag v0.1.18 && git push --tags`。产品版本号只存在于 tag 上，流水线构建前用 `scripts/version.mjs` 把它写进 Cargo 和安装包配置，构建完再拿真产物核对一遍（发布产物里 `genet --version` 必须等于 tag）。所以从源码构建出来的那份自称 `0.0.0`（二进制叫 `genet-dev`，树默认走 dev 轨），界面上显示"开发版"，也不会被催升级——它确实不是任何一个发布版本。

发 Beta 就是打一个带 prerelease 后缀的 tag：`git tag v0.4.0-beta.1 && git push origin v0.4.0-beta.1`。流水线按 tag 形态分流——`vX.Y.Z` 发正式线，`vX.Y.Z-beta.N` 发 Beta 线（prerelease，资产名带 `-beta`，默认连 `relay-beta.genethub.com`），两线并装并跑互不干扰（`genethub-cloud/docs/dual-channel-release.md`）。Beta 号段必须大于最新正式版号段：正式已到 `0.3.x` 时，Beta 从 `0.4.0-beta.1` 起。

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
| [e2ee-data-plane.md](./docs/e2ee-data-plane.md) | protocol v3：logical streams、E2EE、Fabric baseline 与 WebRTC direct |
| [assets-quick-preview.md](./docs/assets-quick-preview.md) | workspace-relative、≤4 MiB、完整 Markdown 与 Agent 产物链接的轻量 Preview |
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
| 转发 | Relay 只有 endpoint-neutral `/fabric/v2`，不解析 E2EE payload、不落库、可自建 |
| 身份 | 自建最终准入由每台 daemon 的配对设备表判断；托管 Control 只发行短期 opaque Fabric/peer admission |
| 连接 | 每个主动请求使用独立 logical stream；跨设备先走 E2EE Fabric baseline，网络允许时新请求优先 WebRTC direct |
| 加密现状 | protocol v3 完成 PSK 双向 proof 后，业务 record 使用带严格方向序号与 AAD 的 AES-256-GCM；HMAC 用于握手/派生。Relay 只见路由和流量元数据及初始有界 peer hello。托管 Control 生成 peer secret，尚无公钥握手、前向保密或“整个平台零知识”，见 [security-model.md](./docs/security-model.md) |
| 安装包 | 下载 ≤ 80MB，安装后 ≤ 200MB，PC 端不依赖 Node 运行时 |

## 代码

| 目录 | 状态 |
|------|------|
| `apps/daemon` | 会话内核 + adapter 层 |
| `apps/agent` | 内置 agent |
| `apps/relay` | 转发层 |
| `apps/desktop` | 仅 Windows/macOS 的 Tauri 桌面壳；复用 Web 工作台 |
| `packages/web` | 工作台前端 |
| `packages/proto` | 协议定义，生成 TS 与 Rust 类型 |
| `testing/` | 跨部件旅程测试 |

## 许可

AGPL-3.0-or-later，整仓一致。
