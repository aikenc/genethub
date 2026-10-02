# 多机协作

本文说明如何在已授权的多台机器之间查看目录、执行命令、派发 Agent 和接力会话。所有命令使用
`GENEHUB_CLI` 的绝对路径；下面的示例以 Bash 书写，PowerShell 改用 `& $env:GENEHUB_CLI`。

## 工作方式

`--machine` 并不让 CLI 自己去连对端：CLI 把命令交给**本机 daemon**，由本机 daemon 作为端到端加密端点
连接目标机器。因此本机 daemon 必须在运行；本机 daemon 没起来时，`--machine` 命令不能工作。

加了 `--machine` 的命令由目标机器的 daemon 执行：路径、用户、环境、权限、隔离都是**目标机器**的。
`--cwd` 必须是目标机器上的绝对路径。

## 看机器目录

```bash
"$GENEHUB_CLI" context                         # 当前连到哪台机器、隔离后端、能力
"$GENEHUB_CLI" machine list                    # 直接配对过的机器
"$GENEHUB_CLI" machine list --reachable        # 加上本机与当前身份的 Hub 目录
"$GENEHUB_CLI" machine show <machineId>        # 某台直接配对机器的详情
```

`machine list` 的每项包含 `machineId`、`name`、`online`、`local`、`source`（如 `hub`）。注意：

- `--machine` 只接受 `machineId` 的精确值，不接受名称、前缀，也没有隐式默认。
- `online: true` 只说明机器在线，**不说明当前身份能到达它**。
- 取不到到达凭证时返回 `machineNotPaired`，其中会说明原因（例如调用身份缺少 `settings` 能力，Hub
  没有为它签发连接票据）。这是权限边界，不是网络故障：如实报告，并请用户在可操作的设备上配对或授权。
  不要换身份、重试其他路径或绕过。

## 在目标机器执行命令

```bash
"$GENEHUB_CLI" shell --machine <machineId> --cwd /abs/path --timeout 60 -- git status --short
```

- `shell` 是变更类命令；必须给 `--cwd`（或 `--workspace`），二者都不会被推断，缺少时报 `invalidArgs`。
- `--` 之后是 **argv 数组**，不经 shell 解析，管道、重定向、`&&` 不会生效；需要时显式调用
  `sh -c '...'` 并自行负责引用。
- 给出 `--timeout`；不设时命令可能无限运行。输出按 `--max-output` 截断，被截断时有 `shell.truncated` 记录。
- `--env NAME=VALUE` 追加或覆盖环境变量，不能清空环境。
- 先读 `shell.started` 里的 `confinement`：它列出命令可达的根目录。**根目录之外的路径表现为“不存在”，
  不是“无权限”**。不要据此认定文件缺失。
- 输出是 JSON Lines；以 `shell.exit.data.exitCode` 为准，CLI 进程的退出码不是命令的退出码；
  `timedOut: true` 表示是被超时终止的。

## 跨机传文件

上传、下载和 GB 文件续传先读 [file-transfer.md](file-transfer.md)。`shell` 的输入与文本输出都有
独立限制；能远程执行命令不代表已有可靠的大文件传输能力。

## 在目标机器上跑 Agent 并接力

```bash
"$GENEHUB_CLI" agent list --machine <machineId>
"$GENEHUB_CLI" agent run --machine <machineId> --agent <agentId> --cwd /abs/path "<任务>" --no-wait
"$GENEHUB_CLI" session list --machine <machineId> --workspace <workspaceId>
"$GENEHUB_CLI" session send <sessionId> "<补充指令>" --machine <machineId> --no-wait
"$GENEHUB_CLI" agent run --machine <machineId> --agent <agentId> --session <sessionId> --since-seq <n> "<续接>"
```

- 先 `agent list` 确认目标机器真有这个 Agent。就绪 Agent 的 `routes` 是该机器此刻可路由的模型、标签和成本，与 `--tag` 选路使用同一份候选；可用 Agent 与模型随机器而异。
- 会话在**所属机器**上运行并保存；换设备或断线后，用 `--session` 与 `--since-seq` 续接，任务不会因客户端
  断开而停止。
- 无人值守时，权限请求默认被拒，除非显式 `--auto-approve`；Agent 提问总会停下等待回答
  （`session respond`）。不要为了让任务继续而默认加 `--auto-approve`，先确认任务范围。
- 用 `--no-wait` 派发后，用 `session get` / `session list` 轮询状态，不要把派发成功当成完成。
- 把任务派给持有该资源（代码、许可、GPU、外设）的机器，不要把工作区搬到别处。
- 其他可路由的只读命令：`workspace list/show`、`session get/inspect/narrative/rounds/context`。

## 只能在本机的命令

`workflow`、`process`、`machine`、`speech`、daemon 生命周期（`daemon …`）和 `update` 不可路由，
`--machine` 对它们无效。远端的 daemon 重启走那台机器自己的独立连接，见 [daemon.md](daemon.md)。

## 配对与授权（授权变更，需用户明确要求）

```bash
"$GENEHUB_CLI" machine pair <code> --endpoint <url> [--name <label>]   # 直接配对另一台机器
"$GENEHUB_CLI" machine forget <machineId>                                # 解除配对
"$GENEHUB_CLI" device invite --grant read --grant session [--machine <id>]  # 为新设备生成邀请
"$GENEHUB_CLI" device list [--machine <id>]
"$GENEHUB_CLI" device revoke <deviceId> [--machine <id>]
```

- 授权项：`handshake`、`read`、`session`、`files`、`git`、`pty`、`pty:unconfined`、`devices`、`settings`、
  `speech`、`services`、`update`。**不带 `--grant` 的邀请是不受限设备**。始终给最小范围；`pty:unconfined`、
  `devices`、`settings`、`update` 影响最大，需要用户逐项确认。
- 生成链接即批准：链接是短期、一次性的 bearer 凭证，谁先打开谁获得设备登记机会。只交给用户本人，
  不写入文件、提交或日志。
- 调用身份缺少相应能力时（例如 `device list` 报 `caller lacks the devices capability`），不要尝试提权，
  告诉用户需要在有该能力的设备上操作。
- Linux 无头机器用 `hub login --wait` 加入 Hub，用 `hub link` 为另一台设备生成连接链接。

## 状态与未验证项

以上命令形态来自 CLI 的 `capabilities` / `schema` 合同与实测的本机、错误路径输出。在 Agent 会话身份
（本机用户、无 `settings`/`devices` 能力）下，没有验证过跨机 `shell` 或 `agent run` 的成功路径；
遇到与本文不符的行为，以 `schema <命令>` 和命令返回为准，并如实报告差异。
