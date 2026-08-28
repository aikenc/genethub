# GeneHub 大对象传输网络效率优化提案（neteff）

> 状态：测量基线、产品阶段 1–3 与阶段 3 后的限制收敛均已落地。前三阶段提交依次为：专项重构 `d573c897`、阶段 1
> `08551a5e`、阶段 2 `9329660d`、阶段 3 `8b48138b`。限制收敛后的真实产物回归
> `260828-1312-neteff-limit-policy-serial-c333` 使用真实 WASM daemon、真实 rendezvous relay，2/2 passed；
> 两条 case 分别为 7.9 秒和 8.3 秒。直连和 Relay 已达到同链路原始 TCP 利用率目标；后续重点转向
> 体验层和更宽网络矩阵。

## 1. 决策摘要

原始大图慢的核心问题不是 16 KiB 分片，也不是 TCP 必须等待 RTT；而是 GeneHub 在 TCP/WebSocket
之上增加了固定 256 KiB 的端到端应用层信用回路。发送方用完信用后，必须等待接收方消费分片、发送
`WindowUpdate`，信用跨越 RTT 返回后才能继续。Relay 路径还把外层信用回包从一条 TCP 腿串到另一条
腿，因此两条腿没有独立背压。

阶段 0 的同一条 100 Mbps 链路基线为：

- RTT 0 ms：GeneHub 使用原始 TCP 带宽的 91.8%；
- RTT 100 ms：只使用 21.4%；
- RTT 200 ms：只使用 12.6%；
- Relay 总 RTT 100 ms：无论延迟位于客户端腿、daemon 腿还是各一半，利用率都约 21%；
- Relay 两腿各 100 ms：利用率降至 14%。

这组数据证明：主要损失来自应用层信用反馈位于持续发送的关键路径。三阶段实施遵循同一个目标：

> 保留分片和公平调度，让 TCP 负责持续字节传输；应用协议只管理准入、异常慢消费者和本地有界队列，
> 正常大对象传输不依赖逐片或逐窗口的端到端信用回包。

已经落地的方案是在现有共享 TCP/WebSocket 连接上协商 transport-flow：继续按 16 KiB 分片并公平
轮转，但健康有限 Preview 不再依赖应用层逐窗回包；发送只服从本地 socket 写背压。Relay 两条 TCP
腿分别背压，只有新 client、daemon、relay 都支持时才启用，任一旧端自动回退旧信用模式。

最新阶段 3 实测已经验证因果：直连在 RTT 0/100/200 ms 下达到原始 TCP 的 94.4%/95.4%/96.0%；
Relay 在 0+0 到 100+100 ms 的五个组合下达到 92.2%–95.5%。RTT 已退出稳态吞吐关键路径，同时
Preview 在 daemon 侧只保留固定 256 KiB 读缓冲，client 侧只做一次精确最终分配，60 秒总寿命也已
改为“响应头期限 + 无进展期限”。

## 2. 专项指标与基线

### 2.1 核心指标

专项不再使用“达到 256 KiB/RTT 理论天花板的比例”作为核心指标。该指标只能证明实现是否忠实执行
现有常量，不能回答现有协议相对 TCP 浪费了多少链路能力。

新的核心指标为同链路原始 TCP 带宽利用率：

```text
bandwidth utilization = GeneHub 有效载荷吞吐 / 同 RTT、同带宽原始 TCP 有效载荷吞吐
```

目标：

- 直连：利用率不低于 85%；
- Relay：利用率不低于 80%；
- 在 0–200 ms RTT 范围内不出现随 RTT 增大而持续坍塌；
- 大对象传输期间，小 RPC/events 的交互延迟仍满足公平性目标；
- 慢消费者、恶意长度和多流并发下内存有硬上限。

阶段 0 曾只硬断言 10% 的数量级回归下限。阶段 1 已把直连 85% 提升为硬门禁；阶段 2 已把 Relay
80% 提升为硬门禁。报告首行始终直接输出同链路 TCP 利用率与用户等待时间，不再把“旧窗口达成率”
当成核心指标。

### 2.2 测试拓扑

专项使用业务无关的 TCP 字节流整形器，在 WebSocket framing 下方施加每方向 RTT/2 与固定 100 Mbps
带宽；同一个整形器分别承载真实产品路径和独立原始 TCP 对照：

