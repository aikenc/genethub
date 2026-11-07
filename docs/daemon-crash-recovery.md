# Linux 手动 daemon 的崩溃恢复

本轮目标是：原生 Host 被 SIGKILL（包括内核 OOM）终止后，清理旧执行进程，再使用同一渠道、身份和数据目录自动启动。已有记录保留，进行中的轮次可以中断；监督层不重放工具动作，业务收件箱沿用既有恢复语义。

## 范围与责任

Linux 的 `daemon start` 启动一个独立的薄 CLI 监督进程，后者运行实际 Host。`daemon status/endpoint` 仍报告真实 Host 的 PID；CLI 不持有 Session、Agent、Provider 或工作区业务状态。已有服务管理器继续拥有生命周期，`daemon run` 与桌面前台监督不改成另一套后台启动。本轮不声称 macOS/Windows 具有此 Linux 子进程清理保证。

监督进程在启动 Host 前设置 Linux child-subreaper。Host 退出后，即使工具通过 setsid、双重 fork 脱离原进程组，也会成为监督进程可回收的后代。清理只向监督进程自己的直接子进程发送 TERM，随后升级 KILL，并重复回收新接管的后代；清理未确认结束时拒绝启动另一个 Host。不扫描或终止同 UID、同名字的其他工作负载。

Host 异常退出后，先完成清理，再按 1/2/4/8/16/30 秒退避重启，随后保持最长 30 秒退避，不在第五次失败后永久放弃。实际 Host 持续运行至少 30 秒会重置该失败计数，清理耗时不计入存活时间。正常退出结束监督；显式 `daemon stop` 也取消退避或内存等待中的恢复。单实例启动锁保护并发 start/stop，监督锁保护同数据目录的唯一监督者。`specialty.cli.supervisor.repeated-kill-recovery` 覆盖六次连续强杀和恢复间隙的停止。

`start` 等待既有 owner 超时只报告失败；只有本次实际创建的监督进程才可由本次超时写停止意图。`specialty.cli.supervisor.observer-timeout` 将原 Host 暂停超过真实启动期限，再确认恢复原 PID 与公共连接，避免观察性的 start 变成 stop。

从 Agent 里显式 `daemon start` 创建的另一套 daemon 是独立生命周期。清理时只读取自身直接子进程的 fd/fdinfo：持有 `daemon-supervisor.lock` 全文件独占内核锁的监督者代表已经交接所有权，保留其工作树。旧式无监督 Host 若实际持有 `daemon.lock` 的全文件独占内核锁，且自身是 OS 会话首进程，同样保留；不依赖旧版新增锁格式或当时监听器是否响应。仅同名进程或未持有锁的文件不构成交接，也不授予对文件中 PID 发送信号的权限。`specialty.cli.daemon-start-outlives-tool-group` 和 `specialty.cli.supervisor.legacy-independent-owner` 分别验收有监督与旧式无监督拓扑，在父 Host 强杀并恢复、父 daemon 正常停止后仍保持独立 PID 和连接。后者使用真实前台 Host 重现旧拓扑，不冒充完整历史 App 二进制混装验收。

Host 正常运行时也会非阻塞回收已退出的接管后代，避免孤儿变成长期僵尸；保留实际 Host 的退出状态给其 Child 所有者处理。`specialty.cli.daemon-crash-recovery` 还要求短命双重 fork 工具的 `/proc` 项在原 Host 存活时消失。

## 内存压力下的恢复

监督者只在 OS 账户已允许的范围内，将自身继承的正 `oom_score_adj` 降至可写的最低非负值；已有负值保留，不请求 OOM 免疫或新增权限。创建的 Host 调整至 1000，使内核倾向回收 Host，监督者继续负责旧后代清理和恢复。调整失败会记录日志，不能据此保证监督者不会成为 OOM 目标。每台机器、每套 daemon 独立生效，不修改其他运行进程的优先级。

异常退出完成清理后，重启需要同时满足退避结束和可观测内存余量。余量取物理 `MemAvailable` 与可见 cgroup v1/v2 各级剩余额度的较小值；cgroup 已计费的 inactive file cache 按可回收部分处理。需要的余量至少为上一 Host 观测到的 RSS 峰值，以及 `GENEHUB_DAEMON_RESTART_HEADROOM_MB` 配置值（二者取大，默认配置值 256 MiB）。这是一项重启等待策略，不是内核内存预留或硬限额；第一次显式启动仍使用已有启动期限。无法读取内存观测时记录降级原因，继续遵守退避上限，不因观测永久缺失而放弃恢复。

`specialty.cli.supervisor.restart-headroom` 通过真实 CLI 配置高于可见容器限额的重启余量（无可见限额则使用物理容量），验证 Host 退出后只等待、不会创建替代 Host，且显式 stop 可取消等待；普通强杀用例验证余量足够时恢复。测试不在共享机器制造内存耗尽，SIGKILL 不等于实际内核 OOM 验收。整体容器 OOM（例如启用 `memory.oom.group`）仍需 OS 服务/容器 owner 承担外部恢复；参考 [Linux 内核 cgroup 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)。

## 数据位置

`<data>/daemon-start.lock`、`daemon-supervisor.lock` 和 `daemon-supervisor.stop` 只表达本机生命周期：启动互斥、监督进程存活、显式停止意图。所有者是原生 CLI，权限仅限 OS 用户；存在一个锁文件不表示锁仍被持有。它们可随 daemon 数据目录删除，不保存项目或会话业务状态。新的显式 start 在取得监督锁后清除旧停止意图。

## 验收与边界

`specialty.cli.daemon-crash-recovery` 通过真实 CLI、Host/WASM、产品 shell 和公共 Client 验收。用例强杀实际 Host，要求脱离两次且忽略 TERM 的工具在 8 秒内退出、无需另发 start 而在观察窗内出现新健康 Host；同时检查机器身份、已保存会话、无意外执行、无关进程存活、并发 start 幂等和显式 stop 不被恢复抵消。故障进程和端口全部归属独立测试 lease。

GC/LRU、会话常驻预算、宿主机内存隔离不在此修复内。监督进程自身被强杀、机器宕机、内核无法结束的 D 状态进程不由本机制保证恢复；整个容器持续内存不足时也可能再次失败。WASM 正常热更新继续沿用原 Host 的 reload 路径，不增加 guest 内异常恢复框架。
