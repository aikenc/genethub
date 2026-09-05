# 聊天卡死：统一失效模型与系统性方案（v3）

> 复核时间：2026-09-04（dev-chat 槽位）。
> 代码基线：open `dev-chat@6e78369`、cloud `dev-chat@145d38d`。
> 证据来源：`genethub-spaces` 远端分支 `issues/chat-state-error` 的 5 份反馈包
> （只读 `git show` 提取）+ 当前槽位逐路径代码走查 + `runs/260904-1017-freeze-v3-0afa`。
>
> **v3 修订说明**：v2 的 §2.2 把 fb_PT1yf1Q-UB9p 的根因写成「重连后快照到过客户端然后被丢弃」，
> 并据此做了修复。**这个因果是错的**——包里 `subscribe` 出现 0 次，那条代码路径从未执行（§2.2）。
> 错误的产生方式值得单独记下来：v2 只核了该结论**引用的代码行是否存在**，没有回原始包重新推导，
> 于是一个继承自 v1 的断言穿过了两轮 review。由此定下两条硬规矩，写在 §5.0：
>
> 1. **归因必须从原始反馈包重新推导**，不得继承上一版的结论，哪怕它标着「已证实」。
> 2. **每个修复的判据必须落在用户可见的量上**（composer 相位、能否发送下一条），
>    不得落在该修复自己新增的字段上——否则测试只是在复述实现。
>
> **本文不主张"已解决"**。唯一承认的验收标准在 §5.7，在它全绿之前，
> 对外只能表述为"某某路径的止血候选"。
>
> **终态说明（2026-09-05，第七批之后本文收尾）**：用户报的五条卡死已全部闭环，
> 各有先红后绿的用例在 open main 上（最后一批 `bc7e908`）。§5.7 的验收条仍**未**全绿——
> B4 是假绿、B5/B6/A4a 未写、J 与 G 组未跑，逐条见 §4.3。
> 因此对外的准确表述是：**五条已报告的卡死路径已修复并上主干，外加一条同源的数据丢失缺陷**
> （轮次进行中退出会丢掉整段回答，§4.1.7）；「系统性解决」按本文自己的定义尚未达成，
> 且 §4.2 记录了原定架构中被实测推翻的部分——这份提案的失准本身是这次反复的主要成本。

---

## 0. 结论摘要

1. **五条反馈是同一条不变量断裂在四个不同层面的显影**，但**不是同一个 bug**，
   也不能靠同一处修复覆盖。逐包重新归因见 §2.2：两条已由原始日志直接证实根因
   （fb_R7fAQhyHcVIK、fb_VllHtElqFlpW），一条已证实**不是**v2 说的那个根因
   （fb_PT1yf1Q-UB9p），一条只有现象无进程事实（fb_7BfCxiKPnTH-），
   一条根本不是缺陷而是"慢与死不可区分"（fb_ZdvAMx38s5qa）。
2. **不变量要重新表述。** v2 写的是"每个非终态 turn 最终都会到达终态"，
   这个表述会诱导出"超时即判死"的错误设计（v1 就是这么错的）。正确表述：

   > 任何非终态**始终**有明确的 owner、generation、可观测的活跃度和有界的恢复入口；
   > 终态**只在**收到可靠证据、用户命令或 daemon 重启结算时提交，且只提交一次。

   区别是实质的：它不承诺"自动收敛"，它承诺"永远有人负责、永远有出口、永远不重复结算"。
3. **卡死不止在 daemon。** fb_PT1yf1Q-UB9p 证明了一整类客户端故障：
   换 target 后新建 Client，而 store 的订阅表是跨 Client 的全局状态，
   于是会话被判定为 warm、永不订阅。**客户端的缓存与订阅必须有所有权维度**
   （`machineId` / `clientGeneration`），只有 `(daemonEpoch, revision)` 不够（M4）。
4. **逻辑 turn 与执行体必须分开建模。** 一个 turn 可以逻辑上已取消，而进程仍未被确认隔离。
   此时发布 `Idle` 是危险的：旧进程还能继续改工作区。需要显式的 `quarantine` 状态（M3）。
5. **`commit_transition` 必须定义崩溃语义。** 磁盘、内存、replay、broadcast 不可能物理原子，
   必须指定 durable journal 为线性化点、persist-first 顺序、各崩溃点的恢复动作
   （今天 `chat.jsonl` 只 `flush()`，不 `fsync`）。v2 只说"一次性推进"，没说崩在中间怎么办。
   **这一条落地了，但落在了没预料到的地方**（§4.1.7）：真正丢东西的不是状态提交，
   是**正文**——进行中的轮次一个字都不落盘，正常退出和崩溃都会让用户的问题下面空无一物。
   已引入 `open-turn.jsonl` 作为可重写的落点（每秒至多一次，`save_private` 保证原子），
   加载时提升进 `chat.jsonl`。代价上界从"整段回答"降到"最后一句"。
6. **诊断对这一类问题结构性失明**（§4.6）：包的保留窗口硬编码 10 分钟，
   而"卡了半小时"的事故现场恰好落在窗口外。不修诊断，下一次同样查不清。
7. **三条「证实」级反馈已各自有先红后绿的修复，并已合入主干**
   （`8c312e4`，2026-09-04）：fb_R7fAQhyHcVIK、fb_VllHtElqFlpW、fb_PT1yf1Q-UB9p。
   change 门禁 372/372（`260904-1600-systemic-2-3b66`，对重建后的 guest），
   merge 门禁 377 通过（`260904-1645-systemic-merge-05cf`，6 条失败全为第三方 CLI 额度 402，
   真实 Cursor 的两条 journey 通过，即 20 s 握手对真实 ACP CLI 成立）。
   **但这仍不是「系统性解决」**：C（提交点与代次）、D（重启与客户端收敛）、
   E2/E3（Starting 取消与迟到安装）、F1/F3（端到端身份）、B5/B6、M5、诊断均未闭环。
   对外只能说「三条已证实的卡死路径已修复并上主干」。
8. **收尾判定（第七批之后）。** 用户报的五条卡死全部闭环，各有红→绿用例在主干上。
   本提案原先规划的 M1–M6 中，**多数经实测被证伪或大幅缩水**：D-1（重启卡 Running）不存在，
   M3-1（事件泵丢终态）用 40000 事件证伪，C-2 空转，M1 造不出失败用例（§4.1.8）。
   真正找到并修掉的内核缺陷是三条，且只有一条在原计划的重点上：`settle_round` 无围栏、
   `publish` 取号非原子、**进行中轮次的正文完全不落盘**。最后这条不是卡死而是数据丢失，
   却是四条里用户损失最直接的一条，而它在前六批里一次都没被碰到——因为原有耐久性用例
   全是「轮次完成后再重启」。**提案本身的失准是这次反复的主要成本**，
   方法上的教训写在 §5.0：先用故障注入证伪假设，再动手实现。

---

## 1. 代码事实核验

行号对应 open `dev-chat@6e78369`。**已修**标记指第一批已落地（§4.1），其余为当前仍然成立的缺陷。

### 1.1 终态产生

| 事实 | 位置 | 状态 |
|---|---|---|
| ACP 读循环读到 EOF 后清空 `pending` 并 drop 发送端，复用 `AgentCrashed` 路径 | `adapter/acp.rs` `abandon_pending` | **已修** |
| 子进程退出监视，不依赖 stdout EOF（孙进程持管道时也能发现） | `adapter/acp.rs` `watch_for_exit` | **已修** |
| 其余适配器的 EOF 安全网 | `codex.rs:1493`、`claude.rs:1436`、`genet.rs:463` | 原有 |
| **适配器与内核之间唯一通道是 `broadcast`，终态与流式输出共用** | `adapter/mod.rs:153-155` | 未修（M3-1） |
| 容量 1024，pump 落后时 `Lagged` 只 warn + continue | `manager.rs:43`、`manager.rs:3256` | 未修（M3-1） |
| 接受 turn 之后没有看门狗 | 全文仅 3 处 `tokio::time::timeout` | 未修（M1） |

**实测佐证**：4000 事件洪水下，协议客户端**确实收不到**终态事件，只能靠 resync 快照得知
（`resyncStatus=idle`，run `260904-1017-freeze-v3-0afa`）。终态走可丢通道不是理论风险。