```text
直连：
  Product Client ── shaped TCP/WebSocket ── real WASM daemon
  Raw TCP Client ── same shaped link ────── raw payload server

Relay：
  Product Client ── shaped client leg ── real relay ── shaped daemon leg ── real WASM daemon
  Raw TCP Client ── same two shaped legs ──────────────────────────────── raw payload server
```

每个点校验完整字节数与 SHA-256，并用代理逐腿字节计数证明流量真实经过目标路径。整形队列有 64 MiB
硬上限和高低水背压。专项代码位于：

- `testing/framework/drivers/network-link.ts`；
- `testing/specialties/connectivity/neteff-depth.specialty.ts`。

### 2.3 最新实测（阶段 3）

直连，8 MiB Preview，链路 100 Mbps：

| RTT | 原始 TCP | GeneHub | TCP 利用率 | TCP / GeneHub 耗时 |
| ---: | ---: | ---: | ---: | ---: |
| 0 ms | 11.87 MiB/s | 11.20 MiB/s | 94.4% | 0.674s / 0.714s |
| 100 ms | 10.32 MiB/s | 9.84 MiB/s | 95.4% | 0.776s / 0.813s |
| 200 ms | 9.14 MiB/s | 8.77 MiB/s | 96.0% | 0.876s / 0.912s |

Relay，4 MiB Preview，每条腿 100 Mbps：

| 客户端腿 RTT | daemon 腿 RTT | 原始双腿 TCP | GeneHub | TCP 利用率 | TCP / GeneHub 耗时 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 0 ms | 11.74 MiB/s | 10.82 MiB/s | 92.2% | 0.341s / 0.370s |
| 100 ms | 0 ms | 9.09 MiB/s | 8.58 MiB/s | 94.4% | 0.440s / 0.466s |
| 50 ms | 50 ms | 9.07 MiB/s | 8.57 MiB/s | 94.4% | 0.441s / 0.467s |
| 0 ms | 100 ms | 9.09 MiB/s | 8.55 MiB/s | 94.0% | 0.440s / 0.468s |
| 100 ms | 100 ms | 7.40 MiB/s | 7.07 MiB/s | 95.5% | 0.541s / 0.566s |

结论：

1. RTT 0→200 ms 时利用率没有下降，证明应用层回包已退出有限 Preview 的稳态发送时钟；
2. 相同总 RTT 放在 Relay 任意一条腿，利用率仍稳定在约 94%，证明两条 TCP 腿已经解耦；
3. 100+100 ms Relay 的利用率反而为 95.5%，不再出现旧实现 14% 的 RTT 坍塌；
4. 大 Preview 在途时，直连和 Relay 的并发小 RPC 分别为 204 ms 与 228 ms，16 KiB 分片公平性保留；
5. 32 MiB@200 ms 的旧实测约 27 秒。按阶段 3 的 8.77 MiB/s 推算约 3.6 秒，数量级改善约 7.5 倍。

## 3. 优化前机制与核心矛盾

### 3.1 分片与流控是正交机制

16 KiB 分片解决调度粒度：大 Preview 可以与 RPC/events 的小帧交替进入 socket，而不是让一个巨大
WebSocket record 长时间独占 writer。合理的发送顺序是：

```text
preview A1 → RPC B1 → event C1 → preview A2 → preview A3 → ...
```

这里不需要等待任何应用层 RTT。调度器可以持续轮转，直到本地 TCP/WebSocket 写缓冲出现背压。

优化前实现额外规定每流初始信用 256 KiB，每帧最大约 16 KiB，因此发送约 16 帧后可能耗尽信用。接收方
消费分片时返回等量 `WindowUpdate`，发送方累计信用不得超过 256 KiB。于是：

```text
分片：决定每次让出调度器的粒度                    —— 不需要 RTT
公平轮转：决定下一帧属于哪条逻辑流                —— 不需要 RTT
TCP 写背压：决定本地还能否继续向 socket 写         —— TCP 自己处理
应用层 256 KiB 信用：决定是否必须等远端消费回包     —— 当前吞吐损失来源
```

旧协议把“分片保证公平”和“端到端信用保证内存”绑在了一起。阶段 1/2 已将二者拆开：分片和公平
writer 保留，有限 Preview 的新链路改由本地 TCP/WebSocket drain 驱动。

### 3.2 256 KiB 信用没有保护 Preview 的主体内存

