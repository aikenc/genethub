# 第三方 Agent 接入

> 设计与取舍：[agent-script-adapters-proposal.md](./agent-script-adapters-proposal.md)。
> 线协议：[agent-serve-protocol.md](./agent-serve-protocol.md)。
> 边界 B1 不变：daemon 里不出现任何具体 Agent 的名字、命令、参数、协议或登录方式。

---

## 1. 原则

- **第三方 Agent 全部是脚本目录。** 每个 Agent 一个目录，目录名就是 Agent id。daemon 只读 `agent.genet.json`，
  用自己的 Python 以隔离模式拉起 `agent.py serve`，按协议收发 JSON-RPC。怎么安装、怎么登录、怎么判断登录态、
  怎么拉起 CLI、怎么翻译事件，全部写在目录里的 Python 中。
- **内置 Agent 不走脚本层。** 它的协议是我们自己定的，没有追上游的问题；它保持原生实现，保证永远有一个能用的
  Agent 去修别的。
- **默认最高权限启动，异常授权是持久化暂停点。** 这条规则不变，具体放权参数写在各 Agent 的脚本里
  （见第 3 节）。会话里的权限请求和提问仍是 `permissionRequested` 会话事件，暂停与恢复机制不变。
- **用户可以长期不回复。** 按 [architecture.md](./architecture.md) §3.4，问题和恢复信息保存后停止当前执行及会话子进程，不保留等待回答的 RPC 或连接。用户回来回答时开启新执行，继续同一 Session / 用户 round；正常退出保留待答状态，主动取消或关闭会话结束恢复义务。
- **用户不执行 CLI。** 安装、登录、更新都是脚本声明的动作，在工作台点按钮完成；需要人决定或输入的内容
  （确认安装、登录链接、设备码、API key）通过 Agent 级用户请求只交给人，不进时间线、不进模型、不进日志。

**持久动作入口：** 安装确认及 Codex API Key 输入已使用 `ctx.ask`：先保存非秘密准备记录、取得短确认，再结束当前动作并确认其进程组及孙进程退出，之后展示请求。回答通过新执行恢复；停止中断和外部结果未知保留记录，不盲目重放。旧 `ctx.request` 保留内存式兼容，用户脚本需迁移。账号授权是「活」卡片：Agent 用 SDK 的 `login.link_login` 启动登录进程，卡片显示授权链接，授权完成、取消、10 分钟超时或 Agent/daemon 退出时进程和卡片一起结束，不留过期链接；API Key 走持久密码卡片，用 `credentials` 保存并以环境变量交给 CLI。参见 [线协议](./agent-serve-protocol.md) 和提案 §16.7。

## 2. 目录

```
<渠道数据目录>/agents/
  builtin/<id>/   随 daemon 发布，启动时物化，只读
  user/<id>/      用户或 Agent 新建、或从 builtin 复制出来改的；同名时整体覆盖 builtin
  state/<id>/     脚本自己的持久状态（安装前缀、目录缓存）；reset 时保留
  sdk/            boot.py 与 genehub_agent
  runtime/        Python 安装脚本和它装的 Python
```

源码位置：`apps/daemon/builtin-agents/`（`agents/`、`sdk/`、`runtime/`），构建时编进组件，
随 Live Release 更新。

改动只通过 `genet agent reload <id>` 生效；`genet agent reset <id>` 删除 `user/<id>`。
连续启动失败的本地覆盖版本会被临时搁置，退回内置版本。

## 3. 第一期内置的 Agent

| id | 会话协议 | 安装 | 登录 | 默认放权 |
|---|---|---|---|---|
| `codex` | `codex app-server` JSON-RPC，每个会话一个 app-server | npm 装进 `state/codex/npm` | 账号：卡片显示授权链接（设备码一并显示），在自己的浏览器完成；也可用 API Key（密码框） | `approval_policy="never"` + `sandbox_mode="danger-full-access"` |
| `cursor` | 每轮一个 `cursor-agent` print 进程，stream-json | 官方安装脚本（curl / irm） | 账号：卡片显示授权链接；也可用 API Key（密码框） | `--force --sandbox disabled --trust --approve-mcps` |
| `claude` | Claude 协议 stream-json，每个会话一个常驻 `claude` 进程（`claude_family`） | npm 装进 `state/claude/npm` | 账号：选 Claude 订阅或 Console，卡片显示授权链接并有授权码输入框；也可用 API Key（密码框） | `--allow-dangerously-skip-permissions` + 关闭 CLI 沙箱，默认 bypassPermissions，也可切换 |
| `codebuddy` | 同上（`cbc`），权限问答走 `can_use_tool` | npm 装进 `state/codebuddy/npm` | 账号：选 Google/GitHub、微信或 iOA，卡片显示授权链接，授权后自动变成已登录；也可用 API Key（密码框，可选服务区域） | `--dangerously-skip-permissions` + `CODEBUDDY_IS_SANDBOX=1`，默认 bypassPermissions，也可切换 |

所有登录入口统一在「模型与 Agent」里（主界面是模型列表，每个 Agent 的「配置」打开它自己的窗口）：卡片只给链接和输入框，不出现命令行。登录进程只保留一个，由 daemon 管理，
授权完成自动变成「已登录」；daemon 重启、10 分钟超时或用户取消都会结束它，卡片提示「登录已中断，请重新点登录」，
不留过期链接。链接、授权码、Key 和 token 不写日志，也不经过任何模型。