### 1.2 控制面

| 入口 | 位置 | 状态 |
|---|---|---|
| `send` 首次提示 | `manager.rs` `start_turn` | **已修**（取 `Arc` 后释放锁） |
| `interrupt` | `manager.rs` | **已修**（3s 期限 + 5s 宽限升级 + `round_id` 围栏） |
| `respond_permission` 恢复发送 | `manager.rs` | **已修** |
| `shutdown`（`session.close` 下游） | `manager.rs:2968-2976` | **未修** |
| `kill_tree` 结尾 `child.wait().await` | `adapter/mod.rs:420` | **未修** |

**`shutdown` 这条是第一批漏掉的，且提交说明把它算成已修，需要更正。** 代码形状是：

```rust
if let Some(agent) = self.agent.lock().await.take() {
    let _ = agent.close().await;      // ← 仍在锁内
}
```

工作区是 edition 2021（`Cargo.toml:46`），`if let` 的 scrutinee 临时值（这里是 `MutexGuard`）
活到整个 `if let` 语句结束，所以这里**依然持锁跨 `close().await`**，而 `close()` 下游是无界的
`kill_tree`。"关闭会话这条逃生口自身不会挂"目前**没有保证**。
（第一批新写的 `stop_if_still_running` 用的是先 `let agent = ….take();` 再 `if let`，是对的。）

#### 1.2.1 楔子的真实形态：宿主队列，不是内核管道

真实拓扑是 **WASM guest + host 进程代理**：daemon 逻辑编进 `apps/guest`，agent 进程由 host 启动
（`apps/host/src/process.rs`），guest 对 agent stdin 的写经 WIT `write-stdin` 落进 host 的
`mpsc::channel::<Vec<u8>>(64)`。这条队列**按消息计数**，一帧一条。

- 「`send` 写满管道所以持锁不返回」**不成立**：2.5 MB 提示词在 189–397 ms 内被 host 收下。
- **可达的楔子是队列填满**：96 次 `session.interrupt` 里恰好 64 次被应答，第 65 次挂起。
  修复前 `session.close` 挂到 60 s RPC 超时，修复后 10 ms
  （`specialty.concurrency.control-plane.close-after-repeated-stop-presses`）。

#### 1.2.2 爆炸半径不止一个会话

v2 写"爆炸半径限制在单会话内"，**这是错的**。`ensure_started` 要抢一把**进程级、按 agent 种类**
的锁（`manager.rs:2984` 的 `STARTING`），并在锁内跨越第三方 CLI 的首次启动：

```rust
let _starting = gate.lock().await;   // manager.rs:1904
```

一个卡在首启的 CLI 会拖住**同种 agent 的所有会话**的 `send`。这把锁本身有正当理由
（OpenCode 并发首启会互相破坏 SQLite），但它必须有期限和失败路径。

### 1.3 状态提交

| 事实 | 位置 | 后果 |
|---|---|---|
| `publish` 先 `fetch_add` 取 seq，之后才 `meta.lock().await`（让出点）再写 replay | `manager.rs:2629` → `2632` → `2637` | 并发发布可让 seq 乱序落进 replay |
| `settle_round(outcome)` 不接 turn/代次 | `manager.rs:2944` | 无 fencing |
| pump 对任意终态都 `settle_round`，不核对代次 | `manager.rs:3578` | 旧 turn 的迟到终态可结掉新 round |
| `finalize_after_channel_closed` 改状态但不 `publish`、不占 seq | `manager.rs:3993` | 客户端连"我落后了"都检测不到 |
| `Live::shutdown` 置 `Closed` 也不发布 | `manager.rs:2975` | 同上 |
| `Live::new` 里 `seq: AtomicU64::new(0)` | `manager.rs:2601` | 重启后 seq 归零，Running 静默消失 |
| conflict 守卫只看状态枚举，无 turn 年龄、无强制出口 | `manager.rs:1663` | 楔死后重发永远 `protocol.conflict` |
| **状态先于工作被宣布**：`*status = Running` + `publish` 发生在 `start_turn` 之前 | `manager.rs:1670-1680` | 见 §2.2 fb_R7fAQhyHcVIK |
| `chat.jsonl` 只 `flush()`，无 `fsync` | `session/store.rs` | 崩溃语义未定义（M2） |

### 1.4 客户端

| 事实 | 位置 |
|---|---|
| **订阅表是跨 Client 的全局状态**：`attach(client)` 只 `set({ client })`，从不重置 `subscribedSessionIds` | `session/store.ts:653` |
| target 变化会**新建 Client**（effect 依赖 `[endpoint, connect, host, target]`，旧的 `client.close()`） | `App.tsx:451-466` |
| `selectSession` 由 `subscribedSessionIds` 算 `warm`，`if (warm) return;` 跳过 `client.subscribe` | `session/store.ts:909`、`934` |
| 同一段把旧 timeline 原样恢复上屏 | `session/store.ts:918` |
| composer 把 timeline 状态与列表状态做 **OR**，stale 的 running 永远赢 | `session/Composer.tsx:59` |
| `onResync` 在 `reset === false` 时 `base = previous`，timeline 状态不被快照矫正 | `session/store.ts:965-979` |
| 第一批新增的 `adoptSnapshotStatus` 只写 `sessions[]`（列表），不写 timeline | `session/store.ts:2268` |
| 列表状态本来就由 Sidebar 每 2s 轮询刷新 | `shell/Sidebar.tsx:85` |
| `fillGap` 失败被吞，不重试 | `protocol/client.ts:1157-1185` |
| RTC 断链只置 `rtcState = "failed"`，不触发 resync | `protocol/client.ts:1486-1491` |

**这一组事实合起来说明第一批的客户端修复无效**：它写的是本来就正确的那个字段，
而且在 fb_PT1yf1Q-UB9p 的路径上，它所在的 `onResync` 根本不会被调用。

---

## 2. 统一失效模型

### 2.1 一条不变量，五层放任

```
[适配器]  终态一定会产生        ← ACP 已修；其余靠 EOF，无进程级兜底
    ↓
[通道]    终态一定会送达        ← 与流式输出共用 broadcast，Lagged 即丢（实测会丢）
    ↓
[内核]    状态变更一定会提交发布 ← 两条路径改状态不发事件；提交非线性化、无代次、无崩溃语义
    ↓
[控制面]  用户一定有出口        ← close 仍持锁跨无界 kill；首启锁跨会话
    ↓
[客户端]  视图一定收敛到权威     ← 订阅表跨 Client 复用；OR 两个状态源；resync 不矫正 timeline
```

任意一层单点失手，会话永久停在 Running，且没有任何一方会发现。

### 2.2 五条反馈逐包重新归因

**方法**：全部从 `issues/chat-state-error` 的原始包重新提取，不继承 v1/v2 结论。
`subscribe` / `session.send` 等是包内 `client/operation` 日志的真实字段，可计数。

---

**fb_PT1yf1Q-UB9p「列表已终止，输入框执行中」— 根因已改判**

| 包内事实 | 值 |
|---|---|
| daemon 侧会话状态 | `idle`，`updatedAtMs` = 2026-09-03T07:15:50.130Z |
| 截图与客户端 `state` 事件 | `running: true` 全程为真（该字段定义为 `state.timeline.status === "running"`，cloud `console/src/diagnostics.ts:596`） |
| 保留窗口 | 07:26:43 → 07:36:43 |
| `session.list` 调用 | **600 次** |
| `subscribe` 调用 | **0 次**（对照：其余四包为 32 / 6 / 6 / 32 次，说明该字段确实会被记录） |
| 07:35:46 发生什么 | pushState 到 `/m-94ddff54`；`sessions` 计数 198 → 53；连接 closed → reconnecting → ready |
| 两个 target | `m-496e0814`（568 次）、`m-94ddff54`（343 次） |

**结论**：v2 说的"重连 → resubscribe → fillGap → 快照到过客户端后被丢弃"**不成立**，
因为整个窗口内一次订阅都没有发生。真实形态是**换 target 建了新 Client，而该会话从未在新 Client 上订阅**。

