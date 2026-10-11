# 内置 Agent 下一版本改进提案（v3）

> 状态：提案 v3（2026-10-08）。对象：`apps/agent`、daemon 的 `genet` adapter 与 provider 配置。参考实现：`ref-repos/pi`（HEAD `a96fb984d`）。
>
> 实现（2026-10-09，dev-2）：M1 与 M2 已全部落地（§3、§4.1–4.5、§5.1–5.3、§6.1–6.4），[builtin-agent.md](builtin-agent.md) 已同步。M3 未做。与原文有出入的地方在各节末尾以“实现说明”标出。
>
> v3.1（同日）：dev-0 未提交的脚本化重构已整体搬入 dev-2 工作区，`thinkingMode` 修复已在重构后的接口上重新落地并通过测试（§2.1、§3.4、§8）。
>
> v3 相对 v2 的修订：以 dev-0 的 Agent 脚本化重构为基线（§2.1）。第三方 Agent 的提示词通道表按新结构重写（§6.1）。模型能力配置接入 dev-0 新增的 `provider configure/verify`（§3.3）。§5、§6.2、§6.3 补充与持久暂停、SDK 进程组清理的边界。里程碑增加合入顺序（§8）。
>
> v2 相对 v1 的修订：
> - 不引入 pi 的生成模型目录。模型能力统一走平台 provider 配置，按“远程发现 → 默认规则 → 用户配置”逐层覆盖（§3）。
> - “自动压缩”改为“自动归档换轮”：复用现有带引用的 `/compact`，不移植 pi 的 LLM 摘要压缩（§5.1）。
> - `--add-system-prompt` 从 P0 降为 P1，问题描述也改了：真正的问题是命令行能被 `ps | grep` 命中，argv 本身不是问题；Claude Code 适配器也走 argv（§6.1）。防误杀改由 §6.3 负责。
> - 不变的部分：思考块回传、max_tokens 与 budget、历史清洗都还没改，仍是 P0（§4）。

## 1. 近期问题与证据

| 编号 | 现象 | 已核实的直接原因 | 归类 |
|---|---|---|---|
| fb_SweJ1nGGP_o8 | `claude-opus-5-5` 开思考即 400 | 只会发 `budget_tokens`，不认 adaptive thinking。已由 `d9adf9de` 修复，未合入 | 模型能力靠猜 |
| （复查） | 用户配置的 `thinkingMode`/`modelThinking` 不生效 | `AppState::providers()` 在 `..config` 前把两字段写死为空。已修复，未提交 | 配置透传缺测试 |
| s_c36e9b95（OpenPlay 巡查） | 投递建议写进归档目录，没走 Skill 规定的 `wait.py post` | Skill 目录已注入（§1.1），模型没读 Skill 就动手 | Skill 激活全靠模型自觉 |
| fb_IXUzjtBuA4wt | “Agent 退出了（退出码 -1），而且它什么都没说” | Agent 用 `ps \| grep dev-0… \| kill` 清理进程，命中了自己的宿主进程（§1.2） | 宿主进程可被自身命令误杀；退出原因丢失 |
| 同一 beta 日志 | 多次 `aiclick 524`、`RateLimited`，回合直接失败；单回合输入 64 万 token | 没有自动重试；没有自动归档，每轮全量发送历史 | 稳健机制缺失 |

### 1.1 Skill 未加载

- 会话：`genet` + `aiclick/claude-opus-5-5`，思考 `off`，cwd `/data/workspace/openplay/openplay`。
- 目录注入正常：同一 cwd 下运行当前构建的 `agent-serve`，`get_commands` 列出 `.agents/skills/` 下全部 7 个 openplay Skill，`<available_skills>` 含 `openplay-guidance`。提示词格式与 pi `formatSkillsForPrompt` 一致。
- 实际行为：第 28 步读了已有的 `guidance/patrol/01_…md`，第 53 步照着写出 `04_…md`。用户指出后，第 67 步才第一次读 SKILL.md。
- 诱因：会话以 64.5 KB 历史导入开场，其中 8 次提到 `openplay-guidance`，但没有正文。

结论：这不是与 pi 未对齐导致的。pi 只给名字和描述，读不读由模型决定，换成 pi 一样会出错。需要 GeneHub 自己的确定性机制（§6.4）。

### 1.2 Agent 自杀

