# GeneHub Qwen3-ASR 语音输入落地方案

> 状态：Speech Protocol v2、社区 runtime 登记/探测、流式 Best-1 和能力驱动的候选审核均已实现。首选 `Qwen3-ASR-1.7B`，也允许同类模型通过同一契约接入。
>
> GeneHub 只交付 UI、端到端连接协议、上下文与纠正数据接口，以及可在设置中启用的确定性协议 Stub。模型下载、Python/CUDA 环境、量化、真实推理和模型专用 adapter 由官方或社区方案负责。完整进程协议见 [speech-runtime-adapter.md](speech-runtime-adapter.md)。

## 1. 首版范围

首版只解决一件事：把一段录音转成可审核文字，再放进现有 Agent 输入框。

- 非实时对话；录音时持续分块传输和允许 runtime 增量编码，停止后才返回最终结果，不等待停止后再上传整段音频。
- 默认推荐 `Qwen3-ASR-1.7B`，不做模型选择器和多 Provider 抽象；同类模型可由社区 adapter 真实声明能力后接入。
- runtime 可在录音中返回 revisioned Best-1 完整替换；一整次录音仍只形成一条 Composer 输入。
- 只有 runtime 真正返回整句/分段 N-best 和不确定片段时才展示候选；Best-1-only 是合法的首版能力。
- 有真实局部候选时，每段可标记低置信文本范围，并给出 2–5 个局部可读选项。
- 默认候选进入输入框，但绝不自动发送。
- 用户可只替换某一段而不改动其他段，也可继续手工修改。
- 工作区 ID 由当前会话自动携带，用户不维护另一套 ID。
- 项目背景来自显式 `.genethub/speech/` 文件、最近对话、当前草稿及有限的项目名称索引。
- 用户明确开启后，主动候选选择沉淀为项目内偏好样本。

首版不做：

- 由 GeneHub 自行执行模型安装、CUDA/ROCm 管理、量化选择或模型下载；内置 Agent Skill 只按用户确认后的社区方案指导、验证和登记；
- 实时字幕、实时对话、说话人分离、情绪识别；
- Cloud/Relay 侧语音业务 API、音频落库或模型代理；
- 自动把整仓源码塞进 prompt；
- 把 beam score 宣称为校准置信度；
- Stub 音频留存，或把 Stub 固定候选用于声学模型/DPO 训练。

## 2. 产品边界

```text
Workbench / Desktop / Mobile
  ├─ 录音、真实本地波形、停止、取消
  ├─ 内置协议 Stub：按正式链路发送 PCM，返回明确标记的固定测试结果
  ├─ 展示本次 Qwen3 prompt 与术语
  ├─ 展示分段 N-best 与低置信词组
  └─ 选择后仍停留在 Composer 审核态
                 │
                 │ speech.transcribe（protocol-v3 logical stream）
                 ▼
目标设备 daemon
  ├─ speech capability 与 workspace scope
  ├─ Qwen3 context compiler
  ├─ 音频格式、长度、顺序与背压限制
  ├─ Qwen3 runtime adapter boundary
  └─ .genethub/speech 偏好记录
                 │
                 └─ 社区 Qwen3 PC runtime（用户自行安装）
```

Relay 仍只搬运 E2EE Fabric/RTC 数据帧，不认识音频、prompt、候选或纠正记录。更换社区 runtime 不改变 Workbench 接口。

## 3. 协议 Stub 体验

Stub 的目标是让没有 GPU 或尚未安装模型的环境验证完整产品行为，并为 Adapter 作者提供可观察的行为基线；它不假装做 ASR：

1. 用户点击麦克风后立即请求真实设备权限，并在浏览器内存中采样；
2. 实时波形来自真实输入，PCM 经正式 `speech.transcribe` logical stream 分块送到 daemon；daemon 只在内存中消费并计时，不保存音频；
3. daemon 编译当前工作区的真实 Qwen3 prompt，并让 Stub 返回 `implementation=stub`、`model=no-model` 和 `mockRelative` 分数；
4. Stub 随收到的音频时长发送单调 revision 的完整 Best-1 replacement，验证 Ready、Audio、Partial、Finish 与 Completed 全链路；
5. 停止并释放麦克风后生成 3 个稳定的整句候选，以及两个带时间范围的分段；
6. 每段返回 3 个候选和一个低置信词组，分别演示 Best-1、模型名与 DPO 术语纠正；
7. 至少一个候选使用本次项目术语，便于验证专业词 UI；
8. 用户选择局部词组或完整段候选后，只替换该段，Composer 不发送；
9. Stub 候选选择只验证交互；Web 不提交反馈，daemon 也按 `stub`/`mockRelative` 双重拒绝写入训练数据。

