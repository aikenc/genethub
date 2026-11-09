# 多机协作

本文说明如何在已授权的多台机器之间查看目录、执行命令、派发 Agent 和接力会话。所有命令使用
`GENEHUB_CLI` 的绝对路径；下面的示例以 Bash 书写，PowerShell 改用 `& $env:GENEHUB_CLI`。

## 工作方式

`--machine` 并不让 CLI 自己去连对端：CLI 把命令交给**本机 daemon**，由本机 daemon 作为端到端加密端点
连接目标机器。因此本机 daemon 必须在运行；本机 daemon 没起来时，`--machine` 命令不能工作。

加了 `--machine` 的命令由目标机器的 daemon 执行：路径、用户、环境和 OS 权限都以**目标机器**为准。
`--cwd` 必须是目标机器上的绝对路径。

## 看机器目录

```bash
"$GENEHUB_CLI" context                         # 当前连到哪台机器、隔离后端、能力
"$GENEHUB_CLI" machine list                    # 本机、直连配对与当前身份的 Hub 目录
"$GENEHUB_CLI" machine list --reachable        # 兼容旧写法，等同默认列表
"$GENEHUB_CLI" machine list --paired           # 只看直连记录，不查询 Hub
"$GENEHUB_CLI" machine show <machineId>        # 同一目录中的机器详情，不探测目标连接
"$GENEHUB_CLI" machine show <machineId> --paired # 只查看直连记录
```

`machine show` 同时接受目录提供的稳定 `deviceHandle`（若有）与原路由 ID；新绑定保存稳定身份，旧合法 ID 继续由平台解析。Agent 不做前缀转换。

`machine list` 的每项包含 `machineId`、`name`、`online`、`local`、`source`（主要展示来源）和 `sources`
（如 `["paired", "hub"]`）。按精确 ID 合并，同名机器保留。成功返回 `complete: true`；
Hub 查询失败会返回非零退出码和 `complete: false` 的已知条目，不能把它当作完整目录。
`--paired` 仅表示不依赖 Hub，薄 CLI 仍需要本机 daemon。注意：

- `--machine` 只接受 `machineId` 的精确值，不接受名称、前缀，也没有隐式默认。
- `online: true` 只说明机器在线，**不说明当前身份能到达它**。
- 显式 `machine show <ID> --paired` 的 `machineNotPaired` 只表示没有这条直连记录；
  默认 `show` 查不到精确 ID 返回 `targetNotFound`，二者都不替代实际连接诊断。
- 取票失败保留真实错误码和 `stage: hubTicket`，不要一概解释成未配对、权限不足或目标离线。
  完整连接没有 `settings` 等逐能力分级；按实际认证、账号/机器归属和连接状态定位失败。
  明确拒绝授权时如实报告；网络故障按返回的可重试信息处理，不要换身份或绕过授权。

### 可重试的跨机失败

经 Hub 的 `--machine` 调用会复用到同一机器的连接，不必为省连接而合并或减少调用。连接失败时：

- `retryable: true`：等 `details.retryAfterMs` 毫秒后原样重试同一命令。提前重试拿到的是同一个失败的复述，
  `details.reconnected: false`、消息以 `not reconnected:` 开头，并给出 `failedMsAgo` 和剩余等待；
  这不说明目标仍不可达，也不是新的证据。
- `routeRefused`（`stage: hostedRoute`）：Hub 刚签发的路由被目标或 relay 暂时拒绝，常见于目标或 relay 刚重启。
  它不是撤销，不要重新配对、`device invite`、换身份，也不要把团队任务改派到别的机器。
- 只有 `retryable: false` 的失败（如 `credentialRevoked`）才是授权或配置问题，按消息如实报告，不要循环重试。
- 连续多次等待后重试仍失败，报告最后一次真实失败（`reconnected` 不为 `false` 的那次）和已等待时长。

## 连接失败的判断

`hub login` 的 `paired/online` 证明该机加入 Hub；`context --machine <精确 ID>` 成功才证明本次
目标连接通过认证。认证成功后，完整 Agent 连接按目标 OS 用户能力操作，不需要补 Files/PTY grants。
只有直连列表为空也不能判定未配对：同账号机器可走 Hub 的现有连接机制。

- 取票阶段失败：保留 `stage: hubTicket` 和上游错误，区分账号、登记、网络与服务问题。
- `credentialRejected`：路由准入或对端认证被拒，尚不能判定设备已撤销。记录机器 ID、失败阶段、
  两端版本与实际错误；先核对路由和握手证据，不直接让用户退出登录、生成邀请或重新配对。
