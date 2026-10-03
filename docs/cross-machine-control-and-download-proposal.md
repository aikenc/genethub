# 跨机会话控制一致化与跨机下载：下一步提案

状态：已确认，实施中（2026-10-03）
来源：Beta 反馈 `fb_50uwTJye0wFN`（同一 Agent 发给本机会话被拒、发给远程会话成功）；多 GB 跨机传输需求
基线：Beta build `4b9108fa`，与当前 `origin/main` 在相关逻辑上一致

## 1. 现状事实

### 1.1 会话控制：本机与远程两套规则

| 路径 | 调用方身份 | 对普通会话的 send/interrupt/rename 等 | 依据 |
|---|---|---|---|
| 本机 CLI（Agent 会话内） | `SessionController`，CLI 自动附带 `GENEHUB_SESSION_ID` + controller token | 拒绝：“只能控制由自己委托的受管子会话” | `apps/cli/src/invoke.rs` `add_session_controller_identity`；`apps/daemon/src/router.rs` `authorize_session_request` |
| `--machine` 远程 | 目标机看到的是配对设备 / Hub 通道（即账户本人），会话身份不随行 | 放行 | `apps/daemon/src/cli_front/query.rs` `hosted`；`router.rs` 中 `(None, _) => Ok(())` |

补充事实：

- 本机限制**不是安全边界**。Agent 与 daemon 同属一个 OS 账户，`unset GENEHUB_SESSION_ID` 后再调 CLI
  就是 `LocalUser`；`authz.rs` 对 `LocalUser` 的注释本身也写明“已能以该账户读文件、起进程，扣住能力保护不了什么”。
  它实际起的是**防误操作护栏 + Workflow 语义约束**作用。
- `SessionSend` 写入目标会话时来源**固定标记为 `"user"`**（`router.rs` `accept_input(..., "user")`）。
  所以远程 Agent 发来的消息，在目标会话里被当成 Human 输入（目标 Agent 看到的是 “This turn carries Human input only”）。
- 远程路径下，Agent 也能以“本人”身份回答目标会话的权限请求（`SessionRespondPermission`）；本机路径只允许对自己的受管子会话应答。

### 1.2 跨机文件传输：只有 Skill 文档，没有能力

- 已有提交 `bb1b599a`、`2bc4f023`（仅 `builtin-skills/genehub` 文档，未推送、未合入 main），描述的是
  “源机器发送（push）”模型，CLI 中**没有**任何传输命令。
- 现有可复用的底座：数据面 `asset.preview` 流（`Capability::Files`）已能流式读取工作区文件字节，
  但带 64 MiB 预览上限，不支持偏移续读。
- `shell` 输入上限 1 MiB、输出按文本处理，不能承载二进制或 GB 级内容。
- 已跑的网络评估（run `261002-1158-multigb-network-assessment`，6/6 通过）范围明确不含多 GB 文件验收、不含 Beta。
- 反馈机日志线索（假设，待核实）：fabric 上 `rtc.negotiate` 198 次中位 5.3 s，`rtc.config` 多次恰好 5 s 失败，
  `workspace.list`/`session.list` 有 60 s 超时；中转链路的长时间大流量表现未验证。

## 2. 问题澄清

### Q1 只做下载是否更简单？配合 remote shell 能否满足双向？

**是，下载（接收方发起的 pull）比发送更简单，且配合 remote shell 可覆盖双向。** 此前 Skill 写的 push 模型应改为下载模型。

| 维度 | 下载（pull） | 发送（push） |
|---|---|---|
| 远端需要的能力 | 只读，复用现有 `Files` 能力与 `asset.preview` 流 | 需要新增“远端写入”能力与落盘协议 |
| 断点续传 | 接收方知道已落盘偏移，按偏移续读即可 | 发送方需向远端查询已确认偏移 |
| 完成判据 | 落盘、长度与 SHA-256 校验都在发起方本机完成 | 需远端回传落盘回执 |
| 临时文件、冲突、磁盘满 | 都在本机处理 | 都在远端处理，错误需回传 |

双向：

- B → A：在 A 执行 `download --machine B <源路径> <本机目标>`。
- A → B：通过 remote shell 在 B 执行 `download --machine A ...`。前提是 B 能到达 A（B 的 `machine list --reachable` 含 A）。

由此带来的两条硬要求：

1. 下载必须是**由 daemon 托管的任务**（有任务 ID，可查询、取消、续传），不能依附于一次 shell 进程，
   否则 remote shell 的超时或断线会杀掉传输。
