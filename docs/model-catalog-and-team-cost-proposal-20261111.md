# 模型档位目录与团队成本统计提案

> 已批准快照：Human `u_cd48b68b03b2452b94544af72a15be1e` 要求落地；本快照保存原提案内容（其中待评审/分期措辞为历史），实施以本期最新指示和交付记录为准。源dev-2/docs同名文件摘要 `e91500e236d6ae6993494f41056c098909df9d8712599c3d817f8e32d5ef52e8`。

- 状态：待评审（未实施）
- 日期：2026-11-11（同日修订：成本改为倍率制；超低档改为标示成本；匹配改为家族加版本范围）
- 范围：平台模型档位推断（daemon `apps/daemon/src/agent_routing.rs`、工作台
  `packages/workbench/src/session/capability-preferences.ts`），以及团队样板的成本与时间统计
- 依据版本：`worktrees/dev-2/genethub` 当前 `dev-2` 分支（dev.25）
- 外部价格：2026-11-11 读取 [Cursor Models & Pricing](https://cursor.com/docs/models)、
  [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)、
  [CodeBuddy 选择模型（积分倍率）](https://www.codebuddy.cn/docs/workbuddymini/features/Select-Model)、
  [CodeBuddy 定价](https://www.codebuddy.cn/docs/ide/Account/pricing)

## 摘要

1. **用户体验影响**：现在只靠模型名里有没有 `max`/`pro`/`flash` 来猜档位。Claude Fable 5.2、GPT-6 Astra 这类
   最贵最强的模型会被标成"能力 Flash、成本中"，按档位路由时可能被当成便宜的轻量模型选中，或者在需要最强
   能力时选不到。团队也没有任何成本数字，无法判断"并行到 5"或换模型到底花了多少。
2. **解决办法**：
   - 参考 CodeBuddy 的积分倍率，**底层存储的事实改为成本倍率**；超低、低、中、高、超高只作为倍率区间的口语化名称，方便与 Agent 交流。
   - 接口同时返回档位和倍率；用户可以设档位，也可以直接设倍率。
   - 内置目录按"模型家族加版本范围"匹配，再叠加 Fast 等变体系数；匹配不到时为"能力最低、成本超高"。
   - 超低档不按 0 计，使用约为低档 1/10 的标示倍率 0.01。
   - 团队用每轮已有的 Token 记录乘以倍率估算推理成本，用已有的执行区间统计时间成本。
3. **防止复发**：一组真实模型名作为回归用例；`models explain` 显示每个模型命中了哪条规则；
   新模型未匹配时工作台标出"未识别"。

## 一、现状

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 能力档推断 | 名称含 `max` → Max；含 `pro` → Pro；其余一律 Flash | `agent_routing.rs` `inferred_profile`（约 798–835 行） |
| 成本档推断 | 名称含 `flash`/`flush` → 低；其余一律中 | 同上 |
| 第二份实现 | 工作台有自己的 `inferredModelProfile` | `capability-preferences.ts` 约 80–92 行 |
| 推断值会被写成"已保存" | 工作台规范化配置时把推断出的 `cost`、`tags` 合并进保存的模型配置，之后无法区分用户设置与推断 | 同上 |
| 已有档位定义 | 能力：Ultra / Max / Pro / Flash / Mini；成本：超低 / 低 / 中 / 高 / 超高（枚举 `AgentCostLevel`） | `capability-preferences.ts` 第 20–36 行；`domain.rs` |
| Token 记录 | 每轮已记录输入、输出、缓存读、缓存写和调用轮数，以及"用量不可用"状态 | `packages/proto/src/event.rs` `Usage` |
| 团队成本指标 | M4 只用执行时长，与本队最早 20 项比较，没有用到 Token | `team-template/tools/genet_builtin/quality_score.py` 233–238 行 |

## 二、成本倍率

### 倍率的含义

**倍率 1.0 ≈ 在 Agent 典型 Token 构成下，每百万 Token 约 1 美元。**

- 典型构成：约 87% 缓存读、12% 未缓存输入、1% 输出。
- 某个模型的倍率 = 0.87 × 缓存读单价 + 0.12 × 输入单价 + 0.01 × 输出单价（美元/百万 Token）。
- 校验：GPT-6 Astra 算得 2.57，与公开统计一致。

这个基准恰好与 CodeBuddy 的倍率处在同一量级：DeepSeek Flash 我们算得 0.05，CodeBuddy 为 0.06；Kimi K3 我们算得 0.77，
CodeBuddy 为 1.62。同一模型在不同平台的倍率不必相同，因为单位和计费方式各异。

### 档位与倍率的对应

| 档位 | 倍率区间 | 只设档位时取的倍率 | 代表模型（算得的倍率） |
| --- | --- | --- | --- |
| 超低 | < 0.02 | 0.01（约等于免费，是低档的 1/10） | 用户自己的 CodingPlan、包月套餐内的模型、限免模型 |
| 低 | 0.02–0.2 | 0.1 | Claude Haiku 5.5（0.03）、GPT-6 Luna（0.03）、DeepSeek V4.1 Flash（0.05）、GLM 5.3 Flash（0.05）、DeepSeek V4 Pro（0.16） |
| 中 | 0.2–0.6 | 0.4 | GPT-6.1 Terra（0.21）、Kimi K2.7（0.32）、Claude Sonnet 5.5（0.43）、GPT-6.1 Sol（0.43）、GLM 5.2（0.45） |
| 高 | 0.6–1.2 | 1.0 | Kimi K3（0.8）、Claude Opus 5.5（0.85）、GPT-5.6 Sol（1.0） |
| 超高 | ≥ 1.2 | 2.5 | Claude Fable 5.x（约 2.0）、GPT-6 Astra（2.6）、"高"档模型开 Fast 模式（×2） |

超低档使用标示倍率 0.01，而不是 0：
- 成本报表里仍能看出用了多少超低档资源；
- 路由按成本排序时超低档自然排最前；
- 与"真正免费"之间只差一个很小的常数，不影响判断。

### 存储与接口

- **存储**：模型配置保存 `costMultiplier`（数值）与 `costSource`（`user` / `catalog` / `provider` / `fallback`）。
  档位不单独存储，而是由倍率按上表区间推出。
- **设置**：用户或 Agent 设档位时，写入该档位的默认倍率（例如设"低"写 0.1）；直接设倍率时，档位按区间自动推出。
- **读取**：接口同时返回档位和倍率，例如：

```json
{ "agentId": "claude", "modelId": "claude-fable-5-2", "capability": "Ultra",
  "cost": { "level": "veryHigh", "multiplier": 2.0, "source": "catalog", "rule": "claude-fable" } }
```

- **兼容**：现有 `cost` 枚举字段继续返回，旧客户端不受影响。
  - 已保存的档位值如果与旧推断结果相同，视为自动写入，迁移后改按目录推断；
  - 不同则视为用户设置，换算为该档位的默认倍率。

### 超低档来自服务方，而不是模型名

同一个模型，走用户自己的 CodingPlan 几乎免费，走按量 API 时很贵，所以超低不放进模型目录：

- 用户通过 `provider configure` 接入的服务方带一个计费类型，例如 `plan` / `free` / `metered`；
- `plan` 和 `free` 下的模型倍率一律为 0.01，来源记为 `provider`；
- 能力档仍按目录匹配。

## 三、灵活又准确的匹配

### 简单正则为什么不够

同一个模型在不同渠道的名字差别很大，例如 `claude-fable-5-2`、`us.anthropic.claude-opus-5-5-20261001`、
`openrouter/anthropic/claude-haiku-5.5`、`claude-sonnet-5.5-thinking`、`GLM-5v-Turbo`。
把版本号写死在正则里会带来三个问题：新版本一出就匹配不上；同一家族不同版本价格不同时规则互相覆盖；
"最长正则优先"这类特异性判断不可靠。原型里就出现过通用规则压过具体版本规则的情况。

### 方案：先归一化成"家族 + 版本 + 变体"，再按版本范围选规则

1. **归一化**：转小写，去掉 `agent/`、路由前缀（如 `openrouter/`）、区域前缀（`us.`）和厂商前缀（`anthropic.`）；
   分隔符统一为 `-`。
2. **剥离噪声与变体**：
   - 剥掉日期快照（`-20261001`）、`-latest`、`-preview`、`-thinking`、`-1m` 等不影响价格档的后缀；
   - 识别 `-fast` 等变体，单独记录；
   - 把 `5-2` 统一为 `5.2`。
3. **拆出版本**：`claude-opus-5.5` 拆成家族 `claude-opus`、版本 `5.5`；`gpt-6.1-sol` 拆成 `gpt-sol` 与 `6.1`；
   `deepseek-v4.1-flash` 拆成 `deepseek-flash` 与 `4.1`。
4. **选规则**：
   - 规则的 `family` 是对家族名做**整串匹配**的正则，可以写别名，例如 `glm(-turbo|v-turbo)?`；
   - 可选的 `versions` 是版本范围，例如 `..4.99`、`5.6..5.6`、`3..`；
   - 命中多条时，**版本范围最窄的规则优先**，没有范围的家族规则作为默认。
5. **叠加变体系数**：`fast` ×2（可配置）。叠加后再按区间推出档位。
6. **兜底**：没有任何规则命中时，能力 Mini、成本超高（倍率 2.5），来源 `fallback`，工作台显示"未识别，请设置"。

```json
{
  "schema": "genehub.model-catalog.v2",
  "updated": "2026-11-11",
  "modifiers": { "fast": 2.0 },
  "rules": [
    { "family": "claude-fable", "capability": "Ultra", "multiplier": 2.0 },
    { "family": "claude-opus", "capability": "Max", "multiplier": 0.85 },
    { "family": "claude-opus", "versions": "..4.99", "capability": "Max", "multiplier": 1.0 },
    { "family": "gpt-sol", "capability": "Max", "multiplier": 0.43 },
    { "family": "gpt-sol", "versions": "5.6..5.6", "capability": "Max", "multiplier": 1.0 },
    { "family": "kimi-k", "versions": "3..", "capability": "Max", "multiplier": 0.8 },
    { "family": "glm(-turbo|v-turbo)?", "capability": "Pro", "multiplier": 0.45 }
  ]
}
```

新出的 `claude-fable-6`、`gpt-6.2-terra` 不需要新规则，会自动沿用家族默认；只有价格明显不同的版本才需要加一条带版本范围的规则。

### 原型验证

原型 `docs/evidence/proposals-20261111/catalog_proto.py`（18 条规则）对 21 个真实模型名全部归类正确。部分结果：

| 输入 | 归一化与拆分 | 命中规则 | 结果 |
| --- | --- | --- | --- |
| `claude/claude-fable-5-2` | `claude-fable` 5.2 | `claude-fable` | Ultra，2.0，超高 |
| `claude/claude-fable-6` | `claude-fable` 6 | `claude-fable`（新版本自动沿用） | Ultra，2.0，超高 |
| `bedrock/us.anthropic.claude-opus-5-5-20261001` | `claude-opus` 5.5 | `claude-opus` | Max，0.85，高 |
| `claude/claude-opus-4-8-fast` | `claude-opus` 4.8，变体 fast | `claude-opus ..4.99` | Max，1.0×2 = 2.0，超高 |
| `cursor/claude-sonnet-5.5-thinking` | `claude-sonnet` 5.5 | `claude-sonnet` | Pro，0.43，中 |
| `codex/gpt-5.6-sol` | `gpt-sol` 5.6 | `gpt-sol 5.6..5.6` | Max，1.0，高 |
| `codex/gpt-6.1-sol` | `gpt-sol` 6.1 | `gpt-sol` | Max，0.43，中 |
| `codebuddy/GLM-5v-Turbo` | `glmv-turbo` 5 | `glm(-turbo|v-turbo)?` | Pro，0.45，中 |
| `codebuddy/Kimi-K2.7-Code` | `kimi-k-code` 2.7 | `kimi-k(-code)? ..2.99` | Pro，0.32，中 |
| `foo/bar-1` | `bar` 1 | 无 | Mini，2.5，超高（未识别） |

### 准确性的其他来源（优先级高于目录）

- **服务方返回了价格**（例如 OpenRouter 这类网关的模型列表带单价）：直接按公式算倍率，来源记 `provider`。
- **Agent 的模型目录自带倍率**（CodeBuddy 的模型列表带积分倍率）：可作为参考来源，需要一个换算系数。
  这一项待实测后决定是否启用。

### 可解释与可维护

- `genet models explain <agent>/<model>` 输出归一化结果、家族、版本、变体、命中规则、最终倍率与档位及来源，
  便于排查"为什么被判成超高"。
- 回归用例：一份"真实模型名 → 期望能力与档位"的表，随目录一起更新；目录改动必须让该表全部通过。
- 用户覆盖文件与内置目录同格式。覆盖文件中的规则优先于内置规则，但低于用户对单个模型的显式设置。

### 优先级汇总

用户对单个模型的显式设置 > 服务方计费类型（超低）或服务方价格 > 用户覆盖目录 > 内置目录 > 兜底。

## 四、团队成本统计

### 推理成本（Token × 倍率）

- **等效 Token**：把四类 Token 折成"典型构成下的 Token"。权重取中档典型模型的单价比例，
  使典型构成正好折成 1：

  等效 Token = 0.23 × 缓存读 + 4.7 × 未缓存输入 + 5.9 × 缓存写 + 23 × 输出

- **每轮成本（约等于美元）** = 倍率 × 等效 Token ÷ 1,000,000。适配器只报总量、不分类型时，等效 Token 取总量。
- 推理强度不另加系数，因为推理产生的 Token 已计入输出；Fast 等变体已体现在倍率里。
- 报告"用量不可用"的轮次记为未知，并报告覆盖率，不估造。
- 归属：按团队账本把会话归到任务树，汇总为"每个任务""每个被采用的工作项""每小时"三级。

### 时间成本

只统计两个数，都来自已有数据：

1. **交付周期**：从任务开始到结果被采用的墙钟时间，取中位数和 90 分位；
2. **Agent 工时**：任务树里各会话实际执行时间之和，扣除暂停和等待用户的时段。

这和新的 R6 口径用的是同一组事实：任务并行度 = Agent 工时 ÷ 有效墙钟时长。人的时间继续由 M3（人的介入）表示。

### 报表示例（拟议输出）

```text
python3 tools/run.py quality cost --hours 1
小时 14:00–15:00  用量覆盖率 92%（3 轮用量不可用）
  推理成本  4.80（超高 61%、中 35%、低 4%）
  Agent 工时 3.1 h
  已采用 5 项：每项 0.96，交付周期 P50 22 min / P90 48 min
  超过 30 分钟的任务 2 个：并行 2.6 / 1.4
```

### 与评分的关系

本轮实验截止前只作为并列报表，不进入分数，避免评分口径再次变化。实验结束后，用"每个被采用工作项的成本
与 Agent 工时"替换 M4 现在的执行时长口径（与《团队工作质量评估改进与有效并行提案》S4 一致）。

### 验收

- 用一个冻结的测试账本（含已知 Token 数和倍率）计算出的成本与手算一致；用量不可用的轮次显示为未知并计入覆盖率。
- 同一模型从"中"改为倍率 2.0 后，新产生的成本按新倍率计算，已出的小时报表不变。
- 走 `plan` 服务方的模型成本为倍率 0.01，不为 0。

## 兼容与恢复

- 目录只影响**未被用户设置**的模型；路由逻辑（按标签与成本排序）不变，排序依据由档位改为倍率，档位相同时结果不变。
- 目录文件格式错误时，daemon 继续使用上一份有效目录并报告错误，不回退到"全部超高"。
- 成本报表只读账本与会话记录，不改变派单、不消费收件箱。

## 未决问题

- 服务方计费类型字段放在哪里（`provider configure` 参数还是服务方配置文件），需要和现有服务方回执格式一起确定。
- 价格会变（例如 Gemini 4 Carbon 12 月起涨价），需要决定内置目录的更新节奏，以及过期价格如何标注。
- 各外部 Agent（Claude Code、Codex、CodeBuddy、Cursor）是否都报告缓存读写的 Token，需要逐个适配器实测。
- 等效 Token 的权重取中档典型模型的比例；对缓存比例很低的会话会有偏差，必要时按目录中的具体单价逐类计算。