应用内存真正可能持续增长的条件是：某条逻辑流的消费者停止读取，但 endpoint 为了继续处理同连接上的
其他流，仍从 TCP 读取并把该流数据放进应用队列。PTY、events 等未知长度流确实可能出现这种情况。

优化前 Preview 不是这种消费者：

- daemon 的 `asset.preview` 先取得完整 `PreviewFile.bytes`，再调用 `stream.write(&file.bytes)`；
- client 的 `preview()` 通过 `collectBody()` 收集完整 body 后才返回；
- 文件已有 64 MiB 大小上限；
- 正常 Preview 消费者始终主动读取，不存在长时间停读。

因此 256 KiB 只限制了传输层内部在途/排队数据，没有阻止两端最终持有完整文件。阶段 3 已改成：

- daemon 第一遍用固定 256 KiB 缓冲扫描长度、类型和 SHA，不保留 payload；
- 同一个 capability 文件句柄 rewind 后分块发送，第二遍再次核验长度与 SHA；
- 8 个 Preview worker permit 覆盖扫描和实际发送全过程；
- client 按可信 `bodyLength` 一次分配最终 `Uint8Array`，逐块写入，不再保留全部 chunks 后再复制；
- 64 MiB 方法上限、精确长度检查和 source-changed 防护全部保留。

这才是直接约束实际内存的预算，不需要让健康传输每 256 KiB 等一次远端回包。

### 3.3 优化前 Relay 没有逐腿解耦

优化前 Relay 核算外层 Fabric 信用，但收到 `WindowUpdate` 后仍把它转发给对端。客户端到 Relay、Relay
到 daemon 是两条独立 TCP 连接，却被应用信用重新串成一个端到端反馈环：

```text
client 发送 → relay 转发 → daemon/handler 消费
client 获得新信用 ← relay 转发 WindowUpdate ← daemon 返回信用
```

阶段 0 中 100+0、50+50、0+100 ms 三点都只有约 21%，正是这个机制的直接证据。阶段 2 将新模式
改为每条腿等待各自 `ws.send`/socket drain，并在转发期间暂停该来源 socket；阶段 3 同三点已提高到
94.0%–94.4%。

## 4. 设计目标与边界

### 4.1 必须满足

1. 正常有限大对象传输不依赖逐片或固定小窗口的端到端信用回包；
2. 继续使用 16 KiB 左右的公平调度 quantum，小 RPC/events 不被大对象 writer 队列饿死；
3. 直连与 Relay 都由各自 TCP 腿承担拥塞控制和接收窗口；
4. Relay 只处理流 ID、密文和本地有界队列，不破坏 E2EE；
5. 慢消费者、错误 body length、多流并发和恶意 peer 下内存仍然有界；
6. 新旧 client/daemon/relay 混跑时明确协商并安全回退，不能单方面改变信用语义导致 reset；
7. 总时长超时改为进度/停滞超时，稳定但较慢的传输不能在第 60 秒被无条件杀死；
8. 所有效果由同链路 TCP 利用率专项验收，而不是以新的理论常量自证。

### 4.2 非目标

- 不能消灭请求到首字节的物理 RTT；目标是让 RTT 退出稳态吞吐关键路径；
- 本提案不以缩略图掩盖网络效率问题；缩略图、渐进显示和缓存是并行体验优化；
- 本提案不承诺消除 TCP 丢包造成的跨流队头阻塞；如该问题成为主因，再评估 QUIC/WebTransport；
- 当前 100 Mbps 下不优先优化 AES/record CPU，因为 RTT 0 已达到 TCP 的 94.4%。

## 5. 已落地架构：共享连接上的 transport-flow bulk

### 5.1 发送路径

现有 TCP-backed WebSocket、record framing、E2EE 和每流公平轮转全部保留。有限 Preview 的新模式
分两层落地：

1. data plane 在认证后的 peer 能力握手中为 `asset.preview` 协商 initial bulk lease；新 client 在
   `PeerHello` 声明 64 MiB 能力，新 daemon 返回双方共同上限，因此新/新组合一次授予完整合法文件；
   首批 bulk 旧 client 没有 Hello 声明，仍获得 8 MiB，更老 daemon 缺少 Welcome 字段时回退 256 KiB；
2. Fabric endpoint URL 声明 `flow=transport-v1`，只有 Relay 看到两端都声明能力时，才用
   `Incoming.value=0` / `Accept.value=0` 激活 transport-flow。

激活后，有限 bulk 的稳态发送模型为：

