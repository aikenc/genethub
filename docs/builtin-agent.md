# Genet Agent（内置 Agent）规格

> 用 **Rust** 写的内置 coding agent，随桌面端分发，装完即可跑任务，不必先去装外部 CLI。  
> **定位：它只是 daemon 众多 agent adapter 中的一个后端**，见 [architecture.md](./architecture.md) §3。产品不围绕它设计，它也不定义对外协议。

---

## 1. 定位：兜底选项，不是主角

用户真正想用的往往是 Claude Code、Cursor 这类他们已经付费和熟悉的 agent。内置 agent 解决的是另一个问题：**新用户装完之后第一分钟内要能跑起一条任务**，不能卡在"请先安装并登录某个 CLI"。

由此推出三条设计约束：

1. **能力对标够用即可**，不追赶外部 agent 的功能面。它落后了不是问题，装不上或跑不起来才是问题。
2. **不许特殊待遇**。daemon 通过和其他 adapter 完全相同的接口驱动它；一旦内核里出现"如果是内置 agent 就……"的分支，抽象就烂了。
3. **它的线格式不是产品协议**。stdout 上那套 JSONL 只在它和 `genet` adapter 之间有效，adapter 负责翻译成归一化事件，见 [architecture.md](./architecture.md) §4。

### 1.1 为什么是自己写而不是打包现成的

成熟的开源 agent 多是多包 monorepo（多 provider 抽象、运行时、CLI、TUI 四层起步），全量移植是数月工程量，直接打包又要背上 Node 运行时和上百兆依赖。而 daemon 使用一个 agent 只需要一个很窄的接口：

```
daemon ──spawn──> genet-agent --mode rpc [--model M] [--thinking L] [--session FILE]
       <──stdout── JSONL：事件流 + 命令响应
       ──stdin───> JSONL：命令
```

接口窄到这个程度，自己实现反而比移植便宜：Rust 单文件二进制 < 15MB，零运行时依赖，与 Tauri 同栈。协议形状借鉴的是公开文档化的 stdio 约定，代码全部自有。

---

## 2. MVP 范围（已锁定）

只做四件核心能力，外加三项「地基」。

### 2.1 四项核心能力

| 能力 | 说明 |
|------|------|
| **Agent Loop** | 用户消息 → LLM 流式输出 → 工具调用 → 工具结果回灌 → 再次调用 LLM，直到无工具调用或被中止 |
| **Provider** | Anthropic Messages API + OpenAI 兼容 Chat Completions（覆盖 DeepSeek / Kimi / OpenRouter / vLLM / 本地推理） |
| **SKILL 机制** | 扫描 `SKILL.md`，解析 frontmatter，把技能清单注入系统提示，模型可按名调用 |
| **Session 持久化** | JSONL 追加写；`--session <path>` 指定文件，`--no-session` 关闭；重启可回放 |

### 2.2 三项地基（不是功能，是接口前提）

| 地基 | 为什么不能砍 |
|------|--------------|
| RPC/JSONL 传输 + 只读命令集 | daemon 建会话时会同步调用，无响应则会话建不起来 |
| 工具执行（7 个） | Loop 的循环靠工具结果驱动；SKILL 里写的步骤也要靠工具才能执行 |
| 事件流 | adapter 的归一化和前端渲染全靠事件，不发就是黑屏 |

### 2.3 明确不做（MVP）

TUI、subagents、extensions、MCP、LLM 压缩（compact 只留应答桩）、fork / branch / tree / rewind、steering 与 follow-up 队列、auto-retry、prompt templates、导出 HTML、图片输入、直连 `bash` RPC 命令、telemetry 与成本统计、远程模型目录、project trust。

对应的 RPC 命令一律返回结构合法的空值或 `success: false`，**不允许静默不回**——挂起的请求会让 daemon 侧 30s 超时。

---

## 3. 协议契约（必须逐字对齐）

### 3.0 只有 RPC 一种形态

Genet Agent **不是给人直接用的 CLI**：没有交互式界面、没有 print 模式、没有配置向导、没有彩色输出。唯一入口是 `--mode rpc`，唯一使用者是 daemon。

- 参数解析手写即可，不引入 CLI 框架
- `--mode` 不是 `rpc`（含 `rpc-ui`）时，往 stderr 打一行原因并以非 0 退出
- 所有人机友好特性（帮助文本、提示语、进度条）一律不做

### 3.1 启动参数

`genet` adapter 拼出的命令行（可执行文件路径由 `GENET_AGENT_COMMAND` 覆盖，便于开发时指向本地构建）：

```
genet-agent --mode rpc
            [--model <provider/id>] [--thinking <level>]
            [--no-session | --session <file>]
            [--mcp-config <path>] [--extension <path>]...
```

后两个参数 MVP 内接受并忽略（记一行 stderr 日志），**不能因为不认识而退出**——这样 adapter 可以对所有后端统一拼参数，不必为内置 agent 特判。

### 3.2 帧格式

严格 JSONL，**只以 `\n` 分帧**；输入端容忍并剥掉行尾 `\r`。不要用会把 `U+2028`/`U+2029` 也当换行的通用行读取器（多数语言的标准行迭代器都有这个坑），否则含这些字符的模型输出会把一帧劈成两半。

