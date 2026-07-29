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
| `claude` | 子进程 + ACP over stdio | 探测 `claude-agent-acp`（Anthropic 官方维护的 ACP wrapper，包了 Claude Agent SDK） |
| `codex` | 子进程 + ACP over stdio | 探测 `codex-acp`（Agent Client Protocol 官方维护的 ACP wrapper，包了 Codex CLI） |
| `acp` | 子进程 + ACP over stdio | 兜底条目，探测一个叫 `acp-agent` 的二进制；真正常用的是下面的自定义声明 |

`claude` 和 `codex` 在代码里就是两个 `AcpAdapter::new(...)` 实例——和用户自己声明的 `extends: "acp"` 自定义 agent 没有本质区别，只是默认帮你注册好了，不用手写配置。这两个 wrapper 都不是我们写的，是各自官方仓库发布的 npm 包：

```bash
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g @agentclientprotocol/codex-acp
```

装好、能在 PATH 上找到，就会出现在 agent 选择器里；没装就不出现，不影响其他 agent（同 [testing.md](./testing.md) §4.2 的「未安装即隐藏」行为）。

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

在**启动 daemon 之前**把这几个变量设进 daemon 所在的进程环境（shell profile、systemd unit 的 `Environment=`、桌面端的启动脚本……随便哪种能让子进程继承环境的方式），daemon 拉起 `claude-agent-acp` 时这些变量就在，Claude Code 自己会用它们连 DeepSeek。

这条路径已经用真实 DeepSeek key 端到端跑通并固化成回归测试：`testing/tests/claude.rs`，跑法见 [testing.md](./testing.md) §8.1。它验证的是「daemon 的归一化事件层对 Claude Code 和对内置 agent 是同一套代码」，不是「DeepSeek 能不能连 Claude Code」——后者是 DeepSeek 自己的产品能力，我们只是借用。

---

## 4. Codex + DeepSeek：目前连不上，这是 Codex/DeepSeek 两边的协议问题

**结论先说：今天没有办法让 Codex CLI 直接使用 DeepSeek 作为后端，GeneHub 也不会为此写协议转换代码。**

原因（已在真实环境里复现，不是道听途说）：

- Codex CLI 新版本的 `model_providers` 只接受 `wire_api = "responses"`——`wire_api = "chat"` 已被明确废弃，配置里写了直接拒绝启动：`` wire_api = "chat" is no longer supported ``。
- DeepSeek 的官方 API 只有 OpenAI **Chat Completions** 兼容层（`/chat/completions`），没有实现 OpenAI 更新的 **Responses API**（`/responses`）。
- 把 Codex 指向 `https://api.deepseek.com/v1` 并设 `wire_api = "responses"`，实测直接 404：`unexpected status 404 Not Found ... url: https://api.deepseek.com/v1/responses`。

这是 Codex 和 DeepSeek 两个上游之间的协议缺口，不是配置能绕过去的，需要一层把 Responses API 请求翻译成 Chat Completions 的网关。GeneHub 的立场是：**daemon 不管任何 agent 内部怎么连它的模型**，所以这层翻译不会出现在这个仓库里。

这不影响 `codex` agent 本身可用——它一样会被探测到、一样能用 ACP 协议接进同一套时间线；只是它连的后端得是 Codex 自己支持的（OpenAI API Key、ChatGPT 登录，或者用户自己维护、自己信任的网关）。如果哪天 Codex 支持了 Chat Completions，或者 DeepSeek 上线了 Responses 兼容端点，这里的配置和别的 agent 一样，一行环境变量的事，不需要我们改代码。

---

## 5. 接入任何其他 ACP agent

不止 Claude 和 Codex，任何说 [ACP](https://agentclientprotocol.com/) 的 CLI 都能不改代码接进来，写一段配置声明即可（`docs/architecture.md` §3）：

```jsonc
{ "agents": { "goose": { "extends": "acp", "command": ["goose", "acp"] } } }
```

`extends` 目前只认 `"acp"`；`command` 是完整的可执行文件 + 参数列表。凭证同样是那个 CLI 自己的事——不在这份配置里出现，也不会出现。