- 最后一批工具调用：`ps aux | grep -E "dev-0.*(server|relay|genehub-host)" | awk '{print $2}'` 得到 5 个 PID，随后全部 kill。10:11:48 daemon 报告退出码 -1，stderr 为空。
- 命中原因（本机核实，见 §6.1）：内置 Agent 的 cmdline 里，`--session` 参数是工作区内的路径（含 `dev-0`），`--add-system-prompt` 的提示文本含 `server`。两者在同一行，正好满足这个正则。
- 退出码丢失：`apps/host/src/process.rs` 的 `status.code().unwrap_or(-1)` 把“被信号终止”压成了 -1。

## 2. 根因

1. **模型能力没进平台配置。** 发现层只取 `id` 和 Kimi 风格的 `supports_image_in`/`supports_video_in`。Anthropic、Kimi 已经返回的上下文窗口、输出上限、思考类型和 effort 档位都被丢掉了，用户也没有地方填写。下发给 Agent 的 `contextWindow`/`maxTokens` 一直为空，`reasoning` 和 adaptive 判定按 id 子串猜。Opus 5.5 的 400、budget ≥ max_tokens、无法自动归档，都出自这里。
2. **协议正确性被当成可选功能。** 在 pi 里，思考签名回传、budget 夹紧和历史清洗是请求合法性的一部分。
3. **测试只覆盖假 Provider。** 两次 400 都是上线后才暴露的。
4. **宿主形态的特有风险没人负责。** 命令行可被 grep 命中、信号退出不可见、Skill 只靠模型自觉。

### 2.1 基线：dev-0 的 Agent 脚本化重构

dev-0 的方案见 `docs/agent-script-adapters-proposal.md` 和 `docs/agent-serve-protocol.md`。到 2026-10-08，这批改动在 dev-0 仍未提交。dev-2 先合入了 dev-0 已提交的 6 个提交（`678d46ad`），然后把 dev-0 工作区快照（相对 `ac519d35`，255 个文件）整体搬进了 dev-2 工作区，同样未提交。和本提案相关的变化：

- **第三方 Agent 改为脚本**：Codex、Cursor 改为 `builtin-agents/agents/<id>/agent.py`，由 Python SDK 通过 `serve` 协议接入。Claude、CodeBuddy、OpenCode、ACP 的 Rust 适配器和 `agents.custom` 被删掉，第一期不再提供。
- **内置 Agent 不变**：`adapter/genet.rs` 保持原样，仍在 Rust 内核里，不经过脚本层。本提案的所有改动都还落在 `apps/agent` 和 `genet.rs`。
- **Provider 配置有了 Agent 入口**：`genet provider list/configure/get/verify`。Agent 发起配置，界面弹出卡片，由 Human 填入密钥。`provider::verify` 用 16 token 真实调用一次模型。如果更新时换了 endpoint 或 dialect 而没有给新 key，旧 key 会被清掉。
- **用量**：`Usage.token_usage_reported` 区分“服务端报了 0”和“服务端没报”。
- **持久暂停**：`session ask` 和 `request_user_input` 会先保存问题，再停止当前执行；回答后在同一 Session 里启动新的执行。
- **引导文本变长**：`session_guidance` 在原来约 4.4 KB 的基础上，又加了一段约 1.4 KB 的交互和 provider 说明。

## 3. 统一的模型能力配置（P0，替代 v1 的“引入模型目录”）

### 3.1 现状

- 按模型配置的能力只有 `ProviderConfig.modelInputs`（图片/视频），设置页每个模型有两个勾选框（`SettingsPanel.tsx`）。发现层只认 Kimi 风格的 `supports_image_in`/`supports_video_in`（`provider.rs` `list_models`）。
- `d9adf9de` 另加了一对平行字段 `thinkingMode`/`modelThinking`，设置页没有入口，也不在 `ProviderInfo` 里。
- `reasoning` 由 `provider::reasons(id)` 按子串猜；adaptive 判定由 agent 侧 `requires_adaptive_thinking` 再猜一遍。
- `configured_models` 把 `context_window`、`max_tokens` 写死为 `None`（`adapter/genet.rs`）。注释和 [builtin-agent.md](builtin-agent.md) §7.2 都说“这些不在任何 provider 的返回里”，这个说法已经过时，见 §3.2。

### 3.2 远程接口能拿到什么（2026-10-08 实测）