设置页和录音状态必须持续显示“协议 Stub / 未运行模型 / 固定测试文字”，防止把固定示例误认为模型结果。Stub 只临时覆盖 runtime 选择，不删除已登记 Adapter；关闭后立即恢复真实 runtime。

## 4. Speech Protocol v2

能力键：

```text
speech.transcribe.v2
speech.transcribe.partial.v1
speech.context.preview.v2
speech.feedback.v2
```

控制 RPC：

| RPC | capability | 作用 |
| --- | --- | --- |
| `speech.capabilities` | `read` | 返回 Qwen3 runtime、音频、prompt、N-best 与分段能力 |
| `speech.settings.setQwen3` | `settings` | 保存 Stub 选择、上下文、固定术语、语言提示与纠正收集开关 |
| `speech.runtime.probe` | `settings` | 用户主动检查当前 runtime adapter |
| `speech.runtime.configure` | `settings` + loopback | 事务性探测并登记/移除本机绝对路径 adapter；远端调用被拒绝 |
| `speech.context.preview` | `speech` | 编译下一次录音会使用的精确 prompt snapshot |
| `speech.feedback.record` | `speech` | 记录一次明确的人工候选选择 |

转写不是 RPC 大对象，而是一个有界双工 logical stream。音频继续分块发送，以便未来长录音不会被 RPC 体积限制绑死。

### 4.1 帧

每个应用帧使用 8 字节头：

```text
version:u8 = 2
kind:u8
flags:u16be = 0
payload_length:u32be
payload
```

单个 Speech 应用帧上限为 256 KiB；底层 data-plane 仍按自己的 16 KiB 帧切块承载，不要求一次网络写入容纳完整结果。daemon 在发送 `Completed` 前按真实 UTF-8 JSON 大小再次门禁，超限返回明确的 `protocolMismatch`，不会让客户端只看到流突然断开。

客户端到 daemon：

| kind | 内容 |
| --- | --- |
| `Start` | request/workspace/session、PCM 格式、语言提示、context snapshot |
| `Audio` | 连续 index、captureStartMs、durationMs、PCM bytes |
| `ContextUpdate` | 单调 revision 与新的完整 context snapshot |
| `Finish` | 停止录音并请求离线解码 |
| `Cancel` | 用户、页面隐藏、目标变化或背压取消 |

daemon 到客户端：

| kind | 内容 |
| --- | --- |
| `Ready` | 本次已探测 runtime/model 与接受的 context revision |
| `ContextApplied` | runtime 已接收的 context revision |
| `Partial` | 单调 revision 的完整 Best-1 replacement；只有双方协商后才允许 |
| `Completed` | 最终默认文本、整句/分段 N-best、低置信片段、时间范围、分数类型和 context snapshot |
| `Failed` | 稳定错误码、可操作说明、是否可重试 |

runtime 声明 `partialResults` 且客户端在 Start 中接受后，可以发送完整 Best-1 replacement；客户端用 revision 丢弃倒退结果。词级时间戳和候选审核仍是 final-only，`Completed.segments` 是停止后的最终分段，避免 UI 被中间假设反复抖动。

### 4.2 N-best

`SpeechCompleted` 必须包含：

```text
requestId
text
durationMs
contextSnapshotId
candidates[]
defaultCandidateId
scoreKind
scoresCalibrated
segments[]
```

每个候选包含：

```text
candidateId
rank
text
score
matchedTerms[]
```

约束：

- 1–5 个候选；ID、rank、规范化文本都必须唯一；
- 默认候选必须存在，且文本与顶层 `text` 一致；
- `scoreKind=mockRelative` 只用于内置 Stub；
- 社区 Qwen3 beam adapter 应返回 `lengthNormalizedLogProbability`；
- 首版统一声明 `scoresCalibrated=false`；
- 随机采样多次不能冒充 N-best。

### 4.3 分段与低置信片段

整句 N-best 保留用于兼容、整体比较和离线指标；日常审核使用 `segments[]`，避免为了一个专业词替换整段录音。每个 segment 包含：

```text
segmentId
startMs / endMs
textStartChar / textEndChar
text
candidates[] / defaultCandidateId
uncertainSpans[]
boundary { kind, confidence }
```

分段由社区 runtime 根据解码器 endpoint 与 VAD 共同决定；连续语音没有可靠停顿时必须用最大段时长兜底。`boundary.kind` 明确记录 `voiceActivity`、`decoderEndpoint`、`maxDuration` 或最终 `final`，只有最后一段可以是 `final`。Stub 为了确定性按录音时长一分为二，不声称模拟真实 VAD。

