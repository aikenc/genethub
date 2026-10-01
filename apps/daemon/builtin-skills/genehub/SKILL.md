---
name: genehub
description: GeneHub 通用能力入口与多机协作指南。用于：了解 GeneHub 工作台、机器、workspace、Agent 会话与 CLI；多机协作——查看机器目录、配对与授权、用 --machine 远程执行命令（shell）、在其他机器启动或续接 Agent 会话；daemon 启动/停止/重启/离线恢复/环境生效；实时联调页面（网页白屏、DOM、截图、手机复现）；测试、安装或诊断本地语音识别 runtime（Qwen3-ASR）。静态与实时预览读 genehub-preview，会话历史读 genehub-introspect。不是通用软件开发流程。
---

# GeneHub 使用入口

GeneHub 是端侧多机器 Agent 的 hub：每台机器上的 daemon 持有自己的工作区、进程和会话，工作台与 CLI
只是经授权的操作界面。多机是常态，本机只是延迟最低的一项。浏览器所在设备、对话所在工作区与实际执行机器
可以不同；用户无需因为远程执行而迁移对话。PipeSpace 提供项目角色和流程，不是另一台机器。

## 身份不能互换

| 身份 | 含义 | 选择方式 |
|---|---|---|
| 机器 | 一台运行 daemon 的电脑 | `--machine <精确 ID>`，取自 `machine list`；省略即本机 daemon；不接受名称或前缀 |
| workspace | 机器上的一个项目目录 | `--workspace <id>` 或 `--cwd <绝对路径>`，均不会被推断 |
| session | 某台机器上的一次 Agent 会话 | 会话 ID，随会话所在机器解析 |
| client | 一个已接入联调的页面实例 | `client list` 返回的 `clientId` |

按具体命令返回的字段选择，不用一种身份代替另一种。同一台本机在 `context` 里的 `machineId` 与 Hub 目录里
的 `mch_…` 可能不同；跨机命令只用 `machine list` 给出的值。

## 多机协作要点

- 先 `context` 确认当前连接到哪台机器；`machine list --reachable` 看机器目录。**列出、在线都不等于
  当前身份能到达**：不可达会返回 `machineNotPaired`，据此报告并请用户处理，不要换身份或猜别的路径。
- 可路由到其他机器：`context`、`shell`、`workspace`、`session`、`agent`（含 `agent run`）、`device`、
  `client`。只能在本机：`workflow`、`process`、`machine`、`speech`、`daemon` 生命周期、`update`。
- 配对、`device invite`、授权范围属于授权变更，只在用户明确要求时执行；授权只给所需最小范围，不要生成
  不限范围的设备，也不要把邀请链接或码贴进聊天以外的地方。
- 数据留在所属机器：不要为了“方便”把工作区或密钥搬到别的机器；把任务派给持有资源的那台机器。

细节、命令形态和排障见 [multi-machine.md](references/multi-machine.md)。

## 按任务导航

| 任务 | 读什么 |
|---|---|
| 跨机器执行命令、派发或续接 Agent、配对与授权 | [multi-machine.md](references/multi-machine.md) |
| daemon 启动、停止、重启、环境生效、离线恢复 | [daemon.md](references/daemon.md)，重启前必读 [daemon-restart.md](references/daemon-restart.md) |
| 实时联调页面：白屏、DOM、交互、截图、移动端复现 | [client-debug.md](references/client-debug.md) |
| 本地语音识别 runtime：测试、安装、登记、诊断、移除 | [speech-runtime.md](references/speech-runtime.md) |
| 静态 H5、站点、相册，或影视/DCC/引擎的创作过程预览 | Skill `genehub-preview` |
| 会话历史、转发会话、来源引用 | Skill `genehub-introspect` |
| 产品反馈修复或 Beta 发布 | 当前 Space 选中的领域 Skill；没有时说明缺口，不凭本文执行发布 |

## 动手前的门禁

- **重启 daemon 会切断连接**：解释用法不等于授权重启；重启前必须验证存在独立的恢复连接，并读完
  daemon-restart.md。
- **本地语音 runtime 会改机器**：用户批准确切方案之前，不下载、不安装、不登记、不启动服务。
- **页面联调需要目标页面本地授权**：对话中的同意不能代替页面上的限时授权。

## CLI 发现

所有命令使用 `GENEHUB_CLI` 的绝对路径，沿用渠道；缺绑定就停止，不猜可执行名。先用 `capabilities`、
`schema <命令>` 核对实际语法，`context` 核对目标机器。`--help` 与 schema 只说明语法，不授予权限。
按会话提供的内置 Skill 目录定位文件，不硬编码安装目录；只读取与任务相关的引用，不必一次读完。