| 来源 | 列表接口返回的能力字段 |
|---|---|
| Anthropic 官方 `GET /v1/models` | `max_input_tokens`、`max_tokens`、`capabilities.thinking.types.{adaptive,enabled,disabled}`、`capabilities.effort.{low,medium,high,xhigh,max}`、`capabilities.image_input`/`pdf_input`。分页默认 20 条，`limit` 最大 1000 |
| Kimi `api.kimi.com/coding/v1/models` | `context_length`、`supports_reasoning`、`supports_thinking_type`（如 `only`）、`think_efforts.valid_efforts`/`default_effort`、`supports_image_in`、`supports_video_in`、`modalities.input` |
| OpenRouter `GET /api/v1/models` | `context_length`、`architecture.input_modalities`、`top_provider.max_completion_tokens`、`supported_parameters`、`reasoning.supported_efforts` |
| aiclick 网关（Anthropic 方言） | 只有 `id`、`display_name`、`created_at`、`type` |
| mimo、qwen（OpenAI 兼容） | 只有 `id`（qwen 另有 `created`） |

结论：官方接口和部分服务商能直接提供能力字段，应当解析并采用；网关和多数国内兼容端点只给 id，只能用默认规则加用户配置。我们发 Anthropic 请求时没有带 `limit`，也不翻页，对官方端点最多只能拿到 20 个模型。

### 3.3 设计

把 `modelInputs`、`thinkingMode`、`modelThinking` 合并成一个按模型的能力对象，provider 级保留一份默认值：

```jsonc
"providers": {
  "aiclick": {
    "dialect": "anthropic",
    "modelDefaults": { "thinking": "adaptive" },          // provider 级默认，可选
    "modelCapabilities": {
      "claude-opus-5-5": {
        "inputs": ["image"],                              // 现有 modelInputs
        "contextWindow": 200000,                          // 示例值
        "maxTokens": 64000,                               // 示例值
        "reasoning": true,
        "thinking": "adaptive",                           // adaptive | budget | only | none
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "compat": { }                                     // 仅配置文件，见下
      }
    }
  }
}
```

**合并顺序**（逐字段，后者覆盖前者）：

1. **兜底默认**：`contextWindow` 未知时不自动归档，只靠溢出错误触发（§5.1）；`maxTokens` 未知时 Anthropic 用 8192，OpenAI 兼容不发；budget 总是夹紧（§4.2），默认值猜错也不会 400。
2. **方言与端点规则**：沿用 pi `detectCompat` 的思路，按 provider id 和 baseUrl 判定 `maxTokensField`、`supportsDeveloperRole`、`thinkingFormat`、`requiresReasoningContentOnAssistantMessages` 等。现有两份 id 子串表（daemon `provider::reasons`、agent `requires_adaptive_thinking`）收拢到这一层，只在 daemon 保留一份。
3. **远程发现**：按方言解析 §3.2 的字段。Anthropic 请求带 `limit=1000`，并按 `has_more` 翻页。
4. **用户配置**：`modelDefaults`，然后是 `modelCapabilities.<id>`。用户写了就以用户为准。

**界面**：设置页每个模型在现有图片/视频勾选旁边，增加“思考方式”“上下文窗口”“最大输出”三项，并标出每个值的来源（发现、默认、用户）。用户能看出哪个值是猜的，也知道该改哪里。`compat` 只开放给配置文件，不放进界面。

**Agent 侧**：`models.json` 下发合并后的完整能力。Agent 不再自己按 id 猜任何能力，只读配置。

**与 dev-0 provider 入口对接**：

- `ProviderDraft` 目前只有 `models`，并且设了 `deny_unknown_fields`。需要加一个可选的 `modelCapabilities`，Agent 可以通过 `provider configure --capability <model>:thinking=adaptive` 一类参数提出能力值。卡片上逐项展示，Human 确认后才写入，标记为用户来源。
- `provider::verify` 现在发的是不带 thinking 的 16 token 请求，Opus 5.5 这类必须用 adaptive 的模型也能通过。建议增加一次可选的思考探测：模型声明了 `reasoning` 时，用最终合并出的思考参数再发一次最小请求。拒绝原因在卡片上直接给出，例如“该模型要求 adaptive 思考”，不必等到会话里 400 才发现。
- 更新时 endpoint 或 dialect 变了，dev-0 会清掉旧 key。同样的情况下，发现层得到的能力也要作废，只保留用户写的值。
- 两条写入路径对“换 endpoint”的处理现在不一致：`provider_control` 的确认路径会清掉 `modelInputs`，但保留 `thinkingMode`/`modelThinking`；设置页的 `update_provider` 只清 key，三者都保留。目前没改，因为两种处理都有道理：清掉，旧网关的别名能力就不会带到新网关上；保留，同一批别名换个地址时不会重新出现 400。§3 落地时统一规则：用户写的能力保留，发现层得到的能力作废，两条路径共用一个函数。

