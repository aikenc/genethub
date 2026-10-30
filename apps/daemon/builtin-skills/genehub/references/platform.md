# GeneHub 平台架构与原理

用户问 GeneHub 是什么、怎么工作、数据在哪、安不安全、能不能自建，或任务需要理解平台为什么这样设计时读本文。
它是开源仓文档的导读，**正本以仓库为准**：开源仓 <https://github.com/aikenc/genethub>，下文链接都指向 `main`。
`main` 可能比本机版本新；本机实际版本用 `"$GENEHUB_CLI" status` 看。回答时用用户的语言讲结论，附上对应链接，
不把目标说成已达成（每节的“现状”照实转述）。

## 1. 它是什么，为什么这样做

开源、local-first 的 Agent 工作台：每台电脑上常驻一个 daemon，持有工作区、进程与会话；桌面、浏览器、手机
只是经授权的操作界面。离开座位任务继续跑，换设备不换项目、不丢会话。

两个判断：人机之间的**带宽**会取代模型能力成为主要瓶颈；未发布作品、软件许可、本地模型和硬件都长在端侧，
**端侧生产力不会被 cloud-only 取代**。由此分三层，顺序不能颠倒：拥有 → 汇聚（多台机器与 Agent 成为一个
可指挥的整体）→ 带宽（作品本身成为界面）。四条承诺：资产不动、多机是常态、Agent 可替换、会话跟着人。

