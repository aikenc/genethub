# 第三方 Agent 接入

> 前提：先读 [architecture.md](./architecture.md) §3 的 boundary B1——daemon 只通过「拉起进程 + 按协议收发帧」和一个 agent 打交道，从不知道也不管它内部怎么找模型、怎么存密钥。本文档说的每一个 agent 都遵守这条边界，包括我们自己的 [Genet Agent](./builtin-agent.md)。

---

## 1. 一句话原则

**GeneHub 只对接 CLI，不管 CLI 内部通讯。**

一个 agent 能不能用、接的是哪个模型、密钥存在哪，都是那个 CLI 自己的事，由用户按那个 CLI 自己的文档配置（环境变量、它自己的配置文件、或登录态）。daemon 该做的只有两件事：

1. 探测这个 CLI 在不在（`probe`），在就把它列进选择器。
2. 拉起子进程，按它公开的协议（stdio JSONL / ACP / HTTP+SSE）收发帧，翻译成本项目统一的时间线事件。

daemon **不会**帮任何第三方 agent 写配置文件、注入密钥、或者在中间做协议转换。做了就等于把它的实现细节焊进了我们的抽象层，下一个版本它一改内部协议，我们就得跟着改——这正是 [architecture.md](./architecture.md) 反复强调不能做的事。

---

## 2. 目前默认注册的 agent

| id | 传输 | 说明 |
|----|------|------|
| `genet` | 子进程 + stdio JSONL | 我们自己写的兜底 agent，见 [builtin-agent.md](./builtin-agent.md) |
| `opencode` | 本地 HTTP + SSE | 探测 `opencode` 二进制；模型/密钥全在它自己的 `opencode.json` |
| `claude` | 子进程 + 原生 `stream-json` stdio | 探测 `claude` 二进制本身（`@anthropic-ai/claude-code`），daemon 直接说它的原生协议，见 §3 |
| `codex` | 子进程 + 原生 `app-server` JSON-RPC | 探测 `codex` 二进制本身，daemon 直接说它的 `app-server` 协议，见 §4 |
| `cursor` | 子进程 + ACP over stdio | 探测 `cursor-agent` 二进制本身，说它自己发布的 ACP（`cursor-agent acp`），见 §5 |
| `acp` | 子进程 + ACP over stdio | 兜底条目，探测一个叫 `acp-agent` 的二进制；真正常用的是下面的自定义声明 |

`claude` 在代码里是 `adapter::claude::ClaudeAdapter`——直接拉起 `claude` 二进制，说它自己的 `stream-json` stdio 协议（不经过任何 wrapper）。换原生协议不是图省事，是为了拿回 ACP 不暴露给客户端的能力：**逐个工具调用的权限控制**。`claude --permission-mode manual --permission-prompt-tool stdio` 会把每一次工具调用都变成一个 `control_request`/`control_response` 往返，和 daemon 自己的 `PermissionRequested`/`respondPermission` 正好对上；协议细节（没有公开 spec，是对着 Claude Code 2.1.220 实测出来的）见 `apps/daemon/src/adapter/claude.rs` 顶部的模块文档。

```bash
npm install -g @anthropic-ai/claude-code
```

`codex` 同理，装的就是它自己，不再需要任何桥接包（§4）：

```bash
npm install -g @openai/codex
codex login
```

装好、能在 PATH 上找到，就会出现在 agent 选择器里；没装就不出现，不影响其他 agent（同 [testing.md](./testing.md) §4.2 的「未安装即隐藏」行为）。`codex` 多一种中间状态：装了但没登录时它会出现、但标成不可用，理由里就是上面那行 `codex login`——因为这个 CLI 在未登录时不会拒绝一个回合，只会不回话（§4）。

---

## 3. Claude Code + DeepSeek：官方直连，已验证可用