### 3.4 与未合入改动的关系

`thinkingMode`/`modelThinking`（`d9adf9de` 和本地 `state.rs` 修复）还没进主干。建议合入前就改成 `modelCapabilities.<id>.thinking` 加 `modelDefaults.thinking`，避免刚上线的字段马上又要迁移。`modelInputs` 已经在主干上，读取时迁移到 `modelCapabilities.<id>.inputs`，写回只写新字段。

dev-0 也改了 `state.rs`（`update_provider` 的 endpoint 保护、`provider_operations`）、`config.rs`（删除 `agents.custom`）、`SettingsPanel.tsx`（重写 Agent 行）和 `domain.rs`。这些改动已在 dev-2 工作区里和 `d9adf9de` 合在一起：`ProviderConfig` 去掉了 `custom`，保留了 `thinking_mode`/`model_thinking`；`providers()` 的透传修复是在重构后的 `state.rs` 上重新应用的。§3 直接在这个基础上做，不会出现两份设置页或 ProviderConfig。

### 3.5 验收

- aiclick 网关：只给 id；用户在设置页把 `claude-opus-5-5` 设为 adaptive 后，请求体为 adaptive。
- Anthropic 官方 Key：不做任何手动配置，opus-5 自动得到 `contextWindow`、`maxTokens`、adaptive 和 effort 档位。模型列表多于 20 个时不截断。
- Kimi：自动得到视频输入、`only` 思考方式和 effort 档位。
- 设置页能显示每个字段的来源；单测覆盖四层合并，以及经过 `AppState::providers()` 的透传。

## 4. Provider 协议正确性（P0，均未修改）

v1 提的这几项都还没改。下面把现状和 pi 的实现逐项对照。

### 4.1 思考块完整回传

**现状**：`protocol.rs` 的 `Thinking { thinking }` 没有 signature 字段。`anthropic.rs` 解析流式输出时不处理 `signature_delta` 和 `redacted_thinking`。`convert_messages` 回放 assistant 消息时只保留 Text 和 ToolCall，Thinking 被 `_ => None` 丢弃。

**pi 的做法**（`anthropic-messages.ts`）：

- 流式解析：`thinking_delta` 累加文本，`signature_delta` 累加到 `thinkingSignature`；`redacted_thinking` 存成 `redacted: true` 的块，`data` 原样保留（600–672 行）。
- 回放（1179–1210 行）：带签名的 thinking 原样回放为 `{type: thinking, thinking, signature}`，redacted 的块回放为 `{type: redacted_thinking, data}`。没有签名的 thinking 改成纯文本，避免被服务端拒绝。
- 跨模型（`transform-messages.ts`）：只有同一 provider、同一模型的签名才保留，换模型后 thinking 转成普通文本。

**风险**：Anthropic 文档要求，开启 thinking 并使用工具时，上一轮 assistant 的 thinking 块必须原样带回，否则会报错或降低质量。这一点还没在真实网关上复现，fb_IX 那次关闭了 thinking，无法用来佐证。

**改法**：`Thinking` 增加 `signature: Option<String>` 和 `redacted: bool`（session.jsonl 向后兼容）。解析和回放按 pi 实现。移植 `transformMessages` 中同模型保留签名、跨模型降级为文本的逻辑。

### 4.2 max_tokens 与 budget 对齐

**现状**：`max_tokens` 取 `model.max_tokens.unwrap_or(8192)`，而 `max_tokens` 现在总是 None，实际就是 8192。budget 按档位取固定值（`provider/mod.rs`：minimal 1024 … high 8192，xhigh 16384，max 32768）。于是 high 档 `budget_tokens = 8192 = max_tokens`，xhigh 和 max 档 budget 超过 max_tokens。Anthropic 要求 `budget_tokens < max_tokens`，这三档在 budget 模式下必然 400。

**pi 的做法**：