```text
while socket writable:
  从 active streams 轮转选择一条流
  最多发送一个 scheduling quantum（例如 16 KiB）
  若 socket 本地排队达到高水位，等待本地 drain/bufferedAmount 下降
```

Fabric transport-flow 不维护逐字节 `outboundCredit`，不发送逐片 `WindowUpdate`。是否继续写只取决于：

- 文件剩余字节；
- 本地公平调度；
- 本地 socket 写缓冲；
- 连接关闭或取消。

浏览器 endpoint 在写前观察本地 `bufferedAmount`；Relay 等待目标 `ws.send` callback，并在目标腿尚未
drain 时暂停来源 socket；daemon 由有界 mpsc/socket writer 施加本地背压。这些限制只影响本地入队，
socket 一可写就继续，不新增网络 RTT。

### 5.2 接收路径

有限 `bulk` 流的已实现接收边界为：

- response head 提供精确 `bodyLength`；
- client 在接受前验证不超过方法上限（Preview 当前为 64 MiB）；
- 实际字节必须与 `bodyLength` 和元数据一致；
- client 只分配一次精确长度的最终 buffer，并逐块写入；
- consumer 取消时发送 terminal reset，不再继续缓存。

当前 Preview consumer 是内部立即读取、长度有限的 collector。兼容 frame 仍可能返回
`WINDOW_UPDATE`，但新/新组合的初始许可已经覆盖完整 64 MiB 方法上限，发送方即使收不到这些回包也
能发送完整个合法文件，因此回包不在健康路径的进度条件中。
通用的外部慢 sink、PTY 和 events 仍保留旧信用语义；粗粒度 `PAUSE/RESUME` 尚未实施，列入未知长度
流的后续方案，不能反过来阻塞已经有精确长度的 finite bulk。

### 5.3 流类型

建议按语义区分，而不是用同一 256 KiB 算法处理所有交换：

| 类型 | 例子 | 流控策略 |
| --- | --- | --- |
| finite bulk | Preview、文件下载、有限 artifact | 精确 body length；TCP 背压；正常路径无应用信用 |
| bounded RPC | 小请求/响应 | 大小上限；公平调度；通常一次写完 |
| unbounded streaming | PTY、events、实时媒体控制 | 本地有界循环队列；必要时 PAUSE/RESUME 或 coarse lease |

如果希望保留一个通用 credit 机制，未知长度流可改用单调递增的绝对接收上限（类似
`MAX_STREAM_DATA`），并在高水位之前批量扩大上限；不能继续逐片返还等量 delta。该机制是 streaming
的安全工具，不应成为 finite bulk 的必经路径。

## 6. Relay：已实现两条 TCP 腿独立背压

阶段 2 的 Relay 路径为：

```text
client TCP/WebSocket
        ↓ 独立 socket 背压
relay 每流有界密文队列 + 公平调度
        ↓ 独立 socket 背压
daemon TCP/WebSocket
```

实现要点：

1. transport-flow DATA 不产生也不转发外层 `WindowUpdate`；
2. Relay 的 `sendFlow` 等待目标 WebSocket 的真实 send callback，并继续受 process/socket byte budget 约束；
3. send 未完成时暂停来源 socket，完成后恢复，让该腿的 TCP 接收窗口自然施加背压；
4. daemon Fabric carrier 队列由 `try_send` 改为有界 `send().await`，队列满是背压而不是协议违规；
5. 多条 Fabric 流继续使用既有公平调度和连接级总队列上限；
6. Relay 只看到现有外层 frame/stream ID 和密文 payload，不解密数据面。

当前 `ws` API 的 pause 是物理 socket 粒度，因此极端慢下游仍可能短暂影响同一物理 endpoint 上其他
逻辑流；现有每帧发送 callback 与公平 writer 将这个范围限制在一个 frame/drain 周期。真实专项中
100+100 ms 大 Preview 在途时小 RPC 为 228 ms。若未来引入外部慢 sink，应增加按流 coarse pause，
而不是恢复端到端逐窗许可。

## 7. 可选架构：独立大对象数据通道

如果共享连接改造仍难以同时满足公平、内存和实现复杂度，可以把 bulk 数据从控制连接中拆出：

```text
控制连接：preview 请求 → 短期单次 transfer ticket、长度、hash、路由信息
数据连接：client ⇄ daemon 直接 TCP-backed WebSocket/HTTP stream
          直连不可达时，由 relay 做两条 TCP 的密文字节 splice
```