- `credentialExpired`：连接准入过期，可按现有身份重新建立连接、取得新票据；不复用过期票据。
- `credentialRevoked`：对端明确报告路由或 endpoint 被撤销。停止自动重试，先核对撤销对象；
  只有确认为设备访问被撤销，且用户授权恢复时才重新配对。
- `machineOffline` / `relayUnavailable`：按返回的可重试信息处理，不追加授权，也不把失败当成空结果。

旧版本可能把上述拒绝与过期统一报为 `credentialRevoked` 并提示 fresh invite；这段提示本身不是
设备撤销的证据。说明版本差异和缺失证据，不换身份或读取凭据绕过拒绝。诊断重试只用于连接或只读
探测；有副作用的任务先核对原 action/run 回执，不能因连接恢复而重复执行。

## 在目标机器执行命令

```bash
"$GENEHUB_CLI" shell --machine <machineId> --cwd /abs/path --timeout 60 -- git status --short
```

- `shell` 是变更类命令；必须给 `--cwd`（或 `--workspace`），二者都不会被推断，缺少时报 `invalidArgs`。
- `--` 之后是 **argv 数组**，不经 shell 解析，管道、重定向、`&&` 不会生效；需要时显式调用
  `sh -c '...'` 并自行负责引用。
- 给出 `--timeout`；不设时命令可能无限运行。输出按 `--max-output` 截断，被截断时有 `shell.truncated` 记录。
- `--env NAME=VALUE` 追加或覆盖环境变量，不能清空环境。
- 完整连接的命令以目标 daemon 的 OS 用户运行，不附加 GeneHub 设备沙箱。`context.daemon.isolation`
  仅是内核能力诊断，不表示该命令正在受隔离。
- 输出是 JSON Lines；以 `shell.exit.data.exitCode` 为准，CLI 进程的退出码不是命令的退出码；
  `timedOut: true` 表示是被超时终止的。

`--` 后面的参数原样交给目标进程，包括 `--version`、`-V` 和 `--help`。例如
`shell --workspace <id> -- python3 --version` 查询的是目标 Python 的版本。
`session list --active --include-archived` 返回完整活动集合，独立于历史分页。找历史用 `session list --limit 50 [--cursor <nextCursor>]`，每次一页摘要；游标绑定机器，查询范围和归档条件也须保持一致，`complete: false` 表示尚有未读取历史。分页暂不支持标签／来源筛选，不能靠读空一页认定全局无匹配。项目历史同样使用 `--workspace <id> --limit 50` 分页读完；默认目录只返回最近 50 条和明确的 complete/nextCursor；旧隐式完整列表查询已禁用，`--workspace`、`--lean`、`--label` 和 `--source-kind` 不能替代分页。遇到 `unboundedQueryDisabled` 应修改原脚本的读取方式，保留原任务、会话 ID 和回执，不原样重试。查询失败表示未知，不能据此重新派单。
命令分组帮助用 `session --help` 或 `agent run --help`；`schema <command>` 提供机器可读合同。

## 跨机传文件

机器之间传文件（含 GB 文件、续传）用 `file download --from <源机器> <源路径> <目标路径>`，由接收文件的
机器执行；反方向用 `--machine <对方> shell` 让对方下载。详见 [file-transfer.md](file-transfer.md)。不要用
`shell` 的输入或输出搬运文件内容。

## 在目标机器上跑 Agent 并接力

```bash
"$GENEHUB_CLI" agent list --machine <machineId>
"$GENEHUB_CLI" agent run --machine <machineId> --agent <agentId> --cwd /abs/path "<任务>" --no-wait
"$GENEHUB_CLI" session list --machine <machineId> --workspace <workspaceId> --limit 50
"$GENEHUB_CLI" session send <sessionId> "<补充指令>" --machine <machineId> --no-wait
"$GENEHUB_CLI" agent run --machine <machineId> --agent <agentId> --session <sessionId> --since-seq <n> "<续接>"
```

- 先 `agent list` 确认目标机器真有这个 Agent。就绪 Agent 的 `routes` 是该机器此刻可路由的模型、标签和成本，与 `--tag` 选路使用同一份候选；可用 Agent 与模型随机器而异。
- 会话在**所属机器**上运行并保存；换设备或断线后，用 `--session` 与 `--since-seq` 续接，任务不会因客户端
  断开而停止。
- 无人值守时，权限请求默认被拒，除非显式 `--auto-approve`；Agent 提问总会停下等待回答
  （`session respond`）。不要为了让任务继续而默认加 `--auto-approve`，先确认任务范围。