- `simple-options.ts` `adjustMaxTokensForThinking`：调用方没有给上限时 `maxTokens = 模型 maxTokens`，否则取 `min(base + budget, 模型 maxTokens)`。如果 `maxTokens <= budget`，把 budget 降为 `max(0, maxTokens - 1024)`，至少给正文留 1024。
- `anthropic-messages.ts` 815–840 行：再经过 `clampMaxTokensToContext`，按上下文剩余空间夹紧；最终 `budget_tokens = min(budget, max(0, maxTokens - 1024))`。adaptive 模型走单独分支，不发 budget。

**改法**：移植以上两步。依赖 §3 提供的 `maxTokens`/`contextWindow`；未知时用兜底值，夹紧逻辑照样生效。

### 4.3 历史消息清洗

pi 每次请求前都会执行 `transformMessages`：模型不支持图片时把图片换成占位文本；规整 tool call id，满足各家对字符和长度的限制；补齐没有结果的 tool call；按 4.1 处理 thinking。我们没有这一层，历史原样发出。换模型、切换 provider、恢复中断的会话时都可能被拒。改法：在 provider 层之前增加一个对应的 transform，并配单测。

### 4.4 OpenAI 兼容：reasoning_content 与 compat

**现状**：`openai.rs` 能解析 delta 里的 `reasoning_content`，但回放时从不带回。凡是 `model.reasoning` 为真就发 `reasoning_effort`。

**pi 的做法**（`openai-completions.ts`）：

- 1145–1202 行：`requiresReasoningContentOnAssistantMessages` 为真时，把 reasoning 文本作为 assistant 消息的 `reasoning_content` 带回。DeepSeek、Kimi 这类“思考必开”的模型需要这样做。
- 1421–1480 行 `detectCompat`：按 provider/baseUrl 判定。`useMaxTokens` 名单决定用 `max_tokens` 还是 `max_completion_tokens`；grok、zai、moonshot、together 等不支持 `reasoning_effort`，不发；DeepSeek 用 `thinkingFormat: "deepseek"`。

**问题**：pi 的 `isMoonshot` 判断的是 `api.moonshot.`，匹配不到我们用户实际使用的 `api.kimi.com`。照搬会漏掉 Kimi，所以规则表要按我们自己的端点补全，并允许用户通过 `compat` 覆盖。Kimi 返回 `supports_thinking_type: only`，对应 `thinking: "only"`：不能关闭思考，界面也不提供“关闭”选项。

### 4.5 P1 项

- `thinking.display`：pi 支持 summarized/omitted（234 行）。我们可以按模型能力选默认值，减少回传体积。
- xhigh/max 档：模型通过发现层声明支持时，原样映射到 `output_config.effort`；现在 `adaptive_effort` 把它们统统压成 high。
- `cache_control`：给 system prompt 和最近一条消息打缓存断点。
- 解析 stop reason 和 usage，作为 §5.1 归档阈值的依据，也用于界面展示。

## 5. 上下文与运行时

### 5.1 自动归档换轮（P0，替代 v1 的“自动压缩”）

v1 写的“自动压缩”不对。GeneHub 的上下文机制不是压缩，而是归档：

- 完整历史一直保留在 `chat.jsonl`/rounds 里，不改写，也不丢弃。
- `genet session context`（`session/context_seed.rs`）是一份确定性投影：按 token 预算（默认 16000，范围 2048–64000，取窗口的 35%）选取最近和关键的内容，每段都带 `ghref`，需要原文时可以按引用回查。生成投影不调用模型。
- fork 用的上下文种子和内置 Agent 的 `/compact` 都复用这份投影（`lib.rs` `run_compaction` → `fetch_context_material`）。目前 `/compact` 还会让一个无工具的子 Agent 再写一份摘要，失败时退回投影原文。

pi 的 compaction 是另一回事：由模型生成摘要并替换历史，原文不再进入后续上下文。我们不移植这一套。

**真正缺的是自动触发**：`set_auto_compaction` 只保存了开关；`agent.rs` 每轮都把 `session.messages` 全量发出，没有阈值，也没有溢出处理。会话一长就会撞上下文上限，直接失败。

**设计**：

- 触发条件：
  - 阈值：已知 `contextWindow` 时，上一轮 usage（没有就估算）超过窗口的约 80%，在下一次请求前归档换轮。
  - 溢出：请求因上下文过长被拒（移植 pi 的 overflow 错误匹配规则），先归档换轮，再重放一次本轮请求；第二次仍然溢出就报错，不再循环。