优点：

- 可以完全删除该数据通道上的自定义信用协议，直接使用 TCP 自动窗口；
- 天然支持 Range、断点续传、独立取消和后续缓存；
- 大对象不会预填控制连接的 socket 队列。

代价：

- 增加连接建立、ticket 生命周期、路由和重连状态；
- 浏览器不能使用裸 TCP，需要 WebSocket、Fetch/HTTP 或 WebTransport 载体；
- 必须复用现有认证/E2EE 会话，不能把文件暴露成无保护 URL；
- Relay 并发连接数与资源模型需要重算。

现有共享连接的 transport-flow 已达到 92%–96% TCP 利用率，因此当前没有为吞吐另建连接的必要。
独立数据通道只在 Range、断点续传、缓存或 TCP 跨流 HOL 出现明确需求时重新评估。

## 8. 内存与公平性设计

### 8.1 何时真的需要限制

需要保护的实际场景：

- 未知长度流的 consumer 停止读取；
- peer 声明长度后发送超量数据；
- 多个大 Preview 并发，最终对象总量超过设备预算；
- Relay 下游长期慢于上游；
- sender 提前向本地 socket 排入过多 bulk 字节，造成小帧排队。

### 8.2 建议的保护层

| 层 | 建议保护 | 是否依赖网络 RTT |
| --- | --- | --- |
| 方法 | body length 上限、精确长度、并发 Preview slot | 否 |
| sender | 每流 scheduling quantum、socket 本地高水位 | 否 |
| receiver | 流式 sink、每流异常队列上限、连接级总队列上限 | 否 |
| Relay | 每流/连接密文队列上限、公平调度、socket drain | 否 |
| 异常慢流 | PAUSE/RESUME、超限 reset | 只在异常状态支付 |

预算应约束“实际已排队/已保留的内存”，不能再用一个固定小在途窗口代替所有资源管理。对于 Preview，
应优先减少完整文件的重复拷贝和并发对象总量。

### 8.3 当前限制的最终归类

| 限制 | 当前值/语义 | 处理结论 | 原因 |
| --- | --- | --- | --- |
| Preview 应用层授信 | 新/新 64 MiB；旧 bulk client 8 MiB；更老 peer 256 KiB | 已大幅放宽并完成双向协商 | 授信不分配内存；完整合法文件不再依赖信用 RTT |
| Fabric outer credit | transport-flow 下关闭；旧端 256 KiB fallback | 新路径移出关键路径 | 两条 TCP 腿分别提供拥塞控制与接收窗口 |
| Preview 文件大小 | 64 MiB | 保留 | Viewer 仍持有一个完整最终 buffer/Blob，尚无 Range 或渐进解码 |
| Preview worker | daemon 全局 8 个 | 保留 | 限制文件句柄、两遍磁盘读取与 WASM 加密并发 |
| active logical streams | 每 peer 256 | 保留 | 限制 task、队列和 stream 状态；远高于正常 UI 需求 |
| record 大小 | 完整 record 16 KiB | 保留 | E2EE record、防大帧独占与公平调度；不再造成逐片 RTT |
| client 超时 | response head 60 秒；连续无 chunk/FIN 60 秒 | 保留为停滞检测 | 稳定传输可无限续期，不再是 60 秒总寿命 |
| Relay socket 排队 | 单 socket 8 MiB、进程 64 MiB | 保留 | 约束真实 Node heap；不限制健康链路每 RTT 可发送量 |

因此“降低限制”不是把所有数字调大：RTT 相关的传输许可已经放宽到完整方法范围；留下的数字都必须能
对应一项实际持有的内存、文件句柄、task 或故障检测。继续提高 64 MiB 文件上限之前，必须先让 Viewer
支持 Range/渐进渲染或流式 sink，否则只是把浏览器单对象内存风险同比放大。

## 9. 协议协商与兼容（已落地部分）

不能单方面删除信用：旧 client、daemon 和 relay 都会校验信用上限，单侧变化会触发 protocol reset。
已落地的兼容策略为：

- 新 client 在 `PeerHello` 声明最大有限 Preview 授信，新 daemon 返回双方共同上限；新/新为完整
  64 MiB，首批 bulk 旧 client 无声明时为 8 MiB，更老 daemon 缺少 Welcome 字段时回退 256 KiB；