DeepSeek 官方提供一个 Anthropic 兼容端点，Claude Code 不用改代码，只要把环境变量指过去即可。这几个变量是 Claude Code 自己文档化的配置项，daemon 完全不解释它们，只是把 spawn 子进程时的环境原样传下去：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<你的 DeepSeek API Key>
export ANTHROPIC_MODEL=deepseek-v4-flash
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
```

在**启动 daemon 之前**把这几个变量设进 daemon 所在的进程环境（shell profile、systemd unit 的 `Environment=`、桌面端的启动脚本……随便哪种能让子进程继承环境的方式），daemon 拉起 `claude` 时这些变量就在，Claude Code 自己会用它们连 DeepSeek。

这条路径已经用真实 DeepSeek key 端到端跑通并固化成回归测试：`testing/tests/claude.rs`，跑法见 [testing.md](./testing.md) §8.1。除了「归一化事件层对 Claude Code 和对内置 agent 是同一套代码」这条基本断言之外，还覆盖了换原生协议真正买回来的东西：

- `acceptEdits` 模式下真实工具调用不经过一次提问就落盘；
- daemon 自己的中断请求真的能打断一个正在生成的回合，而不只是杀掉进程；
- 默认模式下拒绝一次权限请求，工具调用真的不会碰到文件系统；
- 模型和模式选择器里列出来的每一项，都是这台机器上的 CLI 自己报的、并且它真的会接受。

### 3.1 模型和模式：问 CLI，不写死

Claude Code 的模型和权限模式**不是我们编的表**，是开机跟它握一次手问出来的：

- 模型：一个 `{"subtype":"initialize"}` 控制请求，它会回自己的模型别名表（`default`、`opus`、`sonnet`……，带 `displayName` 和是否支持 effort 档位）。这些别名原样进选择器，切换时原样发回 `set_model`——列表和参数是同一个来源，就不存在「我们以为它有」这种事。某个别名背后到底是哪个模型，仍然是 Claude Code 自己的事（环境变量、它自己的配置文件），我们只显示不决定（[architecture.md](./architecture.md) §3 边界 B1）。
- 模式：从 `claude --help` 的 `--permission-mode` 选项里读这台机器接受哪些名字，只提供其中我们能说清含义的：默认（逐个询问）、`acceptEdits`、`plan`、`bypassPermissions`。2.1.220 还接受 `auto` 和 `dontAsk`，但 CLI 里外都没有一句话说这两个跟上面几个有什么区别——说不清效果的开关比没有这个开关更糟，所以先不放。
- 会话中途切换走的都是原生控制请求（`set_model` / `set_permission_mode`），并且**等它回话**：控制请求失败就报错，不会让选择器动了而实际什么都没变。

思考强度（effort）：`initialize` 回的模型表里每个模型都带自己的档位（`supportedEffortLevels`，这台机器上是 `low/medium/high/xhigh/max`），启动时按 `--effort` 传，会话中途用 `set_model` 控制请求只发 `effort` 字段切换——不带模型，因为在哪个模型上是 CLI 自己的状态（它自己的 `/model` 命令也能改），带上反而会把它悄悄改回去。校验依然在我们这边：`effort: "nonsense"` 它同样回 `success`，然后继续用原来的档位。

派出去的子 agent（`Task`/`Agent` 工具）：它的步骤会以普通 `assistant`/`user` 帧回来，唯一的标记是帧上的 `parent_tool_use_id`。我们按这个标记把它们收进派它出去的那次调用的卡片里（`ToolCallDetail::SubAgent.items`）。不认这个标记的话，子 agent 的 `Bash`、`Read` 会以主 agent 的名义出现在对话里，而看的人没有任何办法分辨。流式增量帧不带这个标记，所以子 agent 的文字不会混进主对话。

斜杠命令也是同一次握手带回来的：`initialize` 会回这台机器上所有命令和 skill（名字、说明、参数提示），composer 里输入 `/` 就是这份表。执行不需要任何协议——命令就是普通 prompt 文本，CLI 自己认；缺的从来只是「有哪些」这份清单，而它在 CLI 自己的终端界面之外是看不到的。

有一个例外要写下来：这个 CLI 不校验模型名。给它一个根本不存在的模型，它照样回 `success`、打印一句 "Set model to <你输入的东西>"，然后继续用原来那个模型。所以校验在我们这边——只有它自己列过的别名才发得出去。

`acceptEdits` 是另一个例外方向：除了告诉 CLI，daemon 自己也拦着不问（按工具名的白名单那套机制）。旧版本 CLI 万一不认 `set_permission_mode`，用户选的「不要再问我」也还是成立的。

不是「DeepSeek 能不能连 Claude Code」——后者是 DeepSeek 自己的产品能力，我们只是借用。

`can_use_tool` 的三个选项现在是 Allow / **Always Allow** / Deny：Claude Code 的 stdio 协议本身没有「记住这次选择」的字段（见 `claude.rs` 顶部模块文档），所以 Always Allow 是 daemon 自己按工具名维护的一份进程内白名单——同一个会话里选过一次之后，同名工具不再打扰前端，换一个工具名要重新问。

粘贴图片现在会作为附件随消息一起发：`claude`（Anthropic 内容块）、`codex`（先落到 scratch 再发 `localImage` 路径）、`opencode`（`file` part + data URL）、经 `acp` 声明的 agent（ACP `image` 内容块）都会转发；`genet` 自己的 provider 层还不接受图片，见 [roadmap.md](./roadmap.md)「明确不做」。

---

## 4. Codex：直接说它自己的 `app-server` 协议

`codex` 在代码里是 `adapter::codex::CodexAdapter`——拉起 `codex app-server`，说它自己的 JSON-RPC（stdio、双向），不经过任何 wrapper。理由和 Claude Code（§3）完全一样：**逐个工具调用的权限控制**，ACP 不把这条暴露给客户端。顺带还去掉了一个没人猜得到的安装步骤——之前注册的是 `codex-acp` 桥接包，于是装了 `codex` 的人被告知「Codex 未安装」。

协议细节（版本漂移从此归我们跟：以下是对着 codex-cli 0.145.0 实测的）见 `apps/daemon/src/adapter/codex.rs` 顶部的模块文档。挑几条影响用户能看见什么的：

- **三个选择器都是真的，而且一个 RPC 都不用额外发。** 这个 CLI 的 `turn/start` 参数里同时带着 model、`effort`、`approvalPolicy` 和 `sandboxPolicy`，所以「切模型」「切档位」「切模式」在我们这边只是记下来，下一回合原样带过去。首个 prompt 之前进程还没起（`session::manager::ensure_started`），这也是唯一能让那时的选择不被丢掉的接法。
- **模型表和档位问它要。** `model/list` 回的每个模型都带自己的 `supportedReasoningEfforts`（这台机器上是 `low/medium/high/xhigh/max/ultra`）和一个默认档位，原样进选择器。校验在我们这边：它不会替我们拒绝一个不存在的模型名，只会在下一回合安静地用回原来那个。
- **模式是两个设置的组合，不是一个开关。** 它自己的词汇是 `approvalPolicy`（`on-request` / `never`）加 `sandbox`（`read-only` / `workspace-write` / `danger-full-access`）。摆在界面上的是三档能说清含义的组合：只读、默认（工作区内可写、越界要问）、完全放行（不问且允许联网）。
- **审批按对象分成三条请求**，都是它反过来问我们：命令执行、文件改动（都回 `{"decision":"accept"|"decline"|"cancel"}`），以及一条「问用户」的选择题（回 `{"answers":{...}}`）。它问什么我们都得回——一条不回，它就一直等。所以渲染不了的（多个问题一次问、要自由文本、MCP 的表单）也照样回，回的是「没人回答」而不是替用户选一个。
- **没登录不会报错，会挂着。** 未登录时 `turn/start` 照样被接受、用户消息照样回显，然后什么都不发生：没有失败帧，也不退出。所以 `probe` 直接问 `codex login status`，未登录就报 `Unavailable` 并写清那一行命令，而不是让第一条 prompt 在那儿转圈。

已经接上的两样：`thread/resume`（`PersistHandle` 里存 `threadId`，进程重启后先 `thread/resume`；若 CLI 说线程已归档，会先 `thread/unarchive` 再试一次），以及贴图（粘贴的截图先落到会话 scratch 目录，再以 `{"type":"localImage","path"}` 发出去）。

还没接的，写下来免得下次误以为漏了：skills（`skills/list` 能列出来，但它的调用方式是 `$name` 外加一个 `{"type":"skill"}` 输入块，不是把 `/name` 当普通文本发——所以没有把它们放进斜杠命令菜单，一个点了不生效的菜单比没有菜单更糟）；子 agent 的内部步骤（卡片会显示派了谁、派去干什么，但它自己的步骤走的是另一条 thread，还没接进来）。

### 4.1 Codex + DeepSeek：目前连不上，这是 Codex/DeepSeek 两边的协议问题

**结论先说：今天没有办法让 Codex CLI 直接使用 DeepSeek 作为后端，GeneHub 也不会为此写协议转换代码。**

原因（已在真实环境里复现，不是道听途说）：

- Codex CLI 新版本的 `model_providers` 只接受 `wire_api = "responses"`——`wire_api = "chat"` 已被明确废弃，配置里写了直接拒绝启动：`` wire_api = "chat" is no longer supported ``。
- DeepSeek 的官方 API 只有 OpenAI **Chat Completions** 兼容层（`/chat/completions`），没有实现 OpenAI 更新的 **Responses API**（`/responses`）。
- 把 Codex 指向 `https://api.deepseek.com/v1` 并设 `wire_api = "responses"`，实测直接 404：`unexpected status 404 Not Found ... url: https://api.deepseek.com/v1/responses`。

