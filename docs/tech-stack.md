# 技术栈选型

> 约束：所有客户端基于**同一套 Web UI**；PC 安装包尽量小；内置 daemon 与默认 agent；PC 端不依赖 Node 运行时。  
> 分层与边界以 [architecture.md](./architecture.md) 为准，本文只讲选型和理由。

---

## 1. 组合总览

```
packages/proto        ← 会话协议唯一定义处，生成 TS 类型与 Rust 结构
packages/web          ← 工作台（浏览器 / 桌面 / 手机同一份产物）
apps/daemon           ← Rust：会话内核 + agent adapter 层 + 三种接入通道
apps/agent            ← Rust：内置 agent（adapter 的一个后端）
apps/desktop          ← Tauri 2 壳 + sidecar（daemon），桌面与移动端共用
apps/relay            ← Node：转发层，可独立部署
testing/              ← 跨部件旅程测试
```

| 组件 | 技术 | 理由 |
|------|------|------|
| **桌面** | [Tauri 2](https://tauri.app/) | **UI 仍是 H5**，但走系统 WebView：拿到 Electron 的开发体验，不用背 Chromium + Node 的体积。壳本身几 MB，预算留给 sidecar |
| **手机** | Tauri Mobile | 同一份 Web 产物打进 iOS / Android，与桌面共用壳代码，不再多养一个框架 |
| **浏览器** | 同一 `packages/web` 直出 | 链接打开即用 |
| **daemon** | Rust | 单文件二进制，无运行时依赖 |
| **内置 agent** | Rust | 与 daemon 同栈；协议自实现 |
| **relay** | Node（TypeScript） | **仅服务端**；逻辑极薄（帧头 + 转发），换语言的收益要等到连接数受内存限制才出现 |
| **前端** | React + Vite + TS | 见 §1.1 与 [web-workbench.md](./web-workbench.md) §5 |

### 1.1 前端：自研而非 fork

原计划 fork 成熟工作台再魔改，纪律是"只碰主题、导航、鉴权"。协议自研之后这条纪律不可能守住——fork 来的前端说的是别人的协议，改动会一路扩散到会话层。改为自研，按 [web-workbench.md](./web-workbench.md) 的清单复刻主要能力。完整论证见 [architecture.md](./architecture.md) §7。

---

## 2. 桌面端内部结构

```
安装包（NSIS/WiX · dmg · AppImage）
├── Tauri WebView → 工作台
├── sidecar: genet daemon run（CLI 与 daemon 同一二进制；关窗后仍运行）
├── genet-agent（由 daemon 的 genet adapter 按需拉起）
├── 系统托盘：打开主界面 / 状态 / 退出
└── 默认配置：本机直连，无需任何服务端
```

**PC 端零 Node 运行时是硬约束**，但它禁的是运行时进程，不是技术栈：窗口内容依然是 `packages/web` 那套 H5，只是跑在系统 WebView 而不是 Node 上。Node 只允许出现在构建期（前端打包、tauri-cli）与服务端（relay）。约束细则与验收方式见 [desktop-client.md](./desktop-client.md) §4.1–4.2。

---

## 3. 关键内部边界

| 边界 | 做法 |
|------|------|
| daemon 内核 ↔ 具体 agent | 只经 adapter trait；内核不出现任何 agent 名字的分支 |
| daemon ↔ 前端 | 只走归一化会话协议；agent 的线格式不外泄 |
| relay ↔ 控制面 | 四个 HTTP 端点，定义在 `apps/relay/src/contract/wire.ts` |
| 桌面壳 ↔ daemon | 进程分离，本地 WS 通信，不做进程内链接 |
| 前端 ↔ 宿主 | 只经 `packages/web/src/host/`，业务组件不出现 `if (isTauri)` |
| 协议定义 | 只在 `packages/proto`，前后端都从这里生成 |

共同点：**每一条都对应一次可能的替换**——换 agent、换前端、换中转、换壳。边界守住了，替换就是替换；守不住就是重写。

---

## 4. 三条连接路径

| 路径 | 何时用 | 代价 |
|------|--------|------|
| `127.0.0.1` | 桌面壳内，最常见 | 无 |
| 局域网直连 | 同一个 Wi-Fi 的手机或另一台电脑 | 需要知道内网地址 |
| 经 relay | 人在外面 | 多一跳；需要一个控制面来签发票据 |

客户端按这个顺序尝试，对用户不可见。前两条不需要任何服务端，这也是"不联网也能用"成立的原因。

---

## 5. 部署形态

| 形态 | 需要跑什么 |
|------|-----------|
| 只在自己电脑上用 | 桌面端。没有服务端 |
| 家里几台机器互访 | 桌面端 + 局域网直连 |
| 在外面访问家里 | 加一个 relay + 一个控制面，见 [self-hosting.md](./self-hosting.md) |

**托管工作台静态文件的机器上不跑 daemon**，理由见 [security-model.md](./security-model.md) §6。

---

## 6. MVP 技术切片

按 [architecture.md](./architecture.md) §9 的顺序：

1. `packages/proto`：会话协议定稿，生成两端类型
2. `apps/daemon`：会话内核 + `genet` adapter + 本地 WS
3. `packages/web`：工作台骨架（会话流、工具渲染、输入区）
4. `apps/daemon`：`acp` 与 `opencode` adapter —— 用另外两种形状证伪抽象
5. `apps/relay` + 配对：出站长连接、票据、转发
6. `apps/desktop`：Tauri 壳 + sidecar + 托盘
7. 串联与验收：装 → 跑一条任务 → 换设备打开，按 [testing.md](./testing.md) 走集成与 E2E