- daemon uplink 与 browser dial 在 Fabric URL 附加 `flow=transport-v1`；
- Relay 只有在同一 binding 两端都声明该 capability 时才发送零值 `Incoming/Accept` 信号；
- 新 endpoint 只在自己主动声明能力时接受零值信号，否则按协议违规失败；
- 旧 Relay 忽略额外 query，继续使用原有非零 credit，因此不会误启用新语义。

后续未知长度流可能需要的能力仍包括：

- `streamPauseResume`：支持异常慢消费者的暂停/恢复；
- `absoluteStreamLimit`：未知长度流支持绝对接收上限。

阶段 1 的 8 MiB lease 是兼容且有界的最小直连实验；阶段 2 的 Fabric transport-flow 让 Relay 外层
彻底退出逐窗 RTT 回路；阶段 3 流式 source/sink 后，新 peer 才具备把 Preview 授信提升到完整 64 MiB
方法范围的资源前提。该许可只适用于长度已知且有硬上限的 Preview，不能泛化为未知长度流。

## 10. 正确性前置修复（已完成）

### 10.1 daemon Fabric 队列满时 reset（阶段 1）

首版专项发现：真实 Relay + WASM daemon 下，回环速度 Preview ≥4 MiB 会让 daemon Fabric carrier
入站队列耗尽，并以 `ProtocolViolation(6)` reset。现场序列号连续、队列容量为 0，排除了乱序。

根因是部分路径使用 `try_send`，队列满被当成协议违规。阶段 1 已改为：

- 队列满表示本地暂时消费不过来，等待有界队列容量；
- 只有 peer 超过已声明长度、帧格式或安全上限时才 reset；
- carrier reader 不再因为正常突发主动制造 `ProtocolViolation`；
- 浏览器同步 `ArrayBuffer` 突发不再误计入只为异步 Blob 解码设置的 64-frame 队列。

真实 Relay RTT 0、4 MiB 点现在稳定通过（阶段 3 为 0.370 s、TCP 利用率 92.2%）。

### 10.2 Preview 总时长超时（阶段 3）

旧 client 以固定 60 秒包住完整 Preview 操作。稳定持续传输的大文件会在第 60 秒被杀死，即使连接从未
停滞。现在已拆分为：

- 排队/首响应超时；
- N 秒无进度的 stall timeout；
- 不再设置 60 秒总时长死线；如果未来增加产品级最长任务上限，不能与网络停滞混为一谈。

可控时钟单测已证明：每 600 ms 有进展的 1.8 s 传输不会被 1 s stall deadline 杀死；连续 1 s 无进展
则会 reset。该测试按比例证明 60 秒生产语义，无需让快速门禁真实等待一分钟。

## 11. 实施路线

### 阶段 0：测量基线（已完成）

- 同链路原始 TCP 对照；
- 直连 RTT 0/100/200 ms；
- Relay 双腿 100+0、50+50、0+100、100+100 ms；
- 真实 WASM daemon、真实 relay、完整 SHA-256；
- 提交 `d573c897`。

### 阶段 1：正确性与最小直连实验（已完成）

- 提交：`08551a5e`（`feat(transport): 在建流时授信有限预览`）；
- run：`260828-1103-neteff-phase1-7b9a`，2/2 passed；
- 修复 daemon Carrier 队列满即 reset；
- 认证握手为有限 Preview 协商 8 MiB bulk lease，旧 peer 回退；
- 保留 16 KiB framing 和公平 writer，浏览器 writer 尊重本地 WebSocket drain；
- 直连 RTT 0/100/200 ms 利用率为 90.4%/93.1%/94.9%，8 MiB@200 ms 为 0.922 s；
- 大 Preview 在途时小 RPC 为 203 ms。

这一阶段只改变直连信用关键路径，没有引入并行分片、缩略图或加密优化，因而证明“无需等待应用层
RTT 回包”本身就是主要杠杆。

### 阶段 2：Relay 逐腿解耦（已完成）

- 提交：`9329660d`（`feat(fabric): 让 Relay 双腿使用 TCP 背压`）；
- run：`260828-1138-neteff-phase2-v2-b573`，2/2 passed；
- Relay 外层改为目标 `ws.send` drain + 来源 socket pause/resume；
- daemon uplink 与 browser dial 使用 `flow=transport-v1`，双端 capability 才启用；
- 修复同步 `ArrayBuffer` 突发被误判为异步 Blob 队列溢出；
- Relay RTT 0+0 至 100+100 ms 的利用率为 91.8%–94.7%；
- 100+100 ms 大 Preview 在途时小 RPC 为 230 ms。