这是 Codex 和 DeepSeek 两个上游之间的协议缺口，不是配置能绕过去的，需要一层把 Responses API 请求翻译成 Chat Completions 的网关。GeneHub 的立场是：**daemon 不管任何 agent 内部怎么连它的模型**，所以这层翻译不会出现在这个仓库里。

这不影响 `codex` agent 本身可用——它一样会被探测到、一样接进同一套时间线；只是它连的后端得是 Codex 自己支持的（OpenAI API Key、ChatGPT 登录，或者用户自己维护、自己信任的网关）。如果哪天 Codex 支持了 Chat Completions，或者 DeepSeek 上线了 Responses 兼容端点，这里的配置和别的 agent 一样，一行环境变量的事，不需要我们改代码。

这跟传输层是两件独立的事：换成原生 `app-server` 买的是权限控制和那三个选择器（§4），跟它连不连得上 DeepSeek 无关——那个网关缺口不会因为换了传输层就消失。

---

## 5. Cursor：走它自己发布的 ACP

`cursor` 在代码里是 `adapter::acp::AcpAdapter` 的一个默认条目——拉起 `cursor-agent acp`，说 [ACP](https://agentclientprotocol.com/)，这个 CLI 自己发布的嵌入协议。没有像 Claude 和 Codex 那样写原生适配器，因为 Cursor 没有一份公开的、值得跟进维护的原生协议，而 ACP 已经把我们需要的暴露出来了：权限请求（`session/request_permission`）、模式切换和图片附件都在协议里。

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

登录态仍是这个 CLI 自己的事（§1）：它没有一个可以把模型后端指走的配置项，所以 mock 模式下没有它的专项测试——`testing/tests/cursor.rs` 只在真实模式、且机器上装着登录过的 `cursor-agent` 时跑，其余情况跳过并打印原因，与 Codex 的处境相同（§4）。

模型和模式列表来自 ACP 的 `session/new` 握手（`availableModels`、`availableModes` 或 `configOptions`），GeneHub 在 agent picker 里展示并可通过 `session/set_config_option` / `session/set_mode` 切换；凭证和账号仍由 Cursor CLI 自己管理，不在 GeneHub 配置里出现。

---

## 6. 接入任何其他 ACP agent

不止 Claude 和 Codex，任何说 [ACP](https://agentclientprotocol.com/) 的 CLI 都能不改代码接进来，写一段配置声明即可（`docs/architecture.md` §3）：

```jsonc
{ "agents": { "goose": { "extends": "acp", "command": ["goose", "acp"] } } }
```

`extends` 目前只认 `"acp"`；`command` 是完整的可执行文件 + 参数列表。凭证同样是那个 CLI 自己的事——不在这份配置里出现，也不会出现。

---

## 7. 第三方 CLI 起不来的时候

外部 CLI 退出的原因只有它自己知道，而它说这句话的地方是 stderr。以前那些行走 `tracing::debug!`（默认级别 `info`，即被丢弃），用户看到的是一句「Claude Code stopped unexpectedly.」——凭据没配、CLI 版本不认识我们传的参数、Windows 上的 shim 找不到 node，三种情况长得一模一样，而且没有一种能据此往下走。

现在每个适配器都留着子进程的最后二十行（`adapter::Chatter`），并且：

| 情形 | 用户看到的 |
|------|-----------|
| 进程中途死了 | `Claude Code 退出了（退出码 1）: <它自己说的话>` |
| 进程已经死了，提示写不进去 | 同一句话，而不是 `Broken pipe (os error 32)` |
| 它一句话都没说 | `…（退出码 7），而且它什么都没说。日志里有它这一趟的全部输出。` |

每一行同时进日志（`target: "agent"`），所以失败消息里的二十行不够时，剩下的都在 `<data>/logs/daemon.log`。

---

## 8. 别人的 CLI 不是一个稳定的接口

同一个版本号下的 Claude Code 有两套权限模式的名字:一套认 `manual`、拒绝 `default`,另一套认 `default`、拒绝 `manual`。写死任何一个,都等于对一半的安装说「启动失败」——这件事真的发生了:

```
error: option '--permission-mode <mode>' argument 'manual' is invalid.
Allowed choices are acceptEdits, auto, bypassPermissions, default, dontAsk, plan.
```

所以这个名字是从 `claude --help` 里读出来的（每个 daemon 生命周期问一次），两个名字都不在时就干脆不传这个参数：`--permission-prompt-tool stdio` 仍然把它愿意问的都路由给我们，而一个会被拒绝的参数换不到任何东西。

受影响的只有启动那一个参数。会话中途切换档位走的是它自己的 `set_permission_mode` 控制请求（§3.1），发的名字来自同一份 `--help`，所以这台机器上认的和我们发的永远是同一套词。

### Windows 上的两件事

| 事 | 为什么 |
|----|--------|
| 起进程时屏蔽控制台窗口 | 这些都是控制台程序，从 GUI 里起会给它开一个窗口：每开一次会话闪一个黑框，而且这个框会一直挂在屏幕上。桌面壳早就对 daemon 这么做了，daemon 也得对它起的东西这么做 |
| 结束时杀进程树 | npm 装的 CLI 在 Windows 上是 `.cmd` 外壳，我们手里的句柄是 `cmd.exe`，真正的 agent 是它的子进程。只杀手里的那个，会留下一个还在跑的 HTTP 服务和一个占着的端口——每开一次会话留一个 |

### 超时是我们自己定的，就得由我们自己解释

OpenCode 的 HTTP 客户端曾经带着 300 秒总超时，而那个 POST 是**整轮对话**：一个跑得久一点的编码任务会被我们掐断，然后报成「超时」——agent 那边其实还在干活。现在只对「连上 loopback」设上限（10 秒，连不上就是连不上），对话本身不设。

事件流断掉也会记一行：流没了之后，回合不再是流式的，答案只在这一轮结束时整段出现——「没有流式」和「卡住了」在屏幕上长得一模一样。