- [README：愿景与理念](https://github.com/aikenc/genethub#愿景与理念)

## 2. 部件与五条边界

一个常驻进程：原生 `genehub-host`（Wasmtime/WASI 与 OS 资源）装载 `genehub_guest.wasm`，业务全部在这份
WASM 里，没有原生回退。CLI `genet` 很薄，只把命令转给本机 daemon。跨设备经 Relay 中转，能直连时走 WebRTC。

| 边界 | 含义 |
|---|---|
| B1 Agent 是插件 | 内核不认识任何具体 Agent，知识只在各自 adapter 里 |
| B2 协议是产品资产 | daemon 对外只有一套与 Agent 无关的时间线与会话事件 |
| B3 一个 adapter 不算抽象 | 必须同时跑通形状截然不同的 Agent，抽象才算被证伪过 |
| B4 Relay 不理解内容 | 只搬加密字节，不解析、不落库、不做业务鉴权，由 CI 静态检查守住 |
| B5 业务更新不要求重装 | 目标是绝大多数改动只热更 WASM guest 与工作台，后台验签、切换、失败回滚 |

多会话编排也不在内核里：daemon 只给原语，“团队”是用户数据里的 Space 树和脚本（见第 6 节）。

- [架构总览 architecture.md](https://github.com/aikenc/genethub/blob/main/docs/architecture.md)（技术层最上层事实来源）
- [daemon 规格](https://github.com/aikenc/genethub/blob/main/docs/daemon.md)、[技术栈](https://github.com/aikenc/genethub/blob/main/docs/tech-stack.md)、[薄 CLI](https://github.com/aikenc/genethub/blob/main/docs/cli-thin-forwarder.md)
- 现状：B5 的 95% / 分钟级是目标，测量体系建立前不得说已达成；进度见 [roadmap.md](https://github.com/aikenc/genethub/blob/main/docs/roadmap.md)。

## 3. Agent 接入与会话

- **两种 adapter**：内置 GeneHub Agent 原生实现，保证永远有一个能用的 Agent；所有第三方 Agent（Codex、Cursor、
  Claude Code、CodeBuddy…）各是一个 Python 脚本目录，安装、登录、协议翻译都在脚本里，上游 CLI 变了改脚本即可，
  不用发版。用户自定义 Agent 就是多放一个目录。
- **统一时间线**：每家事件翻译成同一套 `TimelineItem`，前端不知道背后是哪个 Agent；没见过的工具落到 `Unknown`，
  永不丢事件。模型、思考强度、模式是三条独立的轴，界面只显示该 Agent 真支持的能力。
- **默认放权 + 持久暂停**：在 OS 账户权限内默认最高权限；仍需批准或回答时保存暂停点并结束当前进程，
  用户隔多久回来都能在同一会话继续，daemon 重启也不丢。
- **会话存在工作区里**：`<工作区>/.genethub/`（owner-only、自带 `.gitignore`），复制项目连历史一起走；
  布局“路径即索引”，读取成本只与要展示的内容成正比。

链接：[第三方 Agent](https://github.com/aikenc/genethub/blob/main/docs/third-party-agents.md) ·
[serve 线协议](https://github.com/aikenc/genethub/blob/main/docs/agent-serve-protocol.md) ·
[内置 Agent](https://github.com/aikenc/genethub/blob/main/docs/builtin-agent.md) ·
[会话存储](https://github.com/aikenc/genethub/blob/main/docs/session-storage.md) ·
[持久化目录](https://github.com/aikenc/genethub/blob/main/docs/storage-layout.md) ·
[平台 Python](https://github.com/aikenc/genethub/blob/main/docs/python-runtime.md)

## 4. 远程访问与安全

**完整 Agent 连接契约（2026-10-29）**：账号/设备认证通过且获准驱动完整 Agent，意味着具有目标
OS 用户的完整操作能力与资源访问能力。Agent 可以经工具间接运行命令、修改文件与其他项目，
普通文件/终端/会话接口不应再按项目、Agent 或设备分级制造另一套隔离。完整权限受实际 OS
边界约束；Session ID 用于归属，不通过冒充 Human 隐去来源。
仅展示分享、未认证入口、账号/机器不匹配、撤销与过期仍有明确边界。密钥不进入日志或未授权页面。
当前版本的旧 grants、Workflow 特例及跨项目检查仍须按实际返回说明，文档更新不等于代码已迁移。


- daemon 只监听本机，主动向外连 Relay；**谁能连这台机器由 daemon 的本地已授权设备表决定**，撤销即时生效。
- 每条连接先做双向 proof 再派生 AES-256-GCM 会话密钥；Relay 看得到 IP、时序、包大小，看不到内容。
- 断线续接：客户端掉线任务照跑，重连后补齐事件。
- **说实话**：托管部署的控制面会生成临时通道密钥，所以平台**不是零知识**；当前是对称 PSK，没有公钥握手和
  前向保密。可以说“Relay 拿不到内容密钥、不解析不落库”，不能说“平台技术上看不到”。
- **自建**：daemon + 无状态 Relay + 静态工作台三件就够，不需要官方账号系统。

链接：[安全模型](https://github.com/aikenc/genethub/blob/main/docs/security-model.md) ·
[端到端数据通道](https://github.com/aikenc/genethub/blob/main/docs/e2ee-data-plane.md) ·
[Relay](https://github.com/aikenc/genethub/blob/main/docs/relay.md) ·
[断线续接](https://github.com/aikenc/genethub/blob/main/docs/logical-connection-core.md) ·
[配对](https://github.com/aikenc/genethub/blob/main/docs/trusted-link-pairing.md) ·
[自建](https://github.com/aikenc/genethub/blob/main/docs/self-hosting.md)

## 5. 多机与预览

- **多机**：每台机器各自持有数据；`--machine <ID>` 把 shell、会话、`agent run`、文件下载派给持有资源的那台，
  而不是把数据搬过来。用法见同目录 [multi-machine.md](multi-machine.md)、[file-transfer.md](file-transfer.md)。
- **预览**：源机器有效目录名单内的普通文件（HTML、Markdown、图片、视频、WASM）由 daemon 按机器与绝对路径定位；名单自动包含已登记项目根，也可配置补充目录，仍受当前连接与分享范围约束。文件经加密通道送到
  任意已授权设备，HTML 在无同源权限的沙箱里运行；创作软件的实时画面走登记服务与原生媒体。用法见 Skill `genehub-preview`。

链接：[Asset Preview](https://github.com/aikenc/genethub/blob/main/docs/assets-quick-preview.md) ·
[服务与媒体预览](https://github.com/aikenc/genethub/blob/main/docs/service-preview.md) ·
[工作台](https://github.com/aikenc/genethub/blob/main/docs/web-workbench.md)

## 6. Space、Skill 与团队

- 目录里放一份 `agent-space.genet.json` 就是一个 Space；daemon 从数据目录的 `spaces/` 发现它们，父子只看目录。
  SpaceBuilder 把描述里的身份文件、Skill 和定时 hook 编译成各 Agent 原生读取的文件。
- 内置 Skill 是随包分发的普通文件，按会话列出，任务匹配时 Agent 自己去读。
- 团队 = Space 树 + 定时 hook + 系统通知 + 会话控制搭出来的接力队伍；内置的 1+N 团队只是可替换的样板，
  建出来就归用户。Workflow 是退役中的旧机制。用法见 Skill `genehub-team`，构建规则见 [spacebuilder.md](spacebuilder.md)。

链接：[团队机制](https://github.com/aikenc/genethub/blob/main/docs/teams.md) ·
[内置 Skill](https://github.com/aikenc/genethub/blob/main/docs/builtin-skills.md) ·
[已废弃与退役](https://github.com/aikenc/genethub/blob/main/docs/deprecated.md)

## 7. 工程约束与路线

改平台本身（而不是用它）时先读：[工程律法](https://github.com/aikenc/genethub/blob/main/docs/engineering-laws.md) ·
[工程指引](https://github.com/aikenc/genethub/blob/main/docs/engineering-guidance.md) ·
[测试](https://github.com/aikenc/genethub/blob/main/docs/testing.md) ·
[路线图](https://github.com/aikenc/genethub/blob/main/docs/roadmap.md)。
平台缺陷与建议提到仓库的 [Issues](https://github.com/aikenc/genethub/issues)；不要为绕过缺陷改动内置 Skill 或 daemon 文件，
重装会覆盖。