所有文本 offset 都是 Unicode scalar-value offset，不是 UTF-8 byte 或 JavaScript UTF-16 code unit。segments 必须按音频时间单调、按文本范围无缝覆盖顶层默认文本；segment ID、segment candidate ID 和 span ID 在一次结果内稳定且唯一。首版上限为 32 段、每段 12 个低置信片段、每个 candidate set 1–5 个候选，所有分段候选文本合计不超过 16,000 字符；逐段各取最长候选组成的最坏组合也不能超过 4,000 字，因此任意人工组合仍满足转写和反馈上限。

一个 uncertain span 只负责解释“这一段哪里不确定”，其 alternative 引用所在段的完整 candidate。用户点击局部词组时，UI 采用对应的完整段假设，因此同段内的标点和语言模型一致性仍由解码结果保证；其他 segment 完全不变。若一段有多个相互关联的模糊处，UI 会同步显示当前完整段 candidate 对应的选择，完整候选始终可以在折叠区审核。

`SpeechSegmentationCapabilities` 显式声明：

```text
maxSegments = 32
partialResults = false
localNBest = true
uncertainSpans = true
```

以后增加实时字幕时应新增 capability/帧语义，而不是把当前最终 segment 偷换成会撤回的 partial。

## 5. Qwen3 项目上下文

Qwen3-ASR 使用一个自由文本 prompt。GeneHub 不再维护云热词与对话事件两套映射，而是在 daemon 上生成一个可预览、可哈希、可复现的 `SpeechContextPack`：

```text
snapshotId
prompt
terms[]
languageHints[]
compilerVersion
omitted
```

### 5.1 显式项目文件

项目可以维护：

```text
.genethub/
└── speech/
    ├── context.md          # 最多取 2,000 字项目背景
    ├── terms.txt           # 团队维护的术语，每行一个
    ├── learned-terms.txt   # 人工候选纠正自动学习的术语
    └── preferences.jsonl   # 明确选择产生的偏好样本
```

`terms.txt` 支持空行和 `#` 注释。显式文件必须是普通 UTF-8 文件；符号链接和异常类型不读取。

### 5.2 自动来源与预算

按优先级合并并去重：

1. 设置中固定术语；
2. `learned-terms.txt`；
3. `terms.txt`；
4. 工作区和文件夹名称；
5. 最多 2,000 个安全路径中的文件/目录名；
6. 最近 8 条用户/Agent 消息；
7. 当前 Composer 草稿。

普通项目文件正文不会被批量读取。需要长背景时，由项目明确维护 `context.md`。prompt 最多 4,000 字，完整 context pack 最多 16 KiB；超限时先丢弃低分自动术语，再截断背景，并在 `omitted` 中如实报告。

项目名称索引会剪枝 `.genethub`、版本库元数据和疑似密钥目录，避免把 `preferences`、`private_key` 等维护文件名误当成专业术语。UTF-8 文件即使恰好在多字节字符中间达到读取上限，也只采用最后一个完整字符边界。

## 6. 纠正与训练数据

纠正收集默认关闭，并按 workspace 单独授权；切换项目不会沿用上一项目的授权。开启后，只有用户主动点击某个候选才写记录；默认插入、录音或手工打字本身不会静默落库。GeneHub 在 `.genethub/speech/.gitignore` 中默认忽略自动生成的 preference/learned-term 文件，并在 Unix 上以 owner-only 模式创建新的数据文件。关闭收集不会删除已有数据，用户仍可直接检查、导出或删除这些普通文本文件。

`preferences.jsonl` 每行使用 v3。正负样本是用户刚采用的 candidate 与被它替换的 candidate，不再隐式假设负样本永远是 rank 1：

```json
{
  "schema": "genethub-speech-preference.v3",
  "feedbackId": "spf_...",
  "recordedAt": "2026-08-11T00:00:00Z",
  "workspaceId": "local-workspace-id",
  "requestId": "request-id",
  "runtime": {
    "id": "community-qwen3-asr",
    "model": "Qwen/Qwen3-ASR-1.7B-hf",
    "label": "Qwen3-ASR 1.7B",
    "implementation": "community-adapter/1.0.0"
  },
  "contextSnapshotId": "sc_...",
  "scoreKind": "lengthNormalizedLogProbability",
  "scoresCalibrated": false,
  "candidates": [],
  "selectedCandidateId": "segment-candidate-2",
  "rejectedCandidateId": "segment-candidate-1",
  "chosen": {},
  "rejected": {},
  "scope": {
    "level": "span",
    "utteranceText": "采用该段之后的完整一句话",
    "segmentId": "segment-1",
    "segmentStartMs": 0,
    "segmentEndMs": 840,
    "precedingText": "",
    "followingText": "下一段文本",
    "uncertainSpanId": "span-model-name",
    "spanStartChar": 8,
    "spanEndChar": 18
  },
  "audioRef": null
}
```