- 换轮内容：默认只用确定性投影加引用，不调用模型，快、可复现、不额外花钱。模型摘要作为可选项，保留现在 `/compact` 的行为。
- 不变量：当前这条用户消息、未配对的 tool call/result 不进归档，原样留在新上下文里；归档前后都写事件（沿用 compaction_start/end），界面能看到发生了一次换轮。
- `set_auto_compaction` 真正生效，默认开启。命名上建议改成 auto-archive，旧名保留兼容。

**与 dev-0 的衔接**：

- 阈值判断用上一轮真实 usage。如果 `token_usage_reported` 为假（服务端没报用量），改用估算，不能把 0 当成“上下文很空”。
- 归档换轮发生在两次请求之间，不在执行暂停期间。如果执行因 `session ask` 停止，等回答后启动新执行时，在第一次请求前再判断一次阈值。
- 内置 Agent 已经有原生的 `request_user_input` 工具，它必须是那条 assistant 消息里唯一的工具调用（`agent.rs`）。归档时把这次调用和它的回答当成一对，不能拆开放进归档。

**验收**：fake provider 先返回一次溢出错误，Agent 自动换轮并重放成功；新上下文包含投影和 `ghref`；当前消息和未配对工具调用保持原样；关闭开关后溢出直接报错。

### 5.2 自动重试（P0）

pi 对 429、5xx、overloaded、网络中断做指数退避重试，并把重试状态作为事件发给界面。我们遇到这些错误时直接失败，用户只看到 Agent 退出或报错。这一项从 [builtin-agent.md](builtin-agent.md) §2.3 的“明确不做”移出：尊重 `retry-after`，有次数和总时长上限，用户中断时立刻停止。上下文溢出不在重试范围内，交给 §5.1 处理。401/403 也不重试：这类错误改为提示 Agent 用 `provider verify` 检查配置，或者让用户重新配置（dev-0 的 provider 卡片）。

### 5.3 P1/P2

- steering 和 follow-up 队列（P1）：运行中追加的消息，在下一个工具结果之后插入；对齐 pi 的 `steer`/`followUp` 语义。
- 工具细节（P2）：输出截断说明、读文件按行分页、bash 超时提示与 pi 对齐。

实现说明（steering）：Agent 实现了 `steer`、`follow_up` 和 `prompt.streamingBehavior`。接纳消息和“这次运行是否停下”在同一把锁下判断，所以消息不会在运行结束的瞬间丢失；运行提前结束时剩下的消息照样写入会话。daemon 侧在 `AgentSession` 上加了默认返回 `Ok(false)` 的 `steer`，只有 genet 实现。用户在运行中输入时，inbox 先尝试 steer（等待 Agent 回答，最长 5 秒），成功后这些输入算作当前执行的一部分，随这一轮一起结算。Agent 拒绝、超时、输入带附件，或会话正在等权限/决策时，回退到原来的“中断后重新投递”。第三方 Agent 继续走中断。

## 6. 宿主形态的特有问题

### 6.1 系统提示词怎么传给各家 Agent（P1）

daemon 每个会话都要附加一段引导：产物链接规则，加上 Skill 目录（`<genehub_cli>` 和 `<available_skills>`，见 `skills.rs` `session_guidance`）。主干上约 4.4 KB，dev-0 又加了约 1.4 KB。各家的传法：

| Agent | 主干（重构前） | dev-0（重构后） |
|---|---|---|
| 内置 genet | argv `--add-system-prompt <文本>`（`adapter/genet.rs`） | 不变 |
| Codex | JSON-RPC `developerInstructions`（`adapter/codex.rs`） | `serve` 的 `session.start` 带上 `additionalSystemPrompt`，脚本再写进 `developerInstructions`（`codex_session.py`） |
| Cursor | 拼到用户消息前面（`adapter/cursor.rs`） | 同样拼到前面，整段 prompt 走 stdin（`cursor_print.py`） |
| Claude Code、CodeBuddy | argv `--append-system-prompt <文本>` | 适配器已删，第一期不提供 |
| ACP、OpenCode | `_meta.systemPrompt.append`、HTTP `system` 字段 | 适配器已删，第一期不提供 |
| pi（参考） | `--append-system-prompt <文本或文件路径>`（`resource-loader.ts` `resolvePromptInput`） | — |