**定级：现象已证实（subscribe=0 + daemon idle + 客户端 running），机制为高概率推断。**
代码里存在完全吻合的缺陷链（§1.4 前四行）：新 Client → `attach` 不清订阅表 →
`warm=true` → 跳过 `subscribe` → 旧 timeline 原样上屏。
未直接证明的一环是"s-95a413ac 在切走之前就已在 m-94ddff54 上订阅过"——该会话创建于 07:07:43，
早于保留窗口起点 07:26:43，时间线自洽但包内无直接记录。
**这一环由 §5.6 的 D3b 用例来证明或证伪，不在文档里当成事实。**

---

**fb_R7fAQhyHcVIK「状态坏了？」— 根因已证实**

| 包内事实 | 值 |
|---|---|
| 客户端 `session.send` | `ClientRequestTimeoutError`，`durationMs = 60008` |
| 紧接着重发 | `protocol.conflict`，106 ms |
| daemon 侧会话 | `status = running`，`narrativeItemCount = 0`，`roundCount = 0` |

**结论**：Running 被宣布了，但它背后**什么都没有**——没有 narrative、没有 round。
对应 `manager.rs:1670-1680`：状态置 Running 并广播发生在 `start_turn` 之前，
而 `start_turn` 随后要跨 `ensure_started`（含 §1.2.2 的进程级首启锁）和 `agent.send()`。
这段窗口里没有 owner、没有期限，round 要等 `agent.send()` 返回才建立。

**定级：证实，并已在测试中逐字复现。** 机制比 v3 初稿写的更简单也更硬：

> **daemon 的交接预算比客户端的 RPC 截止还长。**

客户端等 60 s（`protocol/client.ts:993`）。而一次首启在 ACP 侧可以花
`HANDSHAKE_TIMEOUT`（原 45 s）× 2——resume 失败会在新线程上重试一次——外加 catalog 握手。
于是 60 s 到点时客户端报 `ClientRequestTimeoutError`，daemon 还在跑，Running 仍然挂着，
用户这时重发就撞上 `manager.rs:1663` 的 conflict 守卫。

新用例 `specialty.agent.wedge.a-startup-that-hangs-does-not-claim-the-session-forever`
在修复前得到的正是包里那一句：

```
refused: ClientRequestTimeoutError: the daemon did not answer the request before its deadline
… and the session still says running, with nothing behind it
```

修复后两次发送都得到 `ProtocolError: the agent did not take this message within 55s`，
会话回到 idle，重发不再被判 conflict。

---

**fb_VllHtElqFlpW「无法终止任务」— 根因已证实**

包内 daemon 日志原文（两次，id 各不相同）：

```
turn/interrupt failed: expected active turn id 01a04cf4-1611-77c3-ac28-639c98eeb45d
                       but found 79567dec-d147-4761-8cf2-be6401c889bd
```

两次 `session.interrupt` 均以 `internal` 失败。

**结论**：Codex CLI 轮换了上游 turn id，而 `codex.rs:1118-1139` 拿会话里保存的单个
`state.codex_turn` 发 `turn/interrupt`。`codex.rs:1946-1951` 自己就有一句 warn 承认这个 id 会被替换，
但没有任何一致性协议。**定级：证实。** 第一批**完全没有改动 codex.rs**；
新增的 5 s 强杀可能让用户最终脱困，但不修身份失配。

---

**fb_7BfCxiKPnTH-「一直未停止，早就没输出了」— 现象证实，根因未证**

| 包内事实 | 值 |
|---|---|
| agent | cursor（ACP） |
| narrative | 1433 条 |
| round 台账 | `rounds: []`（空） |
| 06:04:03.962 | `session_interrupt_requested` → `session_interrupt_forwarded`，`elapsed_ms=0` |
| 07:01:45 抓包时 | `status = running` |

**结论**：ACP 的 `session/cancel` 是通知，"agent accepted" 只表示**写出成功**，
不表示 agent 停了。停止被"接受"后 57 分钟仍是 Running。
包内**没有进程存亡事实**，所以"进程死了"与"进程活着但无视 cancel"无法区分——
这正是 §4.6 要修诊断的原因。第一批的 ACP epilogue 覆盖前者、取消升级覆盖后者，
**两条都是合理覆盖，但不能声称复现了这次事故的根因。**

另注：1433 条 narrative 而 round 台账为空，说明 round 只在结算时落盘，
未结算的 round 在磁盘上**不留痕迹**——这直接决定了 M4 的重启结算需要先有 open round 的持久记录。

---

**fb_ZdvAMx38s5qa「又卡住了」— 不是缺陷**

| 包内事实 | 值 |
|---|---|
| round 1 | `outcome: completed`，07:00:32 之前已结束 |
| round 2 | `startedAtMs` = 07:00:32，`endedAtMs: 0`，`outcome: running` |
| 抓包时间 | 07:07:21 |

**结论**：第二轮在反馈时运行了 6 分 49 秒，**没有任何证据表明它卡死**。
它暴露的是"用户无法区分慢与死"。**定级：非缺陷，属 M5 的可观测性缺口。**
这条同时是"不得自动判死"的活证据。

---

### 2.3 归因汇总与覆盖

| 反馈 | 层 | 定级 | 第一批是否覆盖 |
|---|---|---|---|
| fb_R7fAQhyHcVIK | 内核（交接预算 > 客户端截止） | 证实并复现 | ✓ 第三批 |
| fb_VllHtElqFlpW | 适配器（Codex 身份） | 证实 | ✓ 第二批 |
| fb_PT1yf1Q-UB9p | 客户端（订阅所有权） | 现象证实 / 机制高概率 | ✓ 第二批 |
| fb_7BfCxiKPnTH- | 适配器（ACP 取消语义） | 现象证实 / 根因未证 | ~ 两条路径都有覆盖 |
| fb_ZdvAMx38s5qa | 可观测性 | 非缺陷 | ✗ 未做 |

---

## 3. 目标架构

六个机制。M1–M3 不可拆分实施；M4 依赖 M2 的 revision；M5、M6 可独立。
每个机制给出一条可机械检验的不变量。

### M1 — 生命周期有主：owner、generation、opId

**不变量**：任何非终态都有一个内核持有的 owner 任务；owner 消失时该状态不能继续存在。

```
Idle → Starting(opId) → Running(gen, turnId) → Waiting / Canceling / Quarantined → Terminal
```

- **`Starting` 必须先于宣布而存在。** 今天是先 `publish(Running)` 再去 `start_turn`（§2.2 R7）。
  改为：先建立 `Starting(opId)` 与它的 owner 任务，再宣布，再执行。
- **`opId` 与 `gen` 都由内核分配。** 适配器给的 turn id 不可信（Codex 会换）。
- **`Starting` 的取消协议**（v2 缺失，fb_R7fAQhyHcVIK 必需）：
  - owner 持有启动任务的 `JoinHandle` 与它的 `opId`；
  - `session.interrupt` / `session.close` 在 `Starting` 期间是合法操作，取消该任务并推进 `gen`；
  - **迟到成功必须被拒绝安装**：`ensure_started` / `agent.send` 在取消后才返回成功时，
    以 `opId` 比对，不匹配则把刚拿到的 agent 直接 `close()`，不得装进 `live.agent`；
  - `ensure_started` 的进程级首启锁（§1.2.2）必须有期限；超时按"这类 agent 暂时起不来"失败，
    不得让一个会话的首启拖住同类所有会话。
- **Waiting 期间 owner 暂停计时**，等待人类不算静默。

### M2 — 单一线性化提交点，且崩溃语义明确

**不变量**：生命周期、revision、replay、持久台账、对外广播在一个串行临界区内推进；
不存在"取了 seq 但还没写 replay"的中间态；崩溃后可判定该转换是否发生。

```rust
commit_transition(expected_gen, transition) -> Result<Committed, GenMismatch>
```

顺序（**persist-first**）：

1. 校验 `expected_gen`；
2. 追加 durable journal 记录（含 `daemonEpoch`、`revision`、转换、`gen`）——**这是线性化点**；
3. 变更内存生命周期；
4. 分配并写入 replay；
5. 广播。

**崩溃语义**（v2 缺失）：

| 崩在哪 | 恢复动作 |
|---|---|
| 2 之前 | 转换未发生。重启后 open round 由 M4 结算为 `abortedByRestart` |
| 2 之后、5 之前 | 转换已发生。重启时从 journal 重放到内存，`revision` 从 journal 续号 |
| 5 之后 | 正常 |