scope 分为 `utterance`、`segment` 和 `span`。segment/span 样本必须同时保留整句文本、时间范围、前后段文本；这样后续既能训练局部候选 reranker/DPO，也不会丢失专业概念所依赖的长上下文。候选、分数、runtime 身份和上下文文本都从 daemon 最近 30 分钟内缓存的已验证 Completed 结果重建，缓存按 workspace/request 绑定且最多 64 条；RPC 中兼容旧客户端的候选/文本字段不会成为训练数据来源。非 rejected 候选中新出现、且确实出现在 chosen 文本中的 `matchedTerms` 会去重追加到 `learned-terms.txt`，下一次 context compile 自动生效。

当前已选的段候选再次点击不会重复写样本；daemon 还会根据 workspace、request、context snapshot、chosen/rejected 和 scope 生成稳定 `feedbackId`，使网络重试或多个客户端重复提交也保持幂等。daemon 串行化偏好写入，并在已有文件缺少末尾换行时先补齐行边界，保证并发纠正和人工维护不会破坏 JSONL/术语文件。

只有真实 runtime 的人工候选选择可用于候选 reranker/文本偏好流程。Stub 没有真实声学结果，其固定候选不会写入 `preferences.jsonl`；真实社区 runtime 接入后，应在用户单独同意音频保留的前提下增加内容寻址音频引用，现有候选偏好 schema 无需改变。

## 7. 社区 PC runtime 接入契约

GeneHub daemon 通过一个经过探测的社区 runtime session 工作；模型进程可以常驻，登记的可执行文件只需作为有界客户端：

```text
--genehub-probe -> genehub.speech-runtime.capabilities.v1 JSON
--genehub-stdio -> speech-v2 framed duplex stdio

session commands:
  Audio(bytes)
  Context(revision, SpeechContextPack)
  Finish
  Cancel

session events:
  ContextApplied(revision)
  Partial(revision, completeBest1, audioEndMs, stablePrefixChars)
  Completed(candidates, segments, scoreKind, calibrated)
  Failed(error)
```

登记只接受本机绝对可执行文件，不经过 shell 或 PATH；候选配置必须先在 10 秒内探测成功才持久化。社区实现自行决定使用 Transformers、vLLM、MLX、独立进程或预热服务。它必须：

- 只声明自己真实实现的能力；
- 将 `SpeechContextPack.prompt` 传给 Qwen3-ASR，而不是丢弃项目背景；
- 对实际提供的 beam 候选去重并保留真实分数；如果后端只有生成文本，则声明 `maxCandidates=1`、`scoreKind=unavailable`；
- 只有确实形成稳定 segments 并输出真实段级 beam N-best 时才声明 `localNBest`/`uncertainSpans`；
- 不在 GeneHub 内下载模型或修改用户 Python/CUDA 环境；
- 不要求 Cloud/Relay 增加语音字段；
- 不把 runtime 自己的 socket/IPC 细节暴露给 Workbench；GeneHub 边界固定为 transport-neutral 业务帧和 daemon-to-adapter stdio。

Adapter 可按以下顺序增量落地，避免一开始承担完整 N-best 复杂度：

1. `--genehub-probe` 加 Ready/Audio/Finish/单个 Completed Best-1；通常只是数百行有界进程与 framing 代码，模型调用本身另计；
2. 增加完整替换式 Partial、取消和超时；
3. 只有后端能拿到真实 beam hypothesis 时再增加整句 N-best；
4. 最后增加 VAD/decoder endpoint、段级 N-best、Unicode span 和不确定片段。

先在设置中打开 Stub，验证麦克风、上下文、Partial、分段候选和波浪线交互；再关闭 Stub、登记真实 Adapter，并以相同用户路径对照。内置 Stub 覆盖 Web 到 daemon 的正式通路，但不替代外部 `--genehub-stdio` 子进程探测，因此真实 Adapter 仍必须通过登记、probe、取消/超时和真音频 smoke。

## 8. 安全与隐私