### 阶段 3：流式 source/sink 与超时（已完成）

- 提交：`8b48138b`（`perf(preview): 流式处理有限资源与进度超时`）；
- run：`260828-1151-neteff-phase3-2250`，2/2 passed；
- daemon 用固定 256 KiB 扫描缓冲 + 同一 capability 文件句柄流式发送，第二遍复核 SHA；
- client 按精确 `bodyLength` 一次分配并逐块写入，消除 chunks 总量 + 最终 buffer 的双份峰值；
- 60 秒总时长改为响应头/无进展期限；
- Workbench 全量单测 630 passed，Preview 边界测试 4/4 passed；
- daemon 全包 567 项执行到 566 passed；唯一失败是未改动 `router.rs` 的既有中文文案断言，未混入本阶段；
- 阶段 1/2 性能未回退：直连 94.4%–96.0%，Relay 92.2%–95.5%。

### 阶段 3 后续：限制收敛（已完成）

- 新 client 在 `PeerHello` 主动声明自己可接受的有限 Preview 授信，新 daemon 只返回双方共同上限；
- 新/新组合把 initial lease 从 8 MiB 提升到完整 64 MiB 方法上限，任何合法单文件都不以信用回包为
  继续发送的必要条件；
- 旧 client 没有 Hello 能力字段时仍得到 8 MiB，新 client 连接旧 daemon 仍接受 8 MiB 或 256 KiB，
  不提升 data-plane version，不让混合版本互相 reset；
- 64 MiB 文件上限、8 个 Preview worker、256 active streams、16 KiB record、Relay 真实排队预算和
  60 秒停滞检测全部保留，并在产品文档中逐项写明保护对象。
- 真实产物回归 `260828-1312-neteff-limit-policy-serial-c333` 在串行性能槽中 2/2 passed。一次将两条
  RTT=0 基准并发执行的探针因共享宿主 CPU 竞争降至 69.6%–73.6%，因此失败结果没有被调低阈值掩盖；
  性能门禁必须隔离 CPU 基准，不能把同机并发噪声误判为传输协议回退。

### 阶段 4：体验与大对象能力

- Range、断点续传和缓存；
- 缩略图/渐进首屏；
- 评估独立 bulk 数据通道；
- 若 TCP 丢包跨流 HOL 成为新主因，再评估 QUIC/WebTransport。

## 12. 验收计划

### 12.1 性能门禁

阶段 1/2 已将报告目标提升为硬断言：

- `specialty.neteff.preview-direct-bandwidth-utilization`：各 RTT ≥85%；
- `specialty.neteff.preview-relay-leg-utilization`：各腿组合 ≥80%；
- 重复 run 漂移使用百分点阈值，而不是绝对毫秒死线；
- TCP 对照必须落入整形链路模型范围，产品/对照均校验实际逐腿字节与 SHA-256。

当前快速矩阵已经覆盖 100 Mbps、直连 0/100/200 ms 与 Relay 五种双腿组合。建议深层矩阵扩展到：

- 带宽 10/100/500 Mbps；
- RTT 0/50/100/200/400 ms；
- 大小至少覆盖 `2 × BDP`，避免短文件只有起步延迟；
- 可选 jitter/loss 深层专项，不混入快速 merge 基线。

### 12.2 公平与内存门禁

1. 大 Preview 持续发送时，独立小 RPC 的 p95 延迟相对无负载对照不超过约 2 倍，并设绝对上限；
2. sender socket 排队、receiver 每流队列、Relay 每流/连接队列均继续保留硬上限；后续补充诊断峰值；
3. 模拟 consumer 停读，只暂停/取消该流，其他流继续；
4. 多个 64 MiB 声明不能绕过 8 个 Preview worker 与连接总量；
5. 新旧 endpoint 组合按 capability 安全回退；
6. 队列满是背压或明确 `TooSlow`，不能误报 `ProtocolViolation`；
7. 每个 case 使用真实服务器、真实产品 client、真实 relay，保持 TypeScript 编排。

## 13. 方案比较