argv 本身没有问题，重构前 Claude Code 和 CodeBuddy 也是这样传的，一直能用。dev-0 合入后，用 argv 传提示词的只剩内置 Agent，其他 Agent 都通过协议或 stdin 传。实际问题有三个：

1. **进程命令行会被 `ps`/`pgrep -f` 看到**。几 KB 的提示词加上工作区路径，几乎能命中任何宽松的 grep 正则。fb_IX 就是这样把宿主进程 kill 掉的（§1.2）。
2. **长度**：Linux 单个参数上限 128 KB，Windows 整条命令行上限约 32 KB。引导文本已经从 4.4 KB 涨到约 5.8 KB，Skill 目录还会随用户安装量继续增长。
3. **`--session` 用的是工作区内的绝对路径**，这是命中 `dev-0` 的另一半。

**改法**（二选一，推荐第一种）：

- **走 RPC**：内置 Agent 本来就以 `--mode rpc` 运行。增加一条启动后的配置消息（或者在第一条 RPC 里带上），把附加提示词和 session 路径都放进去，argv 只留模式和模型。这和 dev-0 给脚本 Agent 定的 `additionalSystemPrompt` 是同一个思路，以后内置 Agent 直接说 `serve` 协议时也能直接沿用。
- **走文件**：`--add-system-prompt` 同时接受文本和文件路径，与 pi 的 `resolvePromptInput` 一致。daemon 把引导写到 scratch 目录，只传路径。改动更小，但 scratch 路径仍然在 argv 里。

这只能降低误命中的概率，不能根除。真正兜底的是 §6.3。

实现说明：采用“走 RPC”。daemon 启动 `--mode rpc --configure-from-stdin [--model] [--thinking]`，stdin 第一行是 `{"type":"configure","session","genehubSessionId","systemPrompts":[...]}`。argv 里不再出现提示词、session 路径和会话 id。独立运行时原来的 argv 参数仍然有效。

### 6.2 信号退出要看得见（P0）

`apps/host/src/process.rs` 用 `status.code().unwrap_or(-1)`，被信号杀掉时只留下 -1，stderr 也为空，界面只能显示“Agent 退出了，而且它什么都没说”。改法：在 Unix 上读 `ExitStatusExt::signal()`，事件里带上信号名（如 `SIGKILL`/`SIGTERM`）。界面文案按情况区分：被信号终止、可能是 OOM、正常非零退出。daemon 在会话里补一条说明，下一轮把这件事告诉 Agent。

dev-0 合入后，平台自己也会主动停止进程：持久暂停、取消、受控重启时，SDK 会给整个进程组发 SIGTERM（`genehub_agent/process.py` `kill_tree`）。所以停止前要先记一笔“这是平台发起的停止”。收到信号退出时，如果有这条记录，就按正常停止处理；没有记录，才报告“被外部信号终止”。否则持久暂停每次都会显示成异常退出。

### 6.3 Agent 不误杀自己（P0）

- 环境变量：给 Agent 进程导出 `GENEHUB_AGENT_PID` 和 `GENEHUB_HOST_PID`，并写进提示词，作为 Agent 可依赖的契约。现有的 `GENEHUB_LOCAL_HOST_PID` 只用于 daemon 内部校验，不对 Agent 公开。
- 提示词规则：结束进程前，先排除自己和祖先进程；优先按 PID 文件或端口查找，不要用宽泛的 `grep | kill`。
- 内置 Agent 的 bash 工具可以再加一道检查：命令中出现的 PID 如果属于自己或祖先进程，就拒绝执行并说明原因。第三方 Agent 做不到这一步，只能靠前两条。脚本 Agent 的环境变量统一在 SDK 的 `child_environment` 里导出，不用每个脚本各写一遍。
- 被信号终止后，daemon 在会话里留言说明，用户续聊时 Agent 能知道上一轮是怎么结束的（与 §6.2 联动）。

### 6.4 Skill 确定性激活（P1）

和 pi 一样，现在只注入名字和描述，读不读由模型自己决定（§1.1）。改为两级：

- 用户消息或导入历史中出现某个 Skill 的名字（如 `openplay-guidance`），或命中 Skill 声明的触发词时，daemon 在本轮提示词里附上一条提醒：“动手前先读 `<path>/SKILL.md`”。只附路径，不附正文，避免撑大上下文。
- 内置 Agent 记录本会话是否读过对应的 SKILL.md；写文件时如果命中某个 Skill 负责的目录而 SKILL.md 还没读过，就在工具结果里提示一次。