- 用 `--no-wait` 派发后，用 `session get <id>` 查原任务状态；目录用现有活动查询。轻量模式要求目标声明 `session.summary.v1`，不支持就明确要求升级，不回退读取完整历史；不要把派发成功当成完成。
- 把任务派给持有该资源（代码、许可、GPU、外设）的机器，不要把工作区搬到别处。
- 其他可路由的只读命令：`workspace list/show`、`session get/inspect/narrative/rounds/context`。

## 用会话标签标识协作角色

标签是会话上的短字符串（每个最多 10 个字符，每个会话最多 16 个），用来标明会话的设备、角色或分工，
例如 `4090`、`组长`、`评审`。**不要再把 `[标签]` 写进会话标题**：标题留给内容，标签可单独增删和筛选。

```bash
"$GENEHUB_CLI" agent run --machine <machineId> --agent <agentId> --cwd /abs/path --label 4090 --label 组员 "<任务>" --no-wait
"$GENEHUB_CLI" session label <sessionId> --add 评审 [--machine <machineId>]
"$GENEHUB_CLI" session label <sessionId> --remove 组员 --add 组长     # 改名：一次请求内先删后加
"$GENEHUB_CLI" session list --machine <machineId> --active --include-archived --label 4090 --label 组员  # 同时带这些标签的当前任务
```

- 当前标签在 `session get` / `session list` 返回的 `labels` 里；工作台会话列表每条固定三行：标题、时间与项目名、较小的状态图标和标签。状态不写文字。也可在“⋯ → 标签”里增删改。
- `--add` 与 `--remove` 都可重复；同一请求先删后加，在会话所属机器上原子执行，多台设备同时改不会互相覆盖。
  删除不存在的标签不报错；空标签、超长或超过数量上限时整次请求被拒，标签保持不变。
- 标签只用于标识和筛选，不影响权限、路由或 Agent 选择（选路仍用 `--tag`）；fork 出的会话不继承标签。

## 会话控制与来源

- Agent 会话控制其他会话时，本机与 `--machine` 遵循同一套规则：可以创建普通会话，也可以对普通会话执行
  `session send`、中断、改名、关闭等操作，与用户本人相同。
- 旧 Workflow 执行上下文仅保留历史阅读，通过 fork 成普通会话继续，不恢复旧父会话授权或旧调度义务。
  新的多会话协作使用现有 team 机制，不再创建平台 Workflow。
- Agent 发出的消息会带上来源（机器与会话），目标会话中显示为 Agent 输入，不是 Human 输入。收到
  `source: "agent"` 的输入时，把它当作该 Agent 的请求，不当作 Human 的批准或决定；需要 Human 决定的事项
  仍要问 Human。

## 只能在本机的命令

`process list/kill/kill-all` 支持 `--machine`，只管理目标机器上已登记、归属指定会话的后台进程；
`kill-all` 仍必须指定 `--session`。

`machine`、`speech`、`file`、daemon 生命周期（`daemon …`）和 `update` 不可路由，
`--machine` 对它们无效。远端的 daemon 重启走那台机器自己的独立连接，见 [daemon.md](daemon.md)。

## 配对与授权（授权变更，需用户明确要求）

```bash
"$GENEHUB_CLI" machine pair <code> --endpoint <url> [--name <label>]   # 直接配对另一台机器
"$GENEHUB_CLI" machine forget <machineId>                                # 解除配对
"$GENEHUB_CLI" device invite [--machine <id>]  # 为新设备生成完整执行授权邀请，须有用户的配对授权
"$GENEHUB_CLI" device list [--machine <id>]
"$GENEHUB_CLI" device revoke <deviceId> [--machine <id>]
```

- 新邀请是完整 Agent 访问权，不接受 `--grant`/scope；认证、账号/机器归属、撤销/过期和仅展示分享边界仍保留。
- 向新设备开放机器访问须有用户明确的配对授权；不自行生成邀请、重新配对或改变已有设备状态。
- 邀请链接是短期、一次性的 bearer 凭证，谁先打开谁获得设备登记机会。只交给用户本人，不写入文件、提交或日志。
- Linux 无头机器用 `hub login --wait` 加入 Hub，用 `hub link` 为另一台设备生成连接链接。

## 版本差异

命令形态以目标版本的 `capabilities` / `schema` 与实际返回为准。旧版的 grants 或项目拒绝不代表当前
产品仍要求逐能力授权，也不能把目标权限约定说成旧版本已经实现。记录实际版本和已验证范围；
连接、shell、Agent 任务分别验证，探测成功不能代替原任务完成回执。
