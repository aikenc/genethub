---
name: genehub-daemon-management
description: Explain or operate GeneHub daemon startup, shutdown, restart, configuration activation and recovery on local or remote machines. Use for questions such as how to restart daemon, daemon offline after restart, or applying daemon environment changes. Preserve the existing desktop/service/manual lifecycle owner; not a Beta release workflow.
---

# GeneHub daemon 管理

询问“如何启动/停止/重启 daemon”、配置是否生效、重启后离线时使用本 Skill。
解释用法不授权执行重启。先读 [标准重启与恢复 SOP](references/restart.md)，再提出或执行中断连接的操作。

## 定位与命令

使用当前渠道 GENEHUB_CLI 绑定的绝对路径；缺失则停止说明，不猜 genet/genet-beta 或切换渠道。
下列 Bash 命令使用绑定；PowerShell 用 & $env:GENEHUB_CLI。先只读确认状态、运行用户、数据目录，
以及当前 PID 的管理者：桌面端、现有服务管理器，或手动启动。不能仅凭“正在运行”判定可直接重启。

```bash
"$GENEHUB_CLI" daemon status
"$GENEHUB_CLI" --help
```

这些生命周期命令作用于执行 CLI 的本机，不把 --machine 当成远程进程管理入口。
远端重启在独立 SSH/控制台中使用目标机器自己的绑定。

- 手动启动且恢复条件满足：使用绑定 CLI 的 daemon restart，再检查 daemon status。
  CLI 会验证旧实例身份；不能简化为只信任 lock 文件 PID，不用 kill/pkill 代替标准入口。
- 桌面/服务托管：通过实际管理者重启，不另起 CLI start/restart 或擅自新建服务。
- 首次手动运行可使用 daemon run（前台）或 daemon start（后台），以实际帮助为准；
  后台启动不等于持久托管，不保证脱离调用者的服务控制组。
- 停止也需遵循管理者，否则自动恢复策略可能把进程重新拉起。

若当前 GeneHub 会话依赖目标 daemon，先验证独立恢复连接；没有就停止重启动作。
不把 nohup/setsid/systemd-run 包装当可靠重启方案。Linux 不必安装 systemd。
配置仅写入未验证时标记“待生效”；已有操作授权不替代恢复条件，不反复索取已给授权。

## 范围

本 Skill 管理 daemon 生命周期，不发布产品版本、不改配对关系。Beta 诊断、候选交接和发布
遵循用户所在 Space 的专用 Skill。业务发布任务持久执行与 daemon 存活是两件事。