- stdin：命令，`{"id"?: string, "type": "...", ...}`
- stdout：响应 `{"id"?, "type": "response", "command", "success", "data"?, "error"?}`；其余均为事件
- stderr：日志。**stdout 绝不能混入非 JSON 输出**

`id` 原样回填。响应缺 `id` 会被 daemon 直接丢弃，请求永久挂起。

### 3.3 MVP 必须实现的命令

| 命令 | 行为 | 响应 `data` |
|------|------|-------------|
| `prompt` | 接受即回，执行异步走事件流 | `{agentInvoked: bool}` |
| `abort` | 中止当前 loop | 无 |
| `get_state` | 会话状态 | `SessionState`（cwd、模型、思考档位、会话文件、消息数） |
| `get_messages` | 全量消息 | `{messages: [...]}` |
| `get_available_models` | 已配置模型 | `{models: [...]}` |
| `set_model` | 切模型 | 完整 `Model` 对象 |
| `set_thinking_level` | 记录思考档位 | 无 |
| `get_session_stats` | token / 成本 | `{tokens, cost}` |
| `get_commands` | 斜杠命令（MVP 只返回 skills） | `{commands: [...]}` |
| `set_auto_compaction` | 记录开关 | 无 |
| `compact` | 桩：发 `compaction_start` + `compaction_end` 即可 | 无 |

未识别的 `type`：回 `success: false` + `error`，不要崩。

### 3.4 MVP 必须发出的事件

```
agent_start
  turn_start
    message_start        {message}
    message_update       {message, assistantMessageEvent:{type, contentIndex?, delta?, partial?}}
    message_end          {message}
    tool_execution_start {toolCallId, toolName, args}
    tool_execution_end   {toolCallId, toolName, result, isError?}
  （多轮 turn）
agent_end                {messages}
```

`assistantMessageEvent.type` 至少覆盖 `start` / `text_start` / `text_delta` / `text_end` / `done`；有推理内容时补 `thinking_*`。工具调用可先只在 `tool_execution_*` 体现，暂不发 `toolcall_delta`。

### 3.5 工具结果格式

两部分各有用途：`content` 是给模型读的文本，`details` 是给 adapter 归一化成 `ToolCallDetail` 的结构化元数据（diff、截断信息、退出码）。**两者都是契约的一部分**，只给文本会让前端退化成纯文本渲染。

```json
{"content": [{"type": "text", "text": "..."}], "details": {"truncated": false}}
```

### 3.6 消息类型

`user` / `assistant`（content 为 `text` | `thinking` | `toolCall` 数组）/ `toolResult`（`toolCallId`、`toolName`、`content`、`isError`）。MVP 只产出这三类。

---

## 4. 工具集

| 工具 | 参数 |
|------|------|
| `read` | `path`，可选 `offset`（1-indexed）、`limit` |
| `write` | `path`、`content` |
| `edit` | `path`、`edits[]`（`oldText` / `newText`，唯一匹配否则报错） |
| `ls` | 可选 `path`、`limit`（默认 500） |
| `grep` | `pattern`，可选 `path`、`glob`、`ignoreCase`、`literal`、`context`、`limit`（默认 100） |
| `find` | `pattern`（glob），可选 `path`、`limit`（默认 1000） |
| `bash` | `command`，可选 `timeout`（秒） |

统一约束：输出按行数/字节双阈值截断并标注；路径相对 cwd 解析；`grep` / `find` 尊重 `.gitignore`。

**权限**：不内建沙箱，以启动进程的用户权限运行。隔离由外层负责（见 [security-model.md](./security-model.md)）。

---

## 5. SKILL 机制