| 方案 | 对核心利用率 | 状态 | 主要问题/下一步 | 建议 |
| --- | --- | --- | --- | --- |
| finite bulk 使用 TCP/socket 背压 | 直接消除正常路径信用 RTT | 阶段 1/2 已完成 | 外部慢 sink 尚需 coarse pause | 保持为主路径 |
| Relay 逐腿背压 | 消除两腿端到端信用 | 阶段 2 已完成 | socket 级 pause 粒度可继续细化 | 保持硬门禁 |
| 完整方法范围的协商 lease | 有限 Preview 完全退出信用 RTT | 已完成 | 仅限长度已知且 ≤64 MiB；旧 client 回退 8 MiB | 保持为当前路径 |
| 流式 source + 定长 sink | 降低两端内存/复制 | 阶段 3 已完成 | daemon 为版本 hash 做两遍顺序读 | 继续观测 I/O |
| 绝对 offset + 提前续授 | 通用 streaming 流控 | 未实施 | 状态机和兼容复杂 | 用于未知长度流 |
| 独立 bulk 数据通道 | 最接近原生 TCP，支持 Range | 未实施 | ticket、连接、路由、重连 | Range 需求出现后评估 |
| 多流并行分片 | 用 N 个窗口绕过限制 | 不需要 | 控制帧、内存、调度都乘 N | 不作核心方案 |
| 单纯增大 record | 降低 per-record CPU | 未实施 | 当前不再受信用 RTT 限制 | 高带宽再评估 |
| AES/WASM 优化 | 提高高带宽 CPU 上限 | 未实施 | 100 Mbps 下不是主因 | 500 Mbps 矩阵后决定 |
| 缩略图/缓存 | 显著改善感知等待 | 未实施 | 不改变链路利用率 | 下一优先体验方案 |
| QUIC/WebTransport | 原生多流、无 TCP 跨流 HOL | 未实施 | 全栈迁移 | 有丢包 HOL 证据后评估 |

## 14. 已实现收益

阶段 0 与阶段 3 同链路数据对比：

| 场景 | 阶段 0 | 阶段 3 | 改善 |
| --- | ---: | ---: | ---: |
| 8 MiB，直连 RTT 100 ms | 3.63s | 0.813s（95.4% TCP） | 4.5× |
| 8 MiB，直连 RTT 200 ms | 6.95s | 0.912s（96.0% TCP） | 7.6× |
| 32 MiB，100 Mbps、RTT 200 ms | 约 27s | 按实测吞吐约 3.6s | 约 7.5× |
| 4 MiB，Relay 100+100 ms | 3.89s | 0.566s（95.5% TCP） | 6.9× |

优化后仍保留约一个请求/首字节 RTT，以及物理链路带宽和 TCP 慢启动影响；这些都已经包含在同链路
TCP 对照中。专项目标不是让远程绝对耗时等于 loopback，而是让 GeneHub 在同样网络条件下接近 TCP
应有的效率。

## 15. 最终建议

1. 核心门禁固定为同链路 TCP 带宽利用率：直连 ≥85%、Relay ≥80%，不得退回“旧窗口达成率”；
2. 保持阶段 1–3 及限制收敛后的架构：分片负责公平，TCP 负责健康有限流的持续传输，应用层只管理准入和实际资源；
3. 将 `neteff` 快速矩阵纳入涉及 data plane/Fabric/Relay/Preview 改动的 merge gate；
4. 下一轮网络专项扩展 10/500 Mbps、400 ms、jitter/loss，确认瓶颈是否迁移到 WASM AES 或 TCP HOL；
5. 下一产品优先级建议是缩略图 + 缓存：链路效率已经接近 TCP，体验优化应减少首屏必须传输的字节；
6. Range/断点续传出现明确需求时，再评估独立 bulk 数据通道，不用多流并行绕过已经解决的窗口问题；
7. PTY/events/外部慢 sink 保留独立课题：使用 coarse PAUSE/RESUME 或绝对接收上限，不能让异常路径重新
   成为 finite Preview 的每窗 RTT 时钟；
8. daemon 两遍顺序读是精确版本 hash 与低内存的明确取舍；若磁盘 I/O 成为新瓶颈，可在协议中增加
   trailer/version 校验或可信文件快照，而不是恢复完整 `Vec`。

三阶段已经把职责重新分清：**分片负责公平，TCP 负责传输，应用层负责准入与实际资源上限。** 正常
有限大对象不再因为每 256 KiB 的应用信用回包支付一次 RTT；真实 WASM/Relay 数据已证明它能在
0–200 ms 矩阵中稳定使用同链路 TCP 的 92%–96%。
