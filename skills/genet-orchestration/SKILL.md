---
name: genet-orchestration
description: 用 genet CLI 派生、跟踪并验收子会话，以及跨已配对机器编排任务。用于把一个大任务拆给多个 Agent 会话、需要后台起会话稍后收口、或需要在另一台机器上执行的场景；不用于单轮问答，也不用于只有人能拍板的授权决定。
---

# 用 genet 编排会话

先读 `genet-cli`。那份讲每次调用都要遵守的机械契约，这份只讲偶尔才做的判断：什么时候值得
派生一个子会话，派出去之后怎么收得回来。

## 什么时候值得派生

派生一个子会话有真实成本：它是一个独立的上下文、一份独立的落盘记录、一个可能跑飞的进程。
值得的情况是**边界清楚且结果可验证**：

- 任务在另一个目录或另一台机器上，你自己的上下文过去没有意义。
- 任务需要一个你没有的 agent（不同模型、不同工具面）。
- 任务很长，而你需要在它跑的时候做别的事。

不值得的情况：你只是想要一个答案。那就自己回答，或者直接读文件。

## 前台跟到底，还是后台派出去

```bash
# 前台：跟到 turn 结束，退出码就是结论
genet codex "把 e2e 修绿" --cwd /srv/app --wait --timeout 900

# 后台：拿到 sessionId 就返回，会话继续在 daemon 里跑
genet codex "跑一遍全量回归" --cwd /srv/app --no-wait
```

`--no-wait` 的第一行就是 `session.created`，**先把 `sessionId` 记下来再做别的事**。没记下
来的会话不是消失了，是变成了一个你无法追踪、还在改文件的进程。

后台派生之后靠这两条收口：

```bash
genet session get <sessionId>                        # 状态与时间线快照
genet session send <sessionId> "继续" --since-seq <n>  # 再说一句，并从某个 seq 起接着看事件
```

只想看、不想说话时用 `session get`：`--since-seq` 是订阅流的起点，不是一个可以空手调用的
命令，`session send` 必须带一句真的要说的话。

## 收口：非 completed 的四种结局

只有 `status: "completed"` 是「做完了」。其余四种各有各的处理方式，不要一律当失败重跑：

| `status` | 真实含义 | 正确动作 |
|----------|---------|---------|
| `waiting` | 会话停在暂停点等人 | 读 `pendingRequest`，能判断就 `session respond`，判断不了就升级给人 |
| `failed` | turn 里出错了 | 读 `error.code`。`missingCredentials` 重试一万次也没用 |
| `detached` / `timedOut` | **会话还在跑** | 先 `session get`，别急着开第二个做同样的事 |
| `disconnected` | 连接断了，会话未必断 | 带 `--since-seq` 重连，不要重开会话 |

最常见的错误是把 `timedOut` 当成 `failed`，然后再派一个会话做同一件事——两个 agent 同时
改同一个仓库，产生的冲突比原任务难查得多。

## 验收要看事实

子会话说「改好了」不是证据。验收看的是它留下的东西：

```bash
genet session get <sessionId>     # 它到底调了哪些工具
```

再加上你自己能查的事实——文件内容、测试退出码、git 状态。让子会话自评的编排等于没有编排。

## 跨机器

```bash
genet machine list                                  # 我能连哪些机器
genet codex "重启采集器" --machine m_xxx --cwd /srv/collector
```

三条纪律：

- `--machine` 只认精确 id，没有隐式默认。目标写错就是在另一台机器上执行。
- 远程的 `--cwd` 必须是**目标机上的绝对路径**。
- 先看 `genet schema` 的 `routable`。`daemon start|stop` 这类本地专属命令远程会被拒绝，
  这不是限制而是保护：`daemon stop` 故意不依赖 daemon 配合，远端做不到这件事。

`machineOffline` 是**可重试**的——目标机短暂离线是常态，重试不消耗票据。
`machineNotPaired` 和 `credentialRevoked` 不可重试，需要人去配对或恢复授权。

## 权限与放权

`--auto-approve` 只对当次调用生效，不写状态，**也不会被它派生出去的会话继承**。这是刻意的：
授权应该是一次决定一件事，不是开一个会一直开着。

不要用「加 `--auto-approve` 让它别卡住」来解决 `waiting`。如果一个动作需要审批，那就是有人
认为它值得被看一眼。判断不了就升级，不要绕过。

## 自更新与会话存活

会话活在 daemon 里，不在 CLI 里。CLI 进程被杀、终端被关、SSH 断了，会话都还在跑。反过来，
daemon 重启会中断正在跑的 turn，但会话本身仍在盘上，重启后能重新打开。

因此：更新或重启 daemon 之前，先 `genet session list` 看有没有正在跑的会话；之后用
`genet session get` 确认状态，而不是假设它接着跑完了。