遵循开放的 [Agent Skills 标准](https://agentskills.io/specification)，为别的工具写的技能目录可以直接拿来用：

- 发现路径：项目 `.genehub/skills/`、用户级 agent 目录、共享的 `.agents/skills`；目录内含 `SKILL.md` 即视为技能根，不再向下递归；尊重 `.gitignore` / `.ignore` / `.fdignore`
- frontmatter：`name`（缺省用父目录名，≤64 字符）、`description`（必填，≤1024 字符）、`disable-model-invocation`
- 注入：把「名称 + 描述」清单写进系统提示；技能正文在被调用时才读入，避免撑爆上下文
- 相对路径：技能文件里的相对路径按 `SKILL.md` 所在目录解析
- 同时通过 `get_commands` 暴露为 `/skill:<name>`，`source: "skill"`

---

## 6. Session 持久化

- 格式：JSONL，每行一个条目，追加写
- `--session <file>`：用指定文件；存在则加载回放，不存在则创建
- `--no-session`：纯内存
- 默认（都没给）：写到 agent 数据目录下 `<时间戳>_<sessionId>.jsonl`
- `get_state` 里的 `sessionFile` / `sessionId` / `messageCount` 必须真实反映持久化状态

---

## 7. 配置与凭证

| 来源 | 用途 |
|------|------|
| 环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` 等 | 独立运行时直接可用 |
| 配置文件（agent 数据目录下 `models.json`） | daemon 每次启动会话时写入，声明 provider、baseUrl、模型清单 |

无任何凭证时：`get_available_models` 返回空数组，`prompt` 以明确错误消息结束当前 turn，提示去设置页填 Key——**不要静默失败**。

### 7.1 「某个 provider 在哪个地址」只有一个地方回答

由 daemon 的 `provider.rs` 回答，写进 `models.json`；agent 侧**没有默认地址**。

之前有:agent 的 OpenAI 兼容代码在没拿到地址时回退到 `https://api.openai.com/v1`。于是只填了 DeepSeek Key、没填地址的人，收到的是 OpenAI 说"Incorrect API key provided: sk-dfd…"，还附一个他从没注册过的控制台链接。**把一家的密钥发到另一家的服务器上,这不是用户配错,是我们的默认值错**。所以那个回退删掉了:这份代码说的是一种协议(DeepSeek、Kimi、OpenRouter、vLLM、本地 llama.cpp 都走它)，不是一家公司；没人告诉它地址，它就报错，不猜。

我们自带地址的 provider 只有三个(`deepseek` / `openai` / `anthropic`)。自带地址买到的只有两件事:一个显示名，和一个不用用户去查的地址。它不是准入——任何 id 都能用，只要给地址。

### 7.2 模型列表向 provider 现问

`GET {baseUrl}/models`(Anthropic 方言是 `{baseUrl}/v1/models` 加它自己的头)，OpenAI 兼容的服务基本都实现这个调用。

原来是一张硬编码表。它在 provider 发布任何东西的第二天就过期，描述不了我们没听说过的服务，还会列出用户这把 Key 根本没权限的模型。现问的代价是一次网络请求落在"显示模型列表"这条路上，所以:超时 4 秒，按「Key + 地址 + 方言」缓存(改任何一项自动重问，因此不需要刷新按钮)，失败缓存 1 分钟(不然一把被拒的 Key 会让每次打开设置页都重新等一遍超时)。

返回的列表会滤掉不能对话的东西——OpenAI 会把 embeddings、语音、图像、审核模型一起给出来，六十行里五十行选了没用。滤是按名字猜的，认不出来的名字保留。

列表里只有 id。上下文窗口和"会不会思考"不在任何 provider 的返回里，所以不再声称知道:上下文窗口留空，「是否推理模型」按 id 猜，而它只决定一件事——请求里要不要带 `reasoning_effort`。这件事必须猜对方向:OpenAI 对一个普通对话模型收到 effort 参数的反应是整个请求 400，而思考档位默认是 medium，所以过去每一次发给 `gpt-4o` 的请求都是失败的。

不能列出自己模型的地址(裸 llama.cpp、只转发 completions 的网关)照样能用:在设置里手写模型 id，写了就不问。

拿不到列表的原因跟着 `models.json` 一起交给 agent(顶层 `problem` 字段)。因为"这一轮跑不起来"这句话是 agent 说的,而它自己只会说「去设置里添加 API Key」——对一个刚刚添加过、Key 被拒的人来说,这句话等于"这软件没注意到我做了什么"。拿我们的状态去指责用户,和把他的 DeepSeek Key 发给 OpenAI 是同一类错误。这个字段不落盘:它描述的是一次尝试,不是一项设置。

### 7.3 模型显示名是 `<Provider>:<model-id>`

`DeepSeek:deepseek-v4-flash`,不是 `DeepSeek V4 Flash`。同时配了两把 Key 时，光看 `deepseek-chat` 说不出这一轮花谁的钱；而美化过的名字("DeepSeek V4 Flash")在别的任何地方都不能拿来输入。

---

## 8. 阶段划分

| 阶段 | 内容 |
|------|------|
| **A（MVP，本次）** | 本文 §2.1 + §2.2 全部；能被真实 daemon 拉起并跑完一轮带工具调用的任务 |
| **B** | 真正的 compaction、图片输入、steering/follow-up 队列、auto-retry、更完整的模型目录 |
| **C** | subagents、extensions、MCP、fork/branch/tree |

阶段 B/C 的取舍视桌面端实际使用反馈决定，不预先承诺。

---

## 9. 验证方式（MVP 的验收标准）

1. `cargo test`：协议编解码、工具参数、SKILL 解析的单测
2. 假 provider 冒烟：不需要真 Key，驱动一轮「文本 → 工具调用 → 工具结果 → 收尾」，断言事件序列完整
3. **端到端**：daemon 经 `genet` adapter 建会话，从工作台发一条任务，流式输出与工具执行渲染正常
4. **一致性**：同一段前端代码分别驱动本 agent 与一个外部 ACP agent，渲染结果形状一致——证明它没有享受特殊待遇
5. 体积：release 二进制（strip + LTO）目标 **< 15MB**

---

## 10. 与 daemon、桌面端的关系

桌面端把二进制放进 Tauri `resources`；daemon 的 `genet` adapter 按需拉起它，路径可用 `GENET_AGENT_COMMAND` 覆盖。用户无需安装任何外部 CLI，也无需知道它的存在——在 agent 选择器里它和其他 agent 平级排列，只是默认选中。