实现说明：按 Skill 的来源分工。daemon 编目的产品 Skill，由 daemon 对所有 Agent 统一提醒：消息里按整词、区分大小写匹配到 Skill 名字时提醒，同一会话只提醒一次；这一步在正常投递和 steer 两条路径上都做（`skills::mention_reminder`）。内置 Agent 自己编目的 Skill 由 `apps/agent/src/skill_guard.rs` 负责。它从会话历史判断某个 SKILL.md 是否读过、是否已经提醒过，所以 Agent 重启或续聊后结论不变。Skill “负责的目录”是它自己所在的目录，加上 frontmatter 新增的 `paths` glob（相对工作目录）。“命中触发词”没有实现，因为 Skill 标准里没有这个字段，目前只按名字匹配。

## 7. 验证方式

- **请求体快照测试**：对每种方言 × 思考方式（adaptive/budget/only/none）× 档位生成请求体并断言：`budget_tokens < max_tokens`；adaptive 模型不发 budget；签名原样回放；跨模型时 thinking 降级为文本。
- **从 pi 移植的用例**：`adjustMaxTokensForThinking`、`transformMessages`、overflow 错误匹配都有现成的输入输出，直接改写成 Rust 单测。
- **真实端点冒烟**（手动或 nightly，需要 Key，不进 CI）：aiclick `claude-opus-5-5`、Anthropic 官方、Kimi 各跑一轮“开思考 + 两次工具调用”，确认不出现 400。
- **配置链路**：从配置文件到 `AppState::providers()`、models.json、Agent 请求体，端到端断言（这次 `thinkingMode` 丢失就是这一段缺测试）。
- **宿主场景**：在测试里让 Agent 执行 `kill` 自身 PID，断言被 bash 工具拦截；直接给 Agent 进程发 SIGKILL，断言界面显示信号名。

## 8. 里程碑

**合入顺序**：

1. dev-0 的脚本化重构已在 dev-2 工作区里，和 `d9adf9de`、`state.rs` 修复对齐（§3.4）。dev-0 后续再改，要从 dev-0 重新同步。dev-0 仍在测试，最终以 dev-0 提交的版本为准，dev-2 的这份副本不要单独上主干。§3 在这个基础上做。
2. §4 和 §5 几乎只改 `apps/agent`。dev-0 在这里只加了 `token_usage_reported` 一个字段，可以和 dev-0 并行开发。
3. `d9adf9de` 和本地 `state.rs` 修复放进 §3 一起改：字段改名为 `modelCapabilities`/`modelDefaults` 后随 M1 合入，不单独上线 `thinkingMode`。如果 Opus 5.5 的 400 需要先发热修，就只合 `d9adf9de` 和 `state.rs` 修复，§3 落地时再做迁移。

**M1（下个版本，P0）**

- §3 统一模型能力配置，含 Anthropic 分页、Kimi 字段解析，以及 `provider configure` 的能力参数和 `verify` 的思考探测。
- §4.1–4.4：思考签名回传、max_tokens 与 budget 夹紧、历史清洗、`reasoning_content` 回传与 compat 规则。
- §5.1 自动归档换轮：先做溢出触发和单次重放，阈值触发依赖 §3 的 `contextWindow`。
- §5.2 自动重试。
- §6.2 信号退出可见；§6.3 环境变量、提示词规则和 bash 自保护。

**M2（P1）**

- §4.5：display、xhigh/max、cache_control、usage。
- §6.1：附加提示词和 session 路径改走 RPC，argv 里不再出现它们。
- §6.4 Skill 确定性激活。
- §5.3 steering/follow-up。

**M3（P2）**

- 工具细节对齐；固定一组回归任务，内置 Agent 与 pi 在同一模型上对比成功率和 token 消耗。

**同步修改 [builtin-agent.md](builtin-agent.md)**：§2.3 去掉“自动重试”“steering”两项（远程模型目录仍然不做）；§3.1 记录附加提示词改走 RPC；§7.2 删去“上下文窗口和推理能力不在任何 provider 返回里”的说法，改为指向 §3 的四层合并；§8 按本提案的里程碑更新。

**明确不做**：pi 的生成式模型目录；pi 的 LLM 摘要式 compaction（我们用归档）；TUI、扩展系统、OAuth 登录。