2. remote shell 只负责启动和查询任务，文件内容走数据面的二进制流，不经过 shell 输出。

### Q2 跨机调用不带发起会话身份有什么问题？能连接不就是有权限？

**对“能不能做”而言，能连接就是有权限，这一点成立**：通道代表账户本人，Agent 本就运行在该账户下，
携带会话身份不应该收窄任何权限。

不带身份的真实问题在**归属**，而不在访问：

1. **冒充 Human 输入**：远程 Agent 发出的消息在目标会话中被记为 `user`，目标 Agent 会按 Human 指令对待，
   包括“确认”“批准”“可以发布”这类决策性输入。
2. **权限应答无法归属**：远程 Agent 代答的权限请求，记录上与本人操作无法区分。
3. **不可追溯**：事后无法区分哪些输入来自用户，哪些来自哪台机器的哪个 Agent 会话。

结论：**要带身份，但只作为来源归属**，不作为授权收窄。来源声明只会让目标端更保守（标为 Agent、拒绝代答 Human 决策），
伪造或缺失都不能多得权限，因此由发起端 daemon 在已认证通道内声明即可，无需新的签名或授权体系。

### Q3 新增显式授权关系是否符合简洁？能连接、能调 CLI，为什么要限制？

**不符合，撤回该方案。** 访问控制统一为“连接即权限”，不新增“谁可控制谁”的授权关系。

保留的只有一条与访问控制无关的**目标端数据不变量**，本机与远程同一套：

| 不变量 | 理由 | 判定依据 |
|---|---|---|
| Workflow 受管子会话只由其 Workflow 写入；其他人只读或 fork | 保证 Run 记录、完成合同与状态机一致；属于目标会话的属性，不属于调用方权限 | 目标会话的 `managed` 记录（现有） |

权限请求**不**列为 Human 专属：`agent run --auto-approve`（`cli_front/converse.rs`）本来就由 CLI 调用方代答权限，
远程派活依赖这一点。权限应答只做来源标注，不额外限制。Workflow 的 Human 请求本身只在本机处理，现有规则不变。

相应删除：会话绑定 Agent “只能控制自己委托的子会话”对**普通会话**的限制；与之同类的
“会话绑定 Agent 不能创建普通会话”一并删除（第 5 节决策 2）。

### Q4 测试门禁

`dev-feedback` 暂不处理。本提案的验收用 `change`（开发中）和完整 `dev`（交接前）；本次涉及授权、协议和传输载体，本来也应走完整门禁。

## 3. 方案

### 3.1 会话控制一致化（解决反馈，先做）

1. **来源归属**
   - 本机：`SessionController` 调用 `SessionSend` 时，来源记为 `agent`，附带 `{machineId, sessionId}`。
   - 远程：本机 `cli_front` 在 `--machine` 转发时附带同样的来源声明；目标端缺省按现状视为 `user`（兼容旧发起端）。
   - 展示：工作台与 Agent 输入包装都按来源显示（“来自 <机器>/<会话>”），不再统一称为 Human input。
2. **授权规则统一**：`authorize_session_request` 去掉对普通会话的调用方限制，只保留第 2 节的受管子会话不变量；
   本机与远程走同一判定函数。
3. **不新增**：设备授权、可控名单、配置项。

### 3.2 跨机下载（随后做）

1. **CLI**：`file download --machine <源> --workspace|--cwd ... <源路径> <本机目标>`，
   另有 `file transfer status|cancel <任务ID>`，均可配合 `--machine` 在远端查询。
2. **源端**：在 `Files` 能力下新增按 `offset/length` 读取的文件流，不设 64 MiB 预览上限，
   返回源文件身份（大小、mtime、内容摘要）。源路径允许源机器上的任意绝对路径（第 5 节决策 3）；配对设备的授权含义不变：工作区外路径需要 `pty:unconfined` 级别的能力，账户本人与 Hub 通道不受限。
3. **接收端（daemon 托管任务）**：先写临时文件 → 按偏移续传 → 校验长度与 SHA-256 → 原子改名为目标文件 → 写最终回执。
   源文件身份变化时拒绝续传；目标已存在时按用户指定的冲突策略处理，默认拒绝覆盖。
4. **范围**：单文件、单向、可续传；不做目录同步和并发多文件。
5. **Skill**：把 `bb1b599a`/`2bc4f023` 的 push 表述改为下载模型，与能力同批合入；不单独先合入旧表述。