- **journal 的耐久度要求**：生命周期转换必须 `fsync`；流式事件不进 journal，不受此开销影响。
  今天 `chat.jsonl` 只 `flush()`，需要为生命周期记录单独提供 `fsync` 的写入路径。
- **不额外发 `SessionStatusChanged`**：终态事件本身即状态转换（v2 §6.2 的结论保留）。
- **可机械检验**：事件流中生命周期跃迁次数 == `commit_transition` 成功次数；replay seq 严格递增。

### M3 — 可靠终态、执行体隔离、外部等待有界

**不变量**：终态送达不依赖可丢通道；任何外部 await 都不持会话锁且有期限；
**执行体未确认隔离前不得回到可发送状态**；迟到事件按 `gen` 丢弃。

1. **通道分层。** 流式输出继续走 `broadcast`（丢了只是少几帧）；
   **完成结果走每 turn 一个的可靠 completion 通道**，或由内核直接 `commit_transition`。
2. **外部等待一律不持锁。** 剩余两处：`Live::shutdown`（§1.2）与 `kill_tree` 的 `child.wait()`。
   注意 edition 2021 的 `if let` 临时值作用域，必须先 `take()` 再进 `if let`。
3. **逻辑 turn 与执行体分离**（v2 缺失）。终止链：
   `interrupt(期限) → close/kill(期限) → reap(期限) → Quarantined`。
   - `Quarantined` 是**公开状态**：进程未确认死亡，工作区可能仍被改写。
   - 此状态下**允许**新 turn 吗？默认**不允许**同工作区新 turn，允许用户显式"放弃并新建会话"。
     这比静默回 `Idle` 诚实——后者会让两个进程同时改同一个工作区。
   - `stalled` / `suspected` 只是标记，不改变生命周期，不构成终止依据。

### M4 — 权威状态的两个所有权维度

**不变量**：客户端展示的状态总是它见过的最新一份 daemon 权威状态；
任何一次 resync 都不会让它变旧；**换 Client 不会复用上一个 Client 的订阅与缓存**。

1. **服务端维度 `(daemonEpoch, revision)`。** `Live::new` 把 seq 归零，
   所以裸比较在重启后是反的；epoch 变化一律强制替换，同 epoch 内比 revision。
2. **客户端维度 `(machineId, clientGeneration)`**（v2 缺失，fb_PT1yf1Q-UB9p 必需）。
   `subscribedSessionIds`、`sessionTimelines` 这类缓存必须按所属 Client 归属：
   - `attach(client)` 时若 `machineId` 或 `clientGeneration` 变化，订阅表清空、timeline 标记为待重绑；
   - `warm` 的判定必须是"**在当前 Client 上**已订阅"，不是"曾经订阅过"。
3. **启动时结算遗留 open round。** 需要 open round 在磁盘上先留痕（§2.2 7B 显示今天不留），
   重启后对没有终态的 round 提交 `abortedByRestart` 与新 revision。
4. **单一权威源，取消 OR。** composer 今天 `sessionBusy(timelineStatus) || sessionBusy(sessionStatus)`。
   OR 的初衷（切到后台标签时先显示 Stop）用"带 revision 的同一份权威状态"实现，
   而不是两个源赌谁更真。
5. **resync 的触发与失败处理**：`reset === false` 时也必须把快照的权威状态应用到 **timeline**；
   RTC 断链要触发 `fillGap`；`fillGap` 失败要恢复 `needsResync` 并退避重试。

### M5 — 活跃度可见与用户强制入口

M3 决定了系统无权自动判死，用户判断因此是主要恢复手段，不是辅助功能。

**落地时把 `stalled` 布尔量换成了 `lastActivityAtMs`**，理由是前者要求 daemon 先定一个阈值，
而「多久算不正常」恰恰是 daemon 唯一无法判断的事（fb_ZdvAMx38s5qa 的 6 分 49 秒完全正常）。
时间戳把判断权交给唯一有上下文的人，daemon 只报事实、不含策略：

- `SessionSummary.lastActivityAtMs`：本轮最后一次发布事件的时刻，**仅在 Running 时存在**。
  由 `Live::publish` 这一个扼流点写入，daemon 自身不读它，不存在据此终止的路径。
- composer 在静默超过 60 s 后，在停止键旁显示「已静默 X 分 Y 秒」；阈值在客户端，改动不涉及协议。
- 停止键本身就是强制入口，M3 的分级终止链已在其后（3 s 请求 → 5 s 宽限 → 强杀）。
- **仍未做**：`session.recover`（conflict 守卫拒绝时告知 turn 年龄并给出出口）。

### M6 — 适配器身份契约（新增，fb_VllHtElqFlpW 必需）

**不变量**：对上游 CLI 的每一次定向操作（interrupt / cancel），使用的标识符必须是
该 CLI **当前**承认的标识符；标识符失配必须是可恢复的，不是一次失败的 RPC。

- **Codex**：明确以哪个通知/响应为准。`turn/started` 通知与 `turn/start` 响应都可能给出 id，
  且后者会替换前者（`codex.rs:1946`）。契约要写清"最后一次胜出"还是"响应优先"，
  并在 `turn/interrupt` 失败且错误里带 `found <id>` 时，**用它重试一次**而不是直接报错。
- **ACP**：`session/cancel` 是通知，写出成功不等于停止。适配器不得把"写出成功"上报为"已接受"，
  日志与事件都要改口径（今天 `session_interrupt_forwarded` 会误导排障，见 §2.2 7B）。
- 每个适配器都要声明：interrupt 的语义是"请求"还是"保证"，内核据此决定是否需要升级。

---

## 4. 落地顺序与当前状态

### 4.1 已落地（第零批 + 第一批的一部分）

槽位分支 `dev-chat`：`b282e90` 故障注入基建与 A/B 组 case、`66b3519` 产品修复、`6e78369` 守护用例。
change 门禁 371/371（run `260904-1017-freeze-v3-0afa`，注意该 run 绑定 `b282e90 + dirty`，
**不是对最终提交树的封印**）。

| 项 | 红→绿证据 | 对应反馈 |
|---|---|---|
| ACP `read_loop` epilogue | `specialty.agent.wedge.exit-without-terminal` | 7B（其中一条路径） |
| 子进程退出监视 | `grandchild-holds-stdout` | 7B（另一条路径） |
| 控制面三处解锁 | `close-after-repeated-stop-presses` 60 s → 10 ms | — |
| interrupt 有界 + 升级 | `interrupt-escalates-past-a-deaf-agent` | 7B / Vll（兜底） |
| 升级按 `round_id` 围栏 | `a-new-message-survives-the-previous-stop` | — |

### 4.1.1 第二批（`e56b2fe`）：包里能自证的两条

| 项 | 红→绿证据 | 对应反馈 |
|---|---|---|
| 订阅按 client 归属 | `store.test.ts`「subscribes again after a machine switch replaces the client」，判据是 composer 相位 | **fb_PT1yf1Q-UB9p** |
| resync 非 reset 分支也用快照矫正 timeline | 同文件「takes the status from a snapshot the daemon thinks changes nothing」 | 同上 |
| Codex 按 CLI 自报的活跃 turn 重试 interrupt | `a_rotated_turn_is_recognised_from_the_refusal`，用例文本取自包内日志原文 | **fb_VllHtElqFlpW** |
| `Live::shutdown` 不再持锁跨 `close()` | 无新增用例（消除持锁，行为不变） | — |
| `kill_tree` 的 reap 有 5 s 期限 | 同上 | — |

### 4.1.2 第三批：启动交接（fb_R7fAQhyHcVIK）

| 项 | 值 | 理由 |
|---|---|---|
| `HANDOVER_BUDGET` | 55 s | 必须小于客户端的 60 s，否则客户端先放弃、Running 无人撤回 |
| `HANDSHAKE_TIMEOUT`（ACP） | 45 s → 20 s | 一次 send 里可能发生两次，两次要塞进上面的预算 |
| `START_GATE_BUDGET` | 40 s | §1.2.2 的进程级首启锁，等待也要有期限 |

红→绿：`specialty.agent.wedge.a-startup-that-hangs-does-not-claim-the-session-forever`。