**API Key 要核对，而且不发模型请求。** 保存前向服务商问一次模型列表（Claude 问 `/v1/models`，Codex 问 OpenAI 或 `OPENAI_BASE_URL` 的 `/models`；Cursor 本来就拉模型列表）：
401 才算「Key 无效」，不保存、不覆盖原来能用的 Key；403、404、没有网络、没有模型列表接口只算「没能核对」，Key 照存，卡片明说没核对，
状态是「可用（Key 未核对）」而不是纯绿。已保存的 Key 之后被服务商拒绝，卡片回到「需要登录」。Codex 配置里用了自定义 `model_provider` 时不拿 OpenAI 的列表核对。
CodeBuddy 没有不发模型请求就能核对 Key 的办法，所以始终是「未核对」，第一次对话才知道。

**独立空间（高级，默认沿用本机）。** Codex、Claude Code、CodeBuddy 的卡片「高级」里可以让 GeneHub 里的这个 Agent 改用自己的一套登录、配置和历史：
daemon 把该 CLI 文档化的配置目录变量（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`CODEBUDDY_CONFIG_DIR`）指向 `state/<id>/space`，**不改 `HOME`**，
所以 git、ssh 等照常用真实的家目录。切换要 Agent 自己弹确认卡；退回「沿用本机」不删独立空间里的内容。本机原来的登录不会被带进来、也不会被改动。
Cursor 不做：Linux 上它的登录只能靠 `XDG_CONFIG_HOME` 搬走，而那会同时改掉它启动的 git、gh 的配置，代价不可控。

**登录的几种形式。** 账号登录一律是“点登录 → 卡片显示链接（有的还有一次性授权码）→ 在任何设备的浏览器里完成”。Codex 有两个账号入口：
「登录」走设备码（授权页可以在任何设备打开），「登录（这台机器的浏览器）」走 ChatGPT 的浏览器回调（授权后页面要跳回这台机器的本地端口，
所以只在浏览器和 daemon 在同一台机器时可用，卡片里已写明）。登录流程全部在适配脚本里，daemon 只管卡片、进程生命周期和存档，不认识任何 Agent 的登录方式。

**复用内置 provider（高级）。** 在「模型与 Agent」里添加的 provider（地址、接口类型、Key、模型）可以直接给 Claude Code 和 Codex 用，不必在每个 Agent
里再填一遍 Key 和 base URL：Agent 卡片的“使用已配置的 provider”列出接口类型对得上、已有 Key 的 provider，选定后 Agent 的模型列表就是这个 provider 的模型，
不再用它自己的登录；“改用 … 自己的登录”随时改回。平台只提供一个接口——脚本在自己的私有管道上向 daemon 要某个 provider 的完整配置（含 Key），
拼配置是脚本的事：Claude Code 得到 `ANTHROPIC_BASE_URL`、Key 和各个模型位的环境变量；Codex 得到 `app-server -c model_provider…` 覆盖项，Key 走环境变量，
不改用户的 `config.toml`。Key 只在内存里，不落盘、不进日志、不经过模型；脚本只记住选了哪个 provider 的 id，每次启动会话时重新取，换 Key 立即生效。
接口类型要对得上：Claude Code 只接 `anthropic` 类型的 provider，Codex 只接 `openai` 类型（并且服务要支持 Responses 接口，不支持的服务选了也用不了，
这一点需要用真实服务确认）。CodeBuddy 和 Cursor 没有这个入口。

四者都会：

- 先推送 `state/<id>` 里缓存的模型目录，再探测，探测失败时界面不会变空；
- 在 `serve` 启动时检查并更新由 GeneHub 安装的 CLI（每 24 小时最多一次）；
- 自己迁移会话里存着、但当前目录已经没有的模型、模式和思考强度，并发出 `*Changed` 事件。

Codex 另外监视 `auth.json`（`CODEX_HOME` 或 `~/.codex`），以及 app-server 输出的 `token_revoked` / `401`；
出现时在下一轮开始前重启 app-server 并 `thread/resume`，重新登录对已打开的会话立即生效。

各目录里的 `README.md` 说明文件分工；协议实现细节写在各自的模块文档里。

## 4. 已移除、待以脚本重新接入的 Agent

TClaude、OpenCode 和 `agents.custom` 里声明的自定义 ACP Agent 的 Rust 适配器已删除。
重新接入之前：

- 它们的历史会话仍可只读查看；
- 继续发消息会得到「这个 Agent 现在不可用」；
- tag 路由自动绕开它们。

配置文件里遗留的 `agents.custom` 被忽略。重新接入的顺序见提案 §13.2，每一步只新增脚本目录，平台不改。

## 5. 写一个新的 Agent

看 `<渠道数据目录>/agents/README.md`（源码：`apps/daemon/builtin-agents/README.md`）。最小的 Agent 是一个
`agent.genet.json` 加二十几行 `agent.py`；`codex/`、`cursor/` 是完整示例，`claude/`、`codebuddy/` 展示了怎样复用 SDK 里的 `claude_family`（两个用同一套 stream-json 协议的 CLI 只写各自不同的几十行）。验收：

```bash
"$GENEHUB_CLI" agent test <id> [--live]
"$GENEHUB_CLI" agent reload <id>
"$GENEHUB_CLI" agent logs <id>
```

## 6. 起不来的时候

- 列表里的说明文字来自脚本；脚本本身起不来时由 daemon 写明原因（Python 运行时未安装、`agent.genet.json`、握手失败、
  退出码和最后几行 stderr）。
- `genet agent logs <id>` 给出脚本的 stderr 和 daemon 记下的协议问题（不合规的事件、超时重启）。
- 工作台里不可用的脚本 Agent 有「让内置 Agent 修复」：开一个内置 Agent 会话，按上面的流程复制、修改、
  测试、`reload`。