## 4. 验收

| 项 | 方式 |
|---|---|
| 反馈回归 | 同一 Agent 对本机普通会话与远程普通会话的 send 都成功，且目标会话显示为 Agent 来源 |
| 不变量 | 本机与远程对他人受管子会话的写入都被拒绝；Agent 的权限应答在两条路径上都标注来源 |
| 兼容 | 旧发起端（不带来源声明）仍可用，按 `user` 记录 |
| 下载 | 小文件与多 GB 文件，分别走直连和中转；中途断网、kill daemon 后续传；源文件变化时拒绝续传；校验失败；磁盘满 |
| 门禁 | `change` → 完整 `dev`；多 GB 与中转在 Beta 环境实测后才算验收 |
| 发布 | 交接给 release-beta Space，dev 不发布 |

## 5. Human 决策（2026-10-03）

1. 接受“连接即权限 + 受管子会话不变量 + 来源归属”作为统一模型。
2. 放开会话绑定 Agent 创建普通会话。
3. 下载源路径允许任意绝对路径。
4. 同步修改相关内置 Skill。

实施中保留不变的边界：会话绑定 Agent 在本机的能力范围（`settings`/`devices` 等）不变，已有 specialty
`agent-hosted-machine-access` 明确防止“为修复而放宽所有 Agent 能力”；权限应答（`session respond`）暂不携带来源。

## 6. 代码量与影响面（估算）

### 6.1 会话控制一致化

| 改动 | 位置 | 估算 |
|---|---|---|
| 去掉会话绑定 Agent 对普通会话的限制，保留受管子会话规则 | `router.rs` `authorize_session_request` | 净减约 20 行 |
| 放开会话绑定 Agent 创建普通会话（决策 2） | 同上 | 减约 15 行 |
| `SessionSend` 增加可选 `origin {machineId, sessionId}` | `packages/proto/src/rpc.rs` | 约 10 行 |
| `UserMessage` 增加可选 `origin`（TS 类型自动导出） | `packages/proto/src/timeline.rs` | 约 5 行 |
| 本机按调用方填 origin；远程转发时由 `cli_front` 填 origin | `router.rs`、`cli_front/converse.rs` | 约 30 行 |
| inbox 记录 `agent` 来源，输入说明区分 Human 与 Agent | `session/inbox.rs` | 约 30 行 |
| 工作台按来源显示 | `packages/workbench/src/session/TimelineView.tsx` | 约 20 行 |
| 测试：router 单测 + 跨机 specialty（本机与远程一致、受管子会话仍被拒、旧发起端兼容） | 测试工程 | 约 150–200 行 |

合计约 300 行、约 10 个文件。影响面：

- **行为变化只有一处**：本机 Agent 现在可以 send/interrupt 普通会话，与远程一致。现有 specialty 只断言
  受管子会话的边界（如 `exception-authority`），未发现依赖“普通会话被拒”的用例。
- 协议只新增可选字段，RPC 未使用 `deny_unknown_fields`：旧 daemon 会忽略 origin，退化为现状（记为 user），
  不会出错。
- 不涉及数据迁移、设备授权与配对。

### 6.2 跨机下载

| 改动 | 估算 |
|---|---|
| 源端：新增按偏移读取的文件流（`Files` 能力，复用 `asset.preview` 的路径校验） | 约 200 行 |
| 接收端：daemon 托管的传输任务（持久化状态、临时文件、续传、校验、原子改名、取消） | 约 500 行 |
| CLI：`file download` 与 `file transfer status/cancel`，capabilities/schema | 约 300 行 |
| Skill 改写 | 约 60 行 |
| 测试：直连/中转、断线、daemon 重启续传、源文件变化、校验失败、磁盘满、与交互流量并存 | 约 400 行 |

合计约 1500 行，以新增为主。对现有路径的改动只是在 `StreamMethod` 中新增一项（该枚举要求逐项声明所需能力）。
主要风险不在代码量，而在中转链路的长时间大流量：带宽、成本、公平性，以及第 1.2 节提到的超时线索。

## 7. 顺序

1. 会话控制一致化（3.1）→ `change`/`dev` → 交接 release-beta。这一步解决反馈。
2. 跨机下载（3.2），连同改写后的 Skill → 先在 dev 跑多 GB 测试，再到 Beta 实测 → 交接 release-beta。
3. 并行：核实中转链路的 5 s / 60 s 超时线索。