**未生效但已提交的**：`adoptSnapshotStatus`（§1.4）。它写错了对象，且在 fb_PT 的路径上不会被调用。
它不造成回归（列表状态本就该等于快照状态），但**不能算作 fb_PT 的修复**，
其单测断言的也是本就正确的字段，需要在第二批一并改正。

### 4.1.3 第四批（`b7116f3`）：静默可见（M5）

| 项 | 红→绿证据 | 对应反馈 |
|---|---|---|
| `SessionSummary.lastActivityAtMs`，仅 Running 时存在，由 `Live::publish` 单点写入 | `long-silence-is-not-death` 加严：静默期间报得出时长**且仍在 running**，结束后字段消失 | **fb_ZdvAMx38s5qa** |
| composer 静默超 60 s 在停止键旁显示时长 | `workbench.test.tsx`「says how long a running turn has been quiet」，含取自该反馈的 6 分 49 秒 | 同上 |

字段落地前该断言必然红（读到 `undefined`，`waitUntil` 20 s 超时）。实测 note：
`reported quiet for 5042ms while still running`。

### 4.1.4 第五批：诊断分级保留（§4.6）

cloud `console/src/diagnostics.ts`。红→绿：`diagnostics.test.ts`「keeps sparse causal evidence
long after the chatter around it is gone」——改动前 `network`/`state` 在 30 分钟处已被逐出。
两条原有用例改写而非删除：它们断言的是旧的单一窗口，新契约下 `network`/`error` 属长窗口，
故改用短命 kind 表达同一条「过期即逐出」的规则。

### 4.1.5 这一轮之后，够得着的都做完了

第六批本来要做 C 组（提交点与代次）与 D 组（重启结算）。核实可达性后**决定不做**：

- **D-1 重启后卡 Running**：不存在。`Live::new` 加载时状态一律回 `Idle`（`manager.rs:2617`），
  只有挂起的权限请求会变 `Waiting`。重启不是冻结源。
- **C-1 迟到终态结掉新 round**：**这条判断是错的，已推翻。** ACP（`acp.rs:774`）与 Codex
  （`codex.rs:1933` 的 `is_current_turn`）确实在适配器层按 turn id 围栏，所以用受控 ACP agent
  构造不出来；但 claude 与 genet **没有**。`claude.rs:1952` 的 `translate_result` 和
  `genet.rs:695` 的 `agent_end` 都是拿 `state.id.take()` 当作终态的 turn——即当时状态里存着的
  那个，而不是这条终态本来属于的那个。claude 的 `result` 帧根本不带 turn 相关信息，无从核对。
  一条迟到或重复的终态若在新 turn 开始之后到达，会被盖上**新** turn 的 id 并结掉它。
  这正是 M2/M3 要把围栏放进内核的理由：四个适配器各自为战，两个做了两个没做，
  而 `settle_round` 自己一道围栏都没有。**未修，需要重新排期。**
- **C-2 `finalize_after_channel_closed` 不发状态事件**：确实是洞，但今天所有到达它的路径上
  `settle_round` 都已被别人结算过而返回 `None`（升级路径见 `manager.rs:3223`），它是空转的。

D-1 与 C-2 两条成立：是够不着的防御代码配空过的测试，按 §5.0 的纪律不写。
C-1 不成立，是把 ACP 一家的性质当成了全体适配器的性质——**这就是切香肠**，
记在这里作为下一轮的第一项。

### 4.1.6 第六批：内核，以及内核里够得着的到底有多少

带着「不许再切香肠」的要求重做 C 组。结论是内核里**有两条真缺陷**，另外两条**经实测被证伪**。

**真缺陷一：`settle_round` 没有围栏（M3-2）。** 已修。
`settle_round(Settling::Turn(id) | Settling::Kernel, outcome)`：适配器报来的终态必须点名
本轮正在跑的那个 adapter turn，点名旧 turn 的直接丢弃并记 `session_stale_terminal_ignored`；
内核自己结算（升级终止、通道关闭、权限被拒）走 `Settling::Kernel`，无 turn 可比。
围栏放在内核而不是各适配器，正因为四个里有两个做不到：claude 的 `result` 帧不带 turn id
（`claude.rs:1952` 拿 `state.id.take()`），genet 的 `agent_end` 同样。
红→绿：`a_terminal_from_a_superseded_turn_does_not_end_the_one_running`。

**真缺陷二：`publish` 的取号与写入不原子（M2 的事件面）。** 已修。
原代码在 `seq.fetch_add` 与 `replay.lock()` 之间夹着 `self.meta.lock().await` —— 一个真实的
让出点。多个发布者（事件泵、升级终止、启动本轮的那次调用）并发时，取到 5 和 6 的两方
可以按相反顺序写进 replay，于是补历史的客户端拿到一段从未发生过的顺序，广播侧同样错序。
改为在 replay 锁内取号、写入、广播，三件事一步完成。
红→绿：`concurrent_publishers_leave_the_replay_in_sequence`，**未改动的真实代码 3/3 红**，修后 3/3 绿。

**被证伪一：事件泵落后丢终态（M3-1）。** 曾判定为「最要紧的一条」，实测不成立。
造了 `flood-events` 40000 事件的爆发用例，**旧内核 7.5 秒结算到 idle，通过**。原因是泵只做
内存里的合并与精简，而生产者要把 JSON 逐行序列化过管道——泵结构上快于生产者，落不下来。
4000 事件那次的 `resyncs=1`、`events=1044`（≈广播容量 1024）说明落后的是**客户端**接收端，
不是泵；客户端那侧有 gap 声明 + resync 的修复协议，且实测走通。
因此「接收与处理分离」的重构与「按 gap 补结算」的兜底**都已撤回**：前者买不到可测的东西
还引入无界队列，后者会在够不着的路径上伪造一个 `TurnFailed` 事件。那条 40000 用例也删了，
它红不了。

**被证伪二：见 §4.1.5 的 D-1 与 C-2。**

**顺带修的两条主干红**（都不是本批引入，但都被合进了 main 而无人察觉）：
`cli_front/query.rs:1857` 构造 `SessionSummary` 缺字段导致 `--all-targets` 不编译（b7116f3 引入）；
`adapter::codex::tests::a_child_thread_cannot_write_to_or_complete_the_root_turn` 自 `cff919a`
起失败（新增的 `TurnProgress` 插进了用例断言的严格序列，改为跳过进度事件，其余断言不动）。
门禁按 L13 有意不跑 `cargo test`，两次门禁全绿。已记为管线问题
`pi-20260904T142026Z-365c890424`。**此后本地合入前必须跑 `cargo test -p genet-daemon --lib`。**

### 4.1.7 第七批：耐久性——回答会消失，而这不是卡死

第六批收尾时读代码留下一条未验的风险：轮次进行中进程没了，本轮正文是否会丢。实测**成立，
且比预想的广**——不只崩溃，**正常退出也丢**。

红的证据（`persistence-depth`，两条独立用例）：受控 ACP agent 说出一句就沉默，客户端确认
已经渲染，此时结束 daemon 并重启，会话里只剩下用户那句话：

```
[{"type":"userMessage","text":"Say something, then stall.","attachments":[]}]
```

**根因是耐久性边界画错了位置。** 正文只在轮次结束时落盘：`flush_turn` 是唯一的写入点，
而它只从终态事件里被调用。于是：

- **正常退出（`genet daemon stop`，托盘退出走的就是这条）**：`Sessions::shutdown` 只做
  `end_what_it_left`（杀残留子进程）+ `Live::shutdown`（abort 泵、close agent、置 `Closed`），
  既不结算也不落盘。`finalize_after_channel_closed` 的注释本来就写明了它在这条路上不会跑。
- **崩溃（SIGKILL / OOM / 断电）**：同上，且没有任何机会补救。

这不是「卡死」，是数据丢失，用户看到的是自己的问题下面空无一物。前六批一条都碰不到它，
因为现有六个持久化用例**全部是「轮次完成之后再重启」**——耐久性只测了容易的那一半。

**修法一（正常退出）**：`Live::shutdown` 在 abort 泵之后、关 agent 之前，先
`settle_round(Settling::Kernel, Canceled)` 再 `flush_turn`。泵先停是为了落盘时时间线不再变动。

