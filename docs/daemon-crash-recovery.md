# Linux 手动 daemon 的崩溃恢复

本轮目标是：原生 Host 被 SIGKILL（包括内核 OOM）终止后，清理旧执行进程，再使用同一渠道、身份和数据目录自动启动。已有记录保留，进行中的轮次可以中断；监督层不重放工具动作，业务收件箱沿用既有恢复语义。

## 范围与责任

Linux 的 `daemon start` 启动一个独立的薄 CLI 监督进程，后者运行实际 Host。`daemon status/endpoint` 仍报告真实 Host 的 PID；CLI 不持有 Session、Agent、Provider 或工作区业务状态。已有服务管理器继续拥有生命周期，`daemon run` 与桌面前台监督不改成另一套后台启动。本轮不声称 macOS/Windows 具有此 Linux 子进程清理保证。

监督进程在启动 Host 前设置 Linux child-subreaper。Host 退出后，即使工具通过 setsid、双重 fork 脱离原进程组，也会成为监督进程可回收的后代。清理只向监督进程自己的直接子进程发送 TERM，随后升级 KILL，并重复回收新接管的后代；清理未确认结束时拒绝启动另一个 Host。不扫描或终止同 UID、同名字的其他工作负载。

Host 异常退出后，先完成清理，再按 1/2/4/8 秒退避重启；连续五次短运行失败后停止自动重试并在 `cli-start.log` 留下原因。持续运行至少 30 秒会重置该失败计数。正常退出结束监督；显式 `daemon stop` 也取消尚未开始的恢复。单实例启动锁保护并发 start/stop，监督锁保护同数据目录的唯一监督者。

从 Agent 里显式 `daemon start` 创建的另一套 daemon 是独立生命周期。清理时只读取自身直接子进程的 fd/fdinfo：持有 `daemon-supervisor.lock` 全文件独占内核锁的监督者代表已经交接所有权，保留其工作树。仅同名进程或未持有锁的文件不构成交接。`specialty.cli.daemon-start-outlives-tool-group` 验收父 Host 强杀并恢复、父 daemon 正常停止后，独立 daemon 的原 PID 与连接仍可用。

Host 正常运行时也会非阻塞回收已退出的接管后代，避免孤儿变成长期僵尸；保留实际 Host 的退出状态给其 Child 所有者处理。`specialty.cli.daemon-crash-recovery` 还要求短命双重 fork 工具的 `/proc` 项在原 Host 存活时消失。

## 数据位置

`<data>/daemon-start.lock`、`daemon-supervisor.lock` 和 `daemon-supervisor.stop` 只表达本机生命周期：启动互斥、监督进程存活、显式停止意图。所有者是原生 CLI，权限仅限 OS 用户；存在一个锁文件不表示锁仍被持有。它们可随 daemon 数据目录删除，不保存项目或会话业务状态。新的显式 start 在取得监督锁后清除旧停止意图。

## 验收与边界

`specialty.cli.daemon-crash-recovery` 通过真实 CLI、Host/WASM、产品 shell 和公共 Client 验收。用例强杀实际 Host，要求脱离两次且忽略 TERM 的工具在 8 秒内退出、无需另发 start 而在观察窗内出现新健康 Host；同时检查机器身份、已保存会话、无意外执行、无关进程存活、并发 start 幂等和显式 stop 不被恢复抵消。故障进程和端口全部归属独立测试 lease。

GC/LRU、会话常驻预算、宿主机内存隔离不在此修复内。监督进程自身被强杀、机器宕机、内核无法结束的 D 状态进程不由本机制保证恢复；整个容器持续内存不足时也可能再次失败。WASM 正常热更新继续沿用原 Host 的 reload 路径，不增加 guest 内异常恢复框架。
