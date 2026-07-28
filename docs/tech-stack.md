# GeneHub 技术栈选型

> 约束：所有客户端基于**同一套 Web UI**；PC 安装包尽量小（150MB 量级可接受）；内置 daemon 与默认 agent；能扫码、深链。  
> 分层与边界以 [architecture.md](./architecture.md) 为准，本文只讲选型和理由。

---

## 1. 组合总览

```
packages/proto        ← 会话协议唯一定义处，生成 TS 类型与 Rust 结构
packages/web          ← 自研工作台（浏览器 / 桌面 / 手机同一份产物）
apps/daemon           ← Rust：会话内核 + agent adapter 层 + 三种接入通道
apps/agent            ← Rust：内置 Genet Agent（adapter 的一个后端）
apps/desktop          ← Tauri 2 壳 + sidecar（daemon）
apps/mobile           ← Capacitor 壳（iOS/Android，扫码/深链）
apps/hub              ← control/（账号·机器目录·租用）+ forward/（转发层）
```

| 组件 | 技术 | 理由 |
|------|------|------|
| **PC Desktop** | [Tauri 2](https://tauri.app/) | **UI 仍是 H5**，但走系统 WebView：拿到 Electron 的开发体验，不用背 Chromium + Node 的体积。壳本身几 MB，预算留给 sidecar |
| **Mobile** | [Capacitor](https://capacitorjs.com/) | 同一 Web 资源打进 iOS/Android；扫码、深链成熟 |
| **浏览器** | 同一 `packages/web` 直出 | 一次性链接打开即用 |
| **daemon** | Rust | 单文件二进制 < 20MB，无运行时依赖；替掉 Node 方案后安装包大头消失 |
| **内置 Agent** | Rust | 与 daemon 同栈；< 15MB；协议自实现 |
| **Hub** | Node（TypeScript）起步 | **仅服务端**；与前端同栈、迭代快，并发压力上来再换 Go |
| **前端** | React + Vite + TS | 见 §1.1 与 [web-workbench.md](./web-workbench.md) §5 |

### 1.1 前端：自研而非 fork（决策已变更）

原计划 fork 成熟工作台再魔改，纪律是"只碰主题、导航、鉴权"。协议自研之后这条纪律不可能守住——fork 来的前端说的是别人的协议，改动会一路扩散到会话层。改为自研，按 [web-workbench.md](./web-workbench.md) 的清单复刻约 60% 能力。完整论证见 [architecture.md](./architecture.md) §7。

---

## 2. Desktop 内部结构

```
GeneHub 安装包（NSIS/WiX · dmg · AppImage）
├── Tauri WebView → GeneHub 工作台
├── sidecar: genet-daemon（关窗后仍运行）
├── genet-agent（由 daemon 的 genet adapter 按需拉起）
├── 系统托盘：打开主界面 / 状态 / 退出
└── 默认配置：Hub 地址（转发层同域）
```

体积构成因为两个进程都换成 Rust 而大幅简化：不再需要随包携带 Node 运行时与上百兆 `node_modules`。

**PC 端零 Node 运行时是硬约束**，但它禁的是运行时进程，不是技术栈：窗口内容依然是 `packages/web` 那套 H5，只是跑在系统 WebView 而不是 Node 上。Node 只允许出现在构建期（前端打包、tauri-cli）与服务端（Hub）。约束细则、双宿主适配与验收方式见 [desktop-client.md](./desktop-client.md) §4.1–4.2。

---

## 3. 认证与接力

| 机制 | 用途 |
|------|------|
| 临时用户 + 恢复密钥 | 「先体验」，且不会因清缓存丢失机器 |
| 设备码授权 | 把这台 PC 绑到账号 |
| 一次性设备会话链接 / 二维码 | 换设备、手机接手 |
| 邮箱 Magic Link / GitHub OAuth | 升级正式账号 |
| 设备 refresh token | 「信任此设备」 |

深链：

```text
https://app.genethub.com/link/<token>   # Web 打开 → 建立本设备会话
genethub://auth/<token>                 # Desktop / Mobile 深链
```

安全规则（一次性、TTL、二次确认、指纹核对）以 [security-model.md](./security-model.md) 为准。

---

## 4. 关键内部边界

| 边界 | 做法 |
|------|------|
| daemon 内核 ↔ 具体 agent | 只经 adapter trait；内核不出现任何 agent 名字的分支 |
| daemon ↔ 前端 | 只走归一化会话协议；agent 的线格式不外泄 |
| Hub control ↔ forward | 单向依赖 + 可远程化接口，规则见 [architecture.md](./architecture.md) §6.4 |
| 桌面壳 ↔ daemon | 进程分离，本地 WS 通信，不做进程内链接 |
| 协议定义 | 只在 `packages/proto`，前后端都从这里生成 |

前四条的共同点：**每一条都对应一次可能的替换**——换 agent、换前端、拆服务、换壳。边界守住了，替换就是替换；守不住就是重写。

---

## 5. 语言演进路线

| 对象 | 现状 | 备注 |
|------|------|------|
| 内置 Agent | **Rust，已落地** | `apps/agent`，见 [builtin-agent.md](./builtin-agent.md) |
| daemon | **Rust，本期落地** | 自研精简版，见 [daemon.md](./daemon.md) |
| Hub | Node | 并发或部署密度需要时换 Go |
| 前端 | React | 无迁移计划 |

原本"长期考虑用 Go/Rust 自建 daemon"的条目已经提前执行完毕，触发原因不是体积，而是**协议自主**：既然要接多种 agent、要自有归一化模型，daemon 本来就得重写。

---

## 6. 部署拓扑

| 域名 | 内容 | 状态 |
|------|------|------|
| `genethub.com` | 官网 / 下载页 | 规划 |
| `app.genethub.com` | 工作台 + Hub API + `/relay/ws` 转发端点 | 规划 |
| `relay.genethub.com` | 旧的独立中转 | 已上线，MVP 后下线 |
| 旧的过渡工作台域名 | 过渡期静态托管 | 已上线，自研工作台上线后下线 |

转发折进 `app.genethub.com` 之后只需维护一个域名一套证书；两个旧域名都是过渡产物，保留到迁移完成为止。

**托管 Web 的机器上不跑 daemon**，理由见 [security-model.md](./security-model.md) §7。

---

## 7. MVP 技术切片

按 [architecture.md](./architecture.md) §9 的顺序：

1. `packages/proto`：会话协议定稿，生成两端类型
2. `apps/daemon`：会话内核 + `genet` adapter + 本地 WS
3. `packages/web`：工作台骨架（会话流、工具渲染、输入区）
4. `apps/daemon`：`acp` adapter —— 用第二种 agent 形状证伪抽象
5. `apps/hub`：control + forward 双模块；设备码授权、机器目录、一次性链接
6. `apps/desktop`：Tauri 壳 + sidecar + 托盘
7. 串联与验收：装 → 先体验 → 跑一条任务 → 换设备打开，按 [testing.md](./testing.md) 走集成与 E2E

Mobile 放 M2，与同一 Web 构建对接扫码。