**修法二（崩溃）**：给进行中的轮次一个**可重写的落点**，与工作项的 trunk 文件同构。
`chat.jsonl` 是追加式的，同一段正在增长的回答不可能反复追加而不重复出现；
`open-turn.jsonl` 则整体重写，最后一次写入即真相，走 `save_private`
（临时文件 → fsync → 原子 rename → 同步目录），崩在写的中途不会留下半个文件。

- 写入时机：事件泵处理 `Item` / `ItemDelta` 时调用，**每秒至多一次**。按 token 写会把一次
  回复变成几千次重写；只在结束时写就是现在这个缺陷。代价上界因此是明确的一句话，不是整段回答。
- 加载时机：`recover_interrupted_turn` 把它**提升进 `chat.jsonl` 然后删除**，而不是只拿来显示。
  这样日志重新成为唯一的耐久归宿，下一次启动不需要知道发生过这件事。日志里已有的条目优先，
  以防「追加成功但删除失败」变成显示两遍；追加失败则保留文件下次再试，不丢。
- 轮次结束时：`flush_turn` 追加成功后清除该文件。

红→绿证据：
`specialty.agent.persistence.quitting-mid-turn-keeps-what-was-said`（正常退出）与
`specialty.agent.persistence.crashing-mid-turn-keeps-what-was-said`（SIGKILL），
修前 2/2 红，修法一之后前者绿、后者仍红，修法二之后 2/2 绿。
两条都追加断言了**连续两次重启后那句话恰好出现一次**，用来盯住「提升进日志」这个新机制
自己可能带来的重复；原有六条持久化用例同批全绿，说明没有把重复写进正常路径。

**留档：轮次台账在崩溃后仍是未结算的。** 崩溃时 `chat.jsonl` 里那条 round 记录没有 outcome。
它不影响状态（加载一律回 `Idle`，会话可用）也不影响正文（已由上面的机制恢复）。
是否要在加载时合成一个结算，本轮没有做，也没有证据说它对用户可见。

### 4.1.8 M1（单一所有者 + 看门狗）：决定不做

M1 要的是每个非终态有唯一所有者、带 generation 计数，外加一个看门狗。本轮按 §5.0 的纪律
核实可达性，**造不出失败用例**：

- 陈旧任务写进新 agent 实例——`agent` 字段是 `Mutex<Option<Arc<dyn AgentSession>>>`，
  取句柄的一方持有的是那一个实例，换实例不会让它写到新的上面去。
- 轮次层的错配已由 M3-2 的围栏挡住，事件顺序已由 M2 的原子发布挡住。
- 看门狗要判定「多久算死」，而 §6.1 已经证伪过这个判断本身：静默不是死亡的证据。
  M5 的做法（把静默时长如实显示，由人决定）才是这一条的正确形态，且已落地。

因此 M1 归入「没有已知缺陷支撑的结构严谨性」，不实现。若将来出现能复现的失败路径，
按红→绿的顺序重开。

### 4.2 原定的批次划分：已作废，留档

下面四小节是 v3 起草时排的后续批次。**它们已被实测推翻，不再是计划。**
留在这里是因为「计划本身错在哪」是这次反复的主要成本，值得对照着看：

> ~~**第二批 — 内核（M1 + M2 + M3），不可拆。** 三者拆开会留下比现状更糟的中间态
> （有 supervisor 无 fencing = 强制结算把新 round 结掉）。先做 M2 的 journal 与
> `commit_transition`，因为 M1 的 owner 与 M3 的 fencing 都要在它上面表达。~~
>
> ~~**第三批 — 收敛（M4 + M6）。** M4 的两个维度可以并行；M6 按适配器分别做，Codex 优先。~~
>
> ~~**第四批 — 可观测性（M5 + §4.6 诊断）。**~~
>
> ~~**收尾。** `respond_permission` 全链有界、genet `close` 补 `kill_tree`、
> opencode 阻塞 POST 加总超时。~~

实际结果：M1 造不出失败用例（§4.1.8）；M3-1 用 40000 事件证伪（§4.1.6）；
M2 里真正的缺陷不是设想的 journal 而是 `publish` 取号非原子（§4.1.6）；
M3 里真正的缺陷是 `settle_round` 没围栏（§4.1.6）；
而**最大的一条 M2/M3 都没预见到**——进行中轮次的正文完全不落盘（§4.1.7）。
M4 客户端所有权维度、M5、M6、诊断分级均已落地（§4.1–§4.1.5）。

「不可拆」这个判断也没成立：M2 的事件面与 M3 的围栏各自独立先红后绿，
中间态并不比现状糟。当初认为不可拆，是因为设想中它们共用一个还不存在的 journal。

### 4.3 仍然开着的条目

按 §5.0 的纪律，只列**有已知证据支撑**的：

- **B4 是假绿**：`ignore-sigterm` 用例在 Linux 上够不到 `child.wait()`，需要真正阻塞 reap 的档位
  才能验证有界性（§5.6 B 组）。`kill_tree` 的有界等待已加，但这条用例现在证明不了它。
- **B5 / B6 待写**：权限等待中队列填满、同种 agent 首启锁被占住时另一会话的 `send`。
- **崩溃后轮次台账未结算**：`chat.jsonl` 里那条 round 没有 outcome。不影响状态与正文，
  是否要在加载时合成结算，无用户可见证据支撑（§4.1.7 末）。
- **A4a 待写**：`flood-events` 下 round 台账恰好一条终态记录。M3-1 被证伪后这条的价值下降，
  但台账唯一性本身还没有用例守着。

### 4.4 已作废的判断，集中见 §6

### 4.5 诊断（已落地，见 §4.1.4 与下节）

### 4.6 诊断：反馈包必须覆盖事故

实测五份包（`droppedEvents` 为包内真实字段）：

| 反馈 | 保留 | 丢弃 | 窗口 |
|---|---|---|---|
| fb_PT1yf1Q-UB9p | 908 | 11016 | 07:26:43 → 07:36:43 |
| fb_7BfCxiKPnTH- | 822 | 8035 | 06:51:48 → 07:01:45 |
| fb_ZdvAMx38s5qa | 1444 | 8047 | 10 分钟 |

窗口硬编码 10 分钟（`console/src/diagnostics.ts:213`，`MAX_EVENT_AGE_MS`）。
fb_PT 的 round 始于 ~07:08，窗口从 07:26 才开始——**turnStarted 根本不在包里**。
设计注释写着"Feedback answers 'what just happened'"，这个假设对"卡了半小时"恰好不成立。

两处改动，都不放大包体：

**分级保留**（已落地）：`console`/`scroll`/`keyboard`/`input`/`click`/`resource`/`log` 保留 10 分钟；
`state`/`error`/`navigation`/`csp`/`network` 保留 2 小时。实测 92% 额度被 `client/operation`
（`kind: "log"`）占用，压缩它足够腾出关键事件的长窗口。条数与字节上限未动，长窗口不放大包体。
实现上：入环时按事件自己的预算逐出队首，并每 256 次推入做一次全环清扫——队首若是长命事件，
会挡住它身后已过期的噪声，而每次推入都做全量过滤是线性开销。

**附带服务端事实**：已经有了，不需要新做。包内 `sessionReport.roundPages` 就带 round 台账，
fb_ZdvAMx38s5qa 的包里能直接读到第二轮 `outcome: "running"`、`endedAtMs: 0`——
本轮对该反馈「不是缺陷」的判定正是这么做出来的。

**遗留疑点**：fb_7BfCxiKPnTH- 的包里 `rounds: []` 为空，而同一份包报告 1433 条 narrative
且状态为 running；同样 running 的 fb_Zd 却带得出 open round。两者差异未查清，
在弄明白之前不能假定「状态类反馈一定带得到 round 台账」。

**给用户的临时判别法**（M4 落地前有效）：刷新页面后看会话列表——
列表已终止而输入框仍在转 = 客户端失同步，刷新即愈；列表也显示在跑 = daemon 侧真楔死。

---

## 5. 验收门槛与测试工程设计

**在 §5.6 的矩阵全部通过之前，不得声称"系统性解决"。** 这是本文档唯一承认的验收标准。

> **治理版本**：`engineering-principles.md` blob `c731193ddb0681be700ebae37ab160815ef91767`；
> `engineering-laws.md` blob `48f12e4c0d31aa6eea71af81f581f9e297b467b6`（cloud `dev-chat@145d38d`）。