- 麦克风只在用户点击后打开；页面隐藏、目标切换、Escape 和背压都会取消。
- 单次录音最长 5 分钟，只接受 mono 16 kHz PCM s16le。
- 每个音频块必须连续，大小与声明时长严格一致。
- Speech 应用帧最大 256 KiB，最终候选在序列化后执行精确字节门禁。
- context、候选、prompt 和反馈都有独立数量/字节/字符上限。
- `speech` capability 管录音、context preview 和反馈；修改设置需要 `settings`。
- 远端 workspace scope 同时约束转写、context preview 和 feedback RPC。
- `.genethub/speech` 只在当前 workspace 明确开启纠正且用户主动选择候选时写入；自动生成数据默认不进入 Git。
- 升级后首次读取旧配置会重写并清除已经废弃的云 ASR 地域、Workspace 与密钥字段。
- Stub PCM 经 E2EE 正式链路到目标 daemon、仅在内存中消费且不保存；Cloud/Relay 不解析或存储语音业务内容。
- daemon 结构化日志使用 request/correlation ID 串联请求、首个 partial、完成、取消、失败和 runtime 退出，只记录阶段、耗时、块/字节数、候选数量、退出码、stderr 类别与短指纹，不记录音频、prompt、术语、转写、候选或原始 stderr。
- Cloud 的显式问题反馈只接收白名单化语音生命周期元数据；默认隐藏输入值以及点击过的转写/候选标签。只有用户在反馈框中另行勾选时才附带这些可见文本。

## 9. 首版验收

- [x] 产品代码、设置和文档不包含第三方云 ASR 凭证、地域或专用事件映射。
- [x] 推荐 Qwen3-ASR，不提供多模型/多 Provider 选择器；同类模型只通过能力契约接入。
- [x] 用户可在设置中显式启用协议 Stub；无 GPU、模型网络或密钥也可用真实麦克风验证正式分块音频、Partial 与候选 UI，默认关闭。
- [x] Stub Best-1 以单调 revision 的完整 replacement 写入 Composer，并持续标注未运行模型。
- [x] Stub 或真实声明相应能力的 runtime 在停止后保留唯一整句/分段候选、时间范围、原始分数和低置信片段；Best-1-only runtime 不伪造这些数据。
- [x] 默认候选进入 Composer 但不自动发送；UI 不铺开候选面板，只在波浪线局部点击后显示候选并替换该段。
- [x] 活动 workspace ID 自动携带，不要求用户填写。
- [x] `.genethub/speech/context.md`、`terms.txt` 和学习词进入可预览 prompt。
- [x] 用户开启收集并主动选择候选后写 chosen/rejected + segment/span scope JSONL；关闭时明确返回未存储。
- [x] Stub 固定候选在 Web 与 daemon 两侧都被排除，不能污染偏好或训练数据。
- [x] 纠正授权按 workspace 隔离，样本从 daemon 权威完成结果重建，并记录真实 runtime/model/score 元数据。
- [x] 语音错误编号贯穿 Web、daemon 与 adapter 生命周期日志；反馈包默认不包含语音内容。
- [x] framing 在 Rust/TypeScript 间有同一 golden vector。
- [x] 社区 adapter 使用绝对路径 argv 登记、能力探测和有界 stdio；不引入模型专用 WebSocket。
- [x] 内置 Agent Skill 根据硬件推荐 Qwen3 1.7B/0.6B 或同类模型，并在任何安装变更前要求用户确认。
- [x] 新 RPC 与 logical stream 都进入权限和 workspace scope 穷举门禁。

## 10. 真实模型到位后的验证

社区 runtime 就绪后，不先改 UI，只替换 adapter 并跑同一验收：

1. 8GB 与 16GB GPU 分别记录峰值显存、RTF 和停止到最终候选延迟；
2. 中文、中英混说、文件名/符号、方言和噪声各有独立样本；
3. 同一音频做无 prompt / 有 prompt A/B；
4. 所有 runtime 统计 CER、Term Recall@1 和错误术语注入率；只有真实 N-best runtime 才统计 Term Recall@5、Oracle CER@5 和候选重复率；
5. runtime 声明 N-best/分段时，验证整句与分段 beam 候选不是随机采样或事后改写，并测 segment boundary F1；
6. 分别统计整句纠正率、分段纠正率、span 点击率，以及“改一段误伤另一段”的零容忍回归；
7. 将 runtime/model/quantization/decoder/VAD/context compiler 版本写入后续训练 manifest。

Qwen3-ASR 官方模型与社区运行方式见 [Qwen3-ASR repository](https://github.com/QwenLM/Qwen3-ASR) 与 [Qwen3-ASR-1.7B-hf model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf)。
