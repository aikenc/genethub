# 技术栈选型

> 约束：所有客户端基于**同一套 Web UI**；PC 安装包尽量小；内置 daemon 与默认 agent；PC 端不依赖 Node 运行时。  
> 分层与边界以 [architecture.md](./architecture.md) 为准，本文只讲选型和理由。

---

## 1. 组合总览

```
packages/proto        ← 会话协议唯一定义处，生成 TS 类型与 Rust 结构
packages/frontdoor    ← 原生前门词汇：构建身份、磁盘布局与权限、生命周期、控制面证明
packages/identity     ← 协议世代常量，零依赖
packages/workbench          ← 工作台（浏览器 / 桌面 / 手机同一份产物）
apps/daemon           ← Rust：会话内核 + agent adapter 层 + 三种接入通道
apps/agent            ← Rust：内置 agent（adapter 的一个后端）
apps/guest            ← wasm32-wasip2 Component：daemon/agent 双入口
apps/host             ← 原生 Wasmtime/WASI 壳 + typed OS/RTC 连接资源
apps/desktop          ← Windows/macOS Tauri 2 壳 + host/guest sidecar
apps/relay            ← Node：转发层，可独立部署
testing/              ← 跨部件旅程测试
```

| 组件 | 技术 | 理由 |
|------|------|------|
| **桌面** | [Tauri 2](https://tauri.app/) | **UI 仍是 H5**，但走系统 WebView：拿到 Electron 的开发体验，不用背 Chromium + Node 的体积。壳本身几 MB，预算留给 sidecar |
| **手机** | 浏览器工作台 | 同一份 Web 产物直接使用，不在当前范围内维护 iOS / Android 原生壳 |
| **浏览器** | 同一 `packages/workbench` 直出 | 链接打开即用 |
| **daemon / 内置 agent** | Rust → WASM Component | 同一份 `genehub_guest.wasm` 的两个入口；业务变化不要求重编 host |
| **native host / CLI** | Rust + Wasmtime 48 | 装载 Component，提供 WASI 与 OS/RTC 连接边界；CLI 只转发产品 argv |
| **relay** | Node（TypeScript） | **仅服务端**；逻辑极薄（帧头 + 转发），换语言的收益要等到连接数受内存限制才出现 |
| **前端** | React + Vite + TS | 见 §1.1 与 [web-workbench.md](./web-workbench.md) §5 |

### 1.1 前端：自研而非 fork

原计划 fork 成熟工作台再魔改，纪律是"只碰主题、导航、鉴权"。协议自研之后这条纪律不可能守住——fork 来的前端说的是别人的协议，改动会一路扩散到会话层。改为自研，按 [web-workbench.md](./web-workbench.md) 的清单复刻主要能力。完整论证见 [architecture.md](./architecture.md) §7。

---

## 2. 桌面端内部结构

```
安装包（Windows NSIS · macOS dmg；Linux 不生成桌面包）
├── Tauri WebView → 工作台
├── sidecar: genehub-host + genehub_guest.wasm（daemon 入口；关窗后仍运行）
├── genet（生命周期与 /cli 薄转发器）
├── 内置 agent：新 host 进程装载同一 guest 的 agent 入口
├── 系统托盘：打开主界面 / 状态 / 退出
└── 默认配置：本机直连，无需任何服务端
```

**PC 端零 Node 运行时是硬约束**，但它禁的是运行时进程，不是技术栈：窗口内容依然是 `packages/workbench` 那套 H5，只是跑在系统 WebView 而不是 Node 上。Node 只允许出现在构建期（前端打包、tauri-cli）与服务端（relay）。约束细则与验收方式见 [desktop-client.md](./desktop-client.md) §4.1–4.2。

---

## 3. 关键内部边界

| 边界 | 做法 |
|------|------|
| daemon 内核 ↔ 具体 agent | 只经 adapter trait；内核不出现任何 agent 名字的分支 |
| daemon ↔ 前端 | 只走归一化会话协议；agent 的线格式不外泄 |
| relay ↔ 控制面 | 版本化 Fabric HTTP 契约，只定义在 `apps/relay/src/contract/fabric-wire.ts` 并由 Cloud 镜像 |
| 桌面壳 ↔ daemon | 进程分离，本地 WS 通信，不做进程内链接 |
| 前端 ↔ 宿主 | 只经 `packages/workbench/src/host/`，业务组件不出现 `if (isTauri)` |
| 协议定义 | 只在 `packages/proto`，前后端都从这里生成 |

共同点：**每一条都对应一次可能的替换**——换 agent、换前端、换中转、换壳。边界守住了，替换就是替换；守不住就是重写。

---

## 4. 三种 carrier，一套 DataEndpoint

| 路径 | 何时用 | 代价 |
|------|--------|------|
| loopback WebSocket | 桌面壳内 | 无公网依赖 |
| `/fabric/v2` WSS baseline | 任何跨设备访问，包括同一个 Wi-Fi | 多一跳；托管模式需要 Control admission |
| WebRTC DataChannel direct | baseline 已认证、双方启用且 ICE 可达 | 少一跳；MVP 无 TURN，不能保证成功 |

daemon 跑在 wasm component 里时，前两条由 guest 自己开 socket，`wasi:tls` 在壳里做 WSS 握手。RTC 也已按层落地：host 只做 ICE/DTLS/SCTP 连接与有界二进制收发，guest 保留 admission、权限、超时和 Fabric baseline 回落策略。见 [wasm-guest-network.md](./wasm-guest-network.md)。

三者承载同一 protocol-v3 E2EE record、logical streams 和 Exchange。跨设备始终先有 Fabric baseline，再通过加密 signaling 建立 RTC；RTC 失败时 baseline 继续可用。没有 live stream migration 或请求自动重放。断网时仍可在运行 daemon 的同一台电脑上使用桌面端。

---

## 5. 部署形态

| 形态 | 需要跑什么 |
|------|-----------|
| 只在自己电脑上用 | 桌面端。没有服务端 |
| 家里几台机器互访 | 桌面端 + relay（即使在同一局域网） |
| 在外面访问家里 | 加一个 relay + 一个控制面，见 [self-hosting.md](./self-hosting.md) |

**托管工作台静态文件的机器上不跑 daemon**，理由见 [security-model.md](./security-model.md) §6。

---

## 6. MVP 技术切片

按 [architecture.md](./architecture.md) §9 的顺序：

1. `packages/proto`：会话协议定稿，生成两端类型
2. `apps/daemon`：会话内核 + `genet` adapter + 本地 WS
3. `packages/workbench`：工作台骨架（会话流、工具渲染、输入区）
4. `apps/daemon`：`acp` 与 `opencode` adapter —— 用另外两种形状证伪抽象
5. `apps/relay` + 配对：出站长连接、票据、转发
6. `apps/desktop`：Tauri 壳 + sidecar + 托盘
7. 串联与验收：装 → 跑一条任务 → 换设备打开，按 [testing.md](./testing.md) 走集成与 E2E