### 5.0 两条从 v2 事故中来的硬规矩

1. **归因从原始包重新推导**，不继承上一版结论。§2.2 每一行都要能指回包内字段。
2. **判据落在用户可见的量上。** 反例（v2 实际犯的）：修 `adoptSnapshotStatus` 写 `sessions[]`，
   测试就断言 `sessions[0].status` —— 而症状在 `timeline.status` 与 composer 相位上。
   **规则**：客户端类修复的 oracle 必须是 `resolveComposerPhase` 的输出或"能否发出下一条消息"，
   不得是该修复自己写入的字段。

### 5.1 为什么现有测试没抓住这些问题

1. **故障注入点全在 LLM 边界。** `fault-depth` 用 `opened.mock.script({ status: 500 })`，
   那是内置 agent 经 provider HTTP 的故障；五条反馈全在第三方 CLI 的 stdio/JSON-RPC 边界。
2. **真实 CLI journey 无法制造确定故障**，`claude-interrupt` 连"模型提前答完"都只能 `BlockedError`。
3. **没有"控制操作互相阻塞"维度的断言**——这是 §1.2 那把锁唯一的可观测形式。
4. **客户端只有 workbench 自己的 vitest，且不覆盖跨 Client 的所有权。**
   fb_PT 就死在这个盲区里：store 测试全部在单个 Client 生命周期内构造。

### 5.2 关键设计：用产品配置接一个受控的真实 Agent 进程（已落地）

`agents.custom`（`apps/daemon/src/config.rs`）是产品既有配置。case 在自己的 `XDG_CONFIG_HOME`
里声明一个 `extends: "acp"` 的自定义 agent，`command` 指向受控 Node 脚本。
daemon 起真实子进程、走真实 stdio、说真实协议。

按 L02 登记的三件事（边界 / 补偿性真实 canary / 失效条件）见 v2 原文，结论不变：
只替换 Agent CLI 这一个外部进程；真实 CLI journey 继续在同 gate 跑；
`normal` 档位必须与真实 CLI journey 断言同一组事件序列，该档失败即视为替身失效。

**已实现档位**：`normal`、`accept-then-silent`、`exit-without-terminal`、`grandchild-holds-stdout`、
`ignore-interrupt`、`ignore-sigterm`、`stdin-never-drains`、`flood-events`。
**待增**：`late-terminal-after-recover`、`duplicate-terminal`、`out-of-order-terminal`、
`slow-initialize`（M1 的 Starting 挂起）、`rotate-turn-id`（M6 的 Codex 身份，`extends: "codex"`）。

### 5.3 分层归属

| 层 | 放什么 |
|---|---|
| Infrastructure | 受控 Agent 脚本、daemon 重启能力（**待建**，D 组需要） |
| Framework | `openControlledAgentSession`（已有）、`restartDaemon`（待建）、`assertSettledOnce`、`assertSeqMonotonic` |
| specialty | 绝大多数 case |
| journey | 只有 §5.6 的 J1 / J2 |
| workbench vitest | **客户端所有权与 composer 相位**（§5.4 说明为何必须在这一层） |

新增目录：`specialties/daemon/lifecycle-commit-depth.specialty.ts`、
`specialties/recovery/lifecycle-restart.specialty.ts`、`specialties/connectivity/`。

### 5.4 证据面：断言用什么公开事实来判

| 要证明的事 | 公开证据 |
|---|---|
| turn 到达终态 | 事件流中的 `turnCompleted`/`turnFailed`/`turnCanceled` |
| 只结算一次 | 磁盘 round 台账计数 + 终态事件计数 |
| seq 严格递增无空洞 | 客户端收到的序列 + `subscribe` 的 replay |
| 旧执行体已隔离 | OS 事实：进程组消失 |
| 控制操作有界 | 各 RPC 的返回时间与返回类型 |
| 重启后有明确终态 | 重启后 `session.rounds` 的 outcome |
| **客户端收敛** | **见下** |

**客户端这一条要分两层，这是 v2 的错误所在。**

v2 写"用 `@genehub/web/client` 侧派生状态，不 import `packages/workbench/src/**`"。
结果是：洪水 case 用协议客户端读 snapshot status 通过了，而真实症状在 workbench 的
timeline / composer 上，两者之间隔着 store 的全部逻辑。**协议层绿不能推出用户层绿。**

| 层 | 在哪测 | 证明什么 |
|---|---|---|
| 协议层 | `testing/specialties/connectivity/` | daemon 交出的快照与事件本身是自洽、可收敛的 |
| 用户层 | `packages/workbench` vitest | 给定那些快照与事件，store 与 composer **确实**收敛 |

用户层不进 Playwright（L06，无页面事实）：`resolveComposerPhase` 是纯函数，
store 是可驱动的，两者组合足以断言"输入框还能不能发下一条"。

**接口缺口（L08，未就绪时 case 必须 `blocked` 而非 skip/pass）**：
`Quarantined`、`(daemonEpoch, revision)`、`session.recover` 目前都不在协议里，
它们属于 M3/M4 的产品实现范围，不是测试专用字段。
`lastActivityAtMs` 已落地（M5），A3 因此解除 blocked。

### 5.5 关于源码就近 Rust 验证

默认 TypeScript。唯一考虑的例外是 M1 生命周期转换表的穷尽性质（纯函数、无 I/O、需穷举）。
按 L12 的编写前检查逐项记录；给不出理由就不写，改在 TS 侧用代表性输入覆盖。

### 5.6 故障注入矩阵（按反馈重写）

**A 组 — 终态强制（M1 / M3）**

| ID | 档位 | oracle | 状态 |
|---|---|---|---|
| A1 | `exit-without-terminal` | 子进程退出后有界出现终态并回到可发送 | **绿** |
| A2 | `grandchild-holds-stdout` | 同上，且不依赖 EOF | **绿** |
| A3 | 15 s 静默后正常完成 | 静默期间 daemon 报得出静默时长**且仍在 running**，随后 `turnCompleted`，结束后活跃度字段消失 | **绿**（`long-silence-is-not-death`，M5 落地后解除 blocked） |
| A4a | `flood-events` | **adapter→kernel**：终态被可靠提交，round 台账有且仅有一条终态记录 | 待写（M3-1） |
| A4b | `flood-events` | **kernel→client**：终态事件丢失后，客户端仍收敛 | **绿**（协议层）／用户层待写 |

**B 组 — 控制面存活（M3-2）**

| ID | 场景 | oracle | 状态 |
|---|---|---|---|
| B1 | 64 条队列填满后 | `session.close` 有界返回 | **绿** |
| B2 | 同上 | 其他会话的 `session.list` / 新建不受影响 | **绿** |
| B3 | `ignore-interrupt` | interrupt 超时升级为终止，回到可发送 | **绿** |
| B4 | `ignore-sigterm` **且 reap 不返回** | 终止链有界；进程未确认死亡时进入 `Quarantined` 而不是 `Idle` | 现有用例是**假绿**（Linux 上 SIGKILL 立刻回收，够不到 `child.wait()`）。需要真正阻塞 reap 的档位 |
| B5 | 权限等待中队列填满 | `respond_permission` 有界，其余控制操作不受影响 | 待写 |
| B6 | 同种 agent 首启卡住 | **另一个会话**的 `send` 仍有界失败，不被拖住 | 待写（§1.2.2） |

**C 组 — 提交点与代次（M2 / M3-3）**

| ID | 场景 | oracle |
|---|---|---|
| C1 | 强制终止与真实终态同时到达 | round 台账中该 round 恰好一条终态记录 |
| C2 | `late-terminal-after-recover` | 迟到终态按 `gen` 丢弃，新 turn 不受影响 |
| C3 | `duplicate-terminal` / `out-of-order-terminal` | 收敛到单一正确终态 |
| C4 | 并发 send + 状态变更 | 客户端收到的 seq 严格递增、replay 无乱序 |

**D 组 — 重启与客户端收敛（M2 崩溃语义 / M4）**

| ID | 场景 | oracle | 对应反馈 |
|---|---|---|---|
| D1 | turn 进行中杀 daemon，重启 | 该会话出现 `abortedByRestart` 终态与新 revision | — |
| D2 | 在提交的各阶段杀 daemon | 重启后不存在"无终态的 open round"；journal 可判定 | — |
| **D3a** | **同一 Client** 断数据面 → daemon 侧完成 round → 恢复 | 客户端一个周期内自愈，不刷新 | — |
| **D3b** | **换 target 建新 Client**，选中一个曾在旧 Client 上订阅过的会话 | **新 Client 上必须发生 `subscribe`**；composer 相位回到 idle | **fb_PT1yf1Q-UB9p** |
| D4 | RTC 断链（数据面不断） | 触发 resync 并收敛 | — |
| D5 | resync 首次失败后恢复 | 退避重试并最终一致 | — |
| D6 | daemon 重启后 epoch 变化 | 客户端强制替换而非比大小 | — |
| **D7** | **轮次进行中正常退出 daemon**（`genet daemon stop`，即托盘退出），重启 | 客户端已渲染的助手正文仍在快照里，且**连续两次重启后恰好出现一次** | **绿**（`quitting-mid-turn-keeps-what-was-said`，§4.1.7） |
| **D8** | 同上，改为 **SIGKILL** | 同上 | **绿**（`crashing-mid-turn-keeps-what-was-said`，§4.1.7） |

**D3b 是本轮新增的关键用例**：它既证明 fb_PT 的机制推断（§2.2），又守住修复。

**D7/D8 是第七批新增，判据落在"用户还看得见自己读过的那句话"上。** 两条都先红后绿，
且都追加了二次重启的去重断言——因为修法本身（加载时把 `open-turn.jsonl` 提升进 `chat.jsonl`）
引入了重复的可能。D1 的「`abortedByRestart` 终态与新 revision」本轮**未做**：
崩溃后台账里那条 round 确实没有 outcome，但它不影响状态也不影响正文，没有用户可见的证据支撑。
它必须在 workbench vitest 层写（跨 Client 的 store 行为），且 oracle 是 composer 相位。

**E 组 — Starting 阶段（M1，fb_R7fAQhyHcVIK）**

| ID | 场景 | oracle |
|---|---|---|
| E1 | `slow-initialize`：agent 接受连接但迟迟不完成 initialize | `session.send` 在有界时间内给出确定结果；daemon 不停留在无 round 的 Running |
| E2 | E1 期间按停止 | 启动任务被取消，会话回到 Idle，`gen` 推进 |
| E3 | E2 之后启动任务才成功返回 | 迟到的 agent 被 `close()`，不安装进会话；新 turn 不受污染 |
| E4 | 同种 agent 的首启锁被占住 | 见 B6 |

**F 组 — 适配器身份（M6，fb_VllHtElqFlpW）**

| ID | 场景 | oracle |
|---|---|---|
| F1 | `rotate-turn-id`（`extends: "codex"`）：CLI 在 turn 中途换 id | `session.interrupt` 成功；不出现 `expected … but found …` |
| F2 | interrupt 返回 `found <other-id>` | 适配器用该 id 重试一次并成功 |
| F3 | ACP `session/cancel` 写出成功但 agent 不停 | 日志/事件不得声称"已接受"；升级链接管 |

**J 组 — 端到端用户目标**

| ID | 用户目标 | oracle |
|---|---|---|
| J1 | 「我的对话卡住了，我要停掉它继续用」 | 对楔死会话按停止 → 回到可发送 → 立刻发下一条成功 |
| J2 | 「网络抖了一下，我不想刷新页面」 | 数据面中断期间 round 完成 → 恢复后输入框自动可发送 |

**G 组 — 并发与 soak**

| ID | 场景 | oracle |
|---|---|---|
| G1 | 多客户端并发 send/stop/close 同一会话 | 任意交错下不出现"非终态但无 owner"，且最终一致 |
| G2 | 长时间 soak（重型池，不进 change/merge） | 无状态泄漏、无残留进程、无未结算 round |

### 5.7 验收门槛

**"系统性解决"的充要条件**：A、B、C、D、E、F、J 组全绿，G1 全绿，
且 §2.2 表中每一条"证实"级反馈都有一条直接对应的绿色用例。

gate 归属：A/B/C/D/E/F 进 `change` 与 `merge`；J1/J2 与 G1 进 `beta`；G2 独立排期。

### 5.8 实施纪律

- 测试与产品修复分属不同提交（P12 / L11）；case 先写先跑红。
- 新写完先跑 `testctl lint` 与 `testctl governance check`，再跑受影响 case 与 gate，一律经 `testctl`。
- 提交前对 `P01–P13` / `L01–L16` 逐项给出结论，写入任务验证记录（L14）。
- **run 必须绑定干净树**：上一轮的 371/371 绑的是 `b282e90 + dirty`，
  不能作为最终提交的封印，本轮不得重演。
- **改了 daemon 就必须先重建 guest 组件**。testctl 用的是
  `target/wasm32-wasip2/iterate/genehub_guest.wasm` 这个**已构建产物**，自己不编译、也不校验新旧。
  本轮实测：09:48 的产物被 14:40 的 change 门禁照单全收，daemon 侧改动一行都没进去，
  371/371 只覆盖了 TS 侧。发现方式是新用例的握手间隔仍是 45 s——如果没有这个用例，
  这次门禁会以「全绿」的形式给出完全无效的结论。
  流程固定为 `cargo build -p genehub-guest --target wasm32-wasip2 --profile iterate`（约 2.5 分钟）
  后再跑门禁。这条也已作为管线问题单独归档。

### 5.9 与发布的关系

五条反馈全部产生在 Beta `v0.12.0-beta.1-10-gad8f79f · cloud 95f8aba`（2026-08-29 构建）。
已落地的止血合入主干后应尽快进 Beta，但：

- **第二批之前不得对外表述为"卡死已解决"**；
- **§5.7 全绿之前不得声称"系统性解决"**；
- 专项绿只证明专项，测试资格不等于发布授权（L10）。

---

## 6. 被证伪的部分（留档）

### 6.1 v1：「静默 10 分钟即判死」

会杀掉 fb_ZdvAMx38s5qa 这种正常长任务。**静默只能标记，不能判死。**

### 6.2 v1：「`set_status` + 另发事件」

终态事件本身已承载状态变化，额外发 `SessionStatusChanged` 会产生重复事件并暴露假 `Idle`。
**要的是单一 `commit_transition`。**

### 6.3 v1：「interrupt 加超时即可」

`send` 也持同一把锁，interrupt 阻塞在 `lock()` 上，timeout 永远不会启动。

### 6.4 v1：「supervisor 合成 `TurnFailed` 走正常 pump」

pump 的输入就是那条会丢包的 broadcast。**终态必须走可靠通道。**

### 6.5 v1：「`statusSeq` 裸比较」

`Live::new` 把 seq 归零，重启后新状态会被判成更旧。必须 `(daemonEpoch, revision)`。

### 6.6 v2：「fb_PT1yf1Q-UB9p 是快照到过客户端后被丢弃」— 本轮证伪

包内 `subscribe` 出现 **0 次**，`onResync` 从未执行。真实形态是换 target 后新 Client 从不订阅。
据此做的 `adoptSnapshotStatus` 修复在该路径上不会被调用，且写错了对象（写列表而非 timeline）。
**教训**：核实"结论引用的代码行存在"不等于核实"结论成立"。

### 6.7 v2：「送 stdin 会阻塞所以 send 持锁不返回」— 本轮证伪

WASM host 用 64 条消息的 mpsc 缓冲，2.5 MB 提示词 189–397 ms 即被收下。
真实楔子是队列被 64 次 interrupt 填满。

### 6.8 v2：「爆炸半径限制在单会话内」— 本轮证伪

`ensure_started` 持进程级、按 agent 种类的 `STARTING` 锁跨第三方 CLI 首启（§1.2.2）。

### 6.9 v2：「四处解锁已完成」— 本轮更正

`Live::shutdown` 未改，且 edition 2021 的 `if let` 临时值使它仍持锁跨 `close().await`。
`kill_tree` 的 `child.wait()` 仍无期限。

### 6.10 v2：「洪水 case 证明了客户端修复的必要性」— 本轮更正

该 case 用协议客户端，直接读 snapshot status，不经过 store 与 composer。
它证明的是 daemon 侧终态会丢（这条成立），不能推出用户层的任何结论。
