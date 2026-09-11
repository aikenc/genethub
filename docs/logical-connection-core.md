# 逻辑连接：续接核心候选

2026-09-10，dev-net。关联 [v1 总体设计](logical-connection-v1-plan.md)。

当前候选已将日志接入 TS DataEndpoint、Rust daemon 与原生 ClientEndpoint。数据面握手、AEAD
record 和 RTC channel label 为 v4；业务 WebProtocol 仍为 v3。浏览器重拨完成新通道认证后，
通过 daemon registry 接回同一个流表、订阅和 handler；不会在恢复成功后重新调用业务或重新订阅。
邀请 bootstrap 不进入 registry，继续使用同一个流引擎的不可恢复物理生命周期。

真实 WASM / 公共 Client 故障测试已在 shell 运行期间 terminate WebSocket，验证原 DataStream
完整返回、进程只启动一次，且恢复后可继续 RPC。普通 RTC 与 baseline 已共用同一个逻辑端点，真实 Chromium
已验证准备期、Relay 暂停期间的事件和 RTC 关闭后的原连接恢复。受限服务使用独立 direct-only 连接。

## 已落入代码的边界

- 一个 Journal 保有发送序号、未确认日志、接收位置和消费租约；切换不重新创建 Journal。
- 逻辑接纳同步串行。`enqueue` 成功才占用序号并取得数据所有权；超限不留序号空洞。
- `next` / `next_record` 标记一次发送尝试，再交给 writer。失败只暂停，不撤回序号。
- 每次重放以当前 epoch 编码；随后由新 AuthenticatedChannel 重新加密。日志不保存旧密文。
- `receive` 返回新交付一次，重复帧和旧 epoch 不返回交付；缺口、未来 epoch、畸形控制拒绝。
- 返回 frame 不归还预算。stream 消费或明确丢弃后调用一次 `release(seq)`；重复释放拒绝。
- ACK 只释放发送日志；BUDGET 只增加首次入日志许可。旧 ACK/BUDGET 无效，虚高值拒绝。
- `activate` 是认证、裁决、SYNC 已完成后的本地提交，不是网络 ATTACH API。验证失败不替换活动 epoch。
- 第一次暂停建立期限；重复暂停、拒绝的路径/状态恢复不延期；恢复边界到期即清空日志与租约。
- 主动关闭幂等且不可重新激活。调用方只能把 ProtocolViolation/StateLost 等映射为明确终态，不能自动重发业务。

## 传输限制按连接隔离

原设计把 `carrier_kind` 当作诊断字段是不充分的。`dataplane/service_preview.rs` 用它执行
`direct-only` 的安全策略。修订为每条逻辑连接有不可放宽的 policy：

- `relay-allowed`：允许已认证的 RTC、Fabric 和本机通道。
- `direct-only`：只允许已认证 RTC 或确认是本机的 loopback，Fabric 激活必须失败。

Service Preview 的连接提供者在业务打开流之前根据 daemon 认可的服务 policy 选择对应连接池。
普通业务只拿注入的逻辑连接，不传 `transport`；受限服务使用单独的逻辑连接，不能与普通连接共用日志。
恢复凭证必须绑定 policy，双方独立执行，客户端不能自报 loopback 来提高权限。

RTC 故障时，受限连接等待合规通道或到期；普通连接仍可回退 Fabric。不把受限流放进统一日志后再
尝试跳过序号，这会使累计确认无法成立。此处允许一个标签页按安全策略拥有多条逻辑连接；不增加同一
逻辑连接多活动通道，不引入业务 method 选路。连接发现/初始 RTC admission 仍须阶段 3 集成验证。

## 已接入的 v4 字节合同

所有整数为大端，无 JSON number 搬运 u64。Rust 定义为源，TS 实现必须通过
`packages/proto/fixtures/resume-payload.json` 与 `resume-control.json`。

通用头：offset 0 为世代 `4`；offset 1 为 opcode；offset 2..3 必须为零；offset 4..11 为
非零 epoch；offset 12..19 为一个 u64。opcode 分配如下：

| opcode | offset 12 的值 | 后续 | 总长 |
| --- | --- | --- | --- |
| 1 PAYLOAD | 非零 logicalSeq | 下述流头与 payload | 36 + payload |
| 2 ACK | receivedThrough，可为零 | 无 | 20 |
| 3 BUDGET | dataGrant | offset 20..27 为 progressGrant | 28 |

PAYLOAD 的 offset 20 是 frame kind：OPEN=1、HEAD=2、DATA=3、WINDOW_UPDATE=4、FIN=5、RESET=6。
offset 21..23 必须为零；offset 24..27 为非零 streamId；offset 28..31 为原 frame value；
offset 32..35 为 payload 长度。保留现有 DataFrame 语义，不嵌入 v3 frame header。

完整 record 16,384 字节，AEAD 外壳 28 字节，因此最大 DATA 是 **16,320 字节**。OPEN/HEAD
不超过 8,192 字节。进展类 WINDOW_UPDATE/FIN/RESET 必须为空 payload，具体 value 和 stream
状态合法性仍由流状态机检查。长度、枚举、reserved、u64 和总长在有界解码时检查。

其余连接控制使用下文定义的 opcode 16 有界 JSON。dev-net 数据面为 v4；WebProtocol 仍为 v3。

## 两种 PAYLOAD 预算

原方案只有 ACK/BUDGET 的独立控制队列，无法证明 RESET/WINDOW_UPDATE 在数据占满时取得发送资源。
修订为两个 PAYLOAD 预算桶，**共享同一有序 logicalSeq**：

1. data：OPEN、HEAD、DATA；初始建议 4 MiB。
2. progress：WINDOW_UPDATE、FIN、RESET；初始建议 64 KiB，DATA 不可借用。

每桶独立保有发送日志空间、接收容量 C、累计首次入日志 charged、累计消费释放 F。
公布 `grant=C+F`；只有 `charged+完整PAYLOAD编码长度<=grant` 才能接纳新帧。重放不再收费。
日志空间还必须同时足够。ACK 可以合并且不计入这两个桶；BUDGET 丢失可重复通告，旧额度不回退。

已授信数据可由 reader 同步接纳到受配额约束的 stream 状态，无需等待消费，因而后续进展帧可按序解析。
进展帧必须由 actor 立即处理并释放租约，不等业务迭代器。进展额度本身也有界，用尽时背压；
不能让它在新的 DATA 后无限排队。首次分配序号前公平挑流，已经编号的重放不能重排。

每个接收租约一直计费到消费/丢弃，不能把“已移入 stream.chunks”当作释放。OPEN/HEAD 解析产生的
长期 handler/head 状态必须先获得独立配额，之后才能释放它们的编码租约。RESET 清理需释放该流
剩余租约，且不能回收其他流或销毁整个连接。

该核心约束的是编码字节与由最小 36 字节帧推导出的有限条目数，不是浏览器实际 heap 的测量。
双方向日志/接收、Map/Vec、等待写入、handler、carrier、加密副本必须在 actor/registry 准入时统一
核算。160 MiB 不能被描述成已经验证的进程内存上限；32 连接是数量上限，不保证都能协商 4 MiB。

当前连接 data 容量为 4 MiB，progress 为 64 KiB，单流窗口统一为 3 MiB。撤销了 Preview 的
64 MiB 特例。相对原提案的 256 KiB / 1⁄16，3 MiB 是根据真实 100 Mbps、100/200 ms RTT
验收作出的调整：小窗口使中继吞吐只有同链路 TCP 的约 22%；3 MiB 版本通过原有直连/中继
吞吐门槛与传输期间的小 RPC 延迟门槛。单个慢流仍不能占满 4 MiB data 桶，progress 独立。
多个慢流耗尽剩余 data 时允许明确背压；不承诺无限慢消费者仍有无限吞吐。

发送调度每条流最多一个在途接纳，跨流可独立推进。TS 在 await 前取得调用方 buffer 的副本，
串行同一流的 write/finish，限制连接待写 4 MiB / 256 次、单流待写 3 MiB，并限制 body 为单消费者。
Rust 接收 DATA 的 lease 随队列项持有，消费或丢弃才归还；原生 streaming client 同样在 next_chunk
时归还。FIN/RESET 的发送完成等待 ACK（包含已验证激活水位），handler 超时包含断线时间，RESET 会中止对应 handler。
已结束的 handler 从 JoinSet 及时回收；fanout 失去位置会显式终止连接，避免静默停更。

## 单线程事务与错误处理要求

- 所有读写、激活、回收由逻辑连接 actor 串行化；core 不调用异步 handler，也不持锁 await。
- 只有经过新通道认证与 registry scope/policy/撤权校验的路径才能调用 activate。
- 原始 ACK/BUDGET 必须通过 receiveControl/receive_control 检查 epoch；直接 acknowledge/update_grants
  仅供已经认证且绑定同一 epoch 的 SYNC/actor 内部事务。
- 同 incarnation 的 receiver 位置小于已释放日志边界、恢复 grant 回退均为 StateLost；不猜测对端重启。
- owner 用单调时钟调用 tick，事件循环恢复后先检查期限；计数器或时钟溢出错误必须终止连接。
- `next` 返回的旧 epoch 字节不得被 writer 再发到新路径。新路径只发送重新编码且重新加密的记录。
- ready 仅在双方 SYNC 已完成、重放可以推进时公布；认证成功或调用 activate 本身不构成网络续接证据。

## Registry 与恢复认证

CREATE / CREATED / ATTACH / ATTACHED / ACTIVATE / ACTIVATED / SYNC / SYNCED / PING / PONG /
CLOSE / ERROR 使用加密的 `[4,16,0,0] + UTF-8 JSON`，总长最多 8 KiB，u64 为规范十进制字符串。
未知字段、阶段错序和非法计数拒绝。恢复证明使用独立 HMAC 域，绑定逻辑 ID、daemon incarnation、
从原通道双 nonce transcript 单独派生的 binding，以及新的 activation attempt。

registry 比较新通道的原认证主体、device 与 workspace id / handle；RTC 继承发起协商的认证主体，
不把临时 RTC capability 当成新用户。Hub redemption 返回当前 source session / node 的稳定主体，
同时复核 source 仍有效；旧 Hub 没有该字段时仍按 capability 限定，不能获得跨新 ticket 的恢复能力。
path policy 独立验证新 carrier，只在同一 actor 中提交水位和 epoch。服务端内存持有恢复 secret，不写磁盘、URL 或诊断。
跨 incarnation / 已清理 ID 返回 SessionLost；业务流失败后不自动重发。新认证失败不会继承旧授权。
服务端 ATTACHED 还必须证明持有原恢复 secret：独立 HMAC 域绑定 ID、incarnation、新通道 binding、
attempt 和 epoch。客户端验证成功才静止旧通道并发 ACTIVATE；此前候选失败不影响健康通道。
ACTIVATE 发出后不再回到旧 epoch；ACTIVATED / SYNCED 丢失通过新 attempt 的水位恢复。
公共 attempt / probe 为 32 位十六进制串，恢复 secret 保留 256 bit。FIN 也接受已验证激活水位的确认。

恢复失败不延长最初 60 秒期限；本地撤权清理 active 和 suspended owner。Hosted 授权到期同样清理
活动 RTC，不因切换而延长短期授权；新合法 admission 可续期。Daemon 使用机器身份每秒复核 Hosted capability 是否仍有效，撤销或原租期到期会终止所属逻辑连接；暂时无法访问 Hub 不延长原租期。客户端在租期内刷新准入，明确 401/403 进入关闭终态。此机制增加每活跃授权约 1 次/秒的控制面请求，尚未实现批量复核或推送。
原生 CLI 的已配对 Device 路由持有重拨 owner，使用新 nonce 完成双向认证后附着原逻辑连接，保留同一流和水位。邀请、一次性 Hosted ticket 和未提供重拨的本地调用仍关闭恢复保留。

硬限制为 32 个 registry 项、160 MiB 传输字节预算。每项当前保守预留 20 MiB：收发日志、接收租约、
待写帧、至多 256 个生产者帧以及有界物理队列。因此默认字节门会将并存项进一步限制为 **8 个**；
32 是数量上限，不是默认可同时承载 32 个满额连接。此预留不等同于 allocator/RSS 上限。
更高并存量需要协商配额或动态预留，不能绕过预算创建。direct-only 仅准许 RTC 或真正的 loopback，
不能由客户端把任意 WebSocket 声称为本机来绕过。

## 验证与后续边界

`specialty.connectivity.resume-core` 执行 TS/Rust 的字节、计数、去重、lease、通道取消不变量，
以及真实加密的同流重接、调用方 buffer 所有权、write/FIN 顺序与明确 v3 拒绝。
`specialty.connectivity.logical-resume` 使用真实 WASM、公共 Client、WebSocket terminate 和独立
进程/磁盘事实，证明单通道断线恢复。原有 connectivity 与 neteff 继续 required，失败 run 不被覆盖。

普通调用、事件与订阅不再按 method 选路。服务 Preview 根据 descriptor 的策略声明选择独立连接；
描述和 ICE 控制可走普通连接，direct-only 内容只走受限连接，daemon 再次强制验证，不能由浏览器降级。
受限 RTC 断开保留原 direct-only owner，经普通控制连接重新协商后仅接入新的 RTC，保留原 HTTP 流；内容不回放到 Fabric。恢复期限与授权仍独立约束它。

后续仍需更大并存量的配额协商、Hosted 撤销批量复核或推送、原生 Hosted 的新票据获取与恢复，以及完整 Web/CLI/App 成套发布验收。当前候选不是完整发布资格，不发布 Beta/Stable。

### dev-net 临时修复核对

| 槽位提交/内容 | 当前处理 | 依据 |
| --- | --- | --- |
| `7031f68`：订阅登记/补拉/取消固定在 events baseline | 已撤除 method 选择器 | RTC/Fabric 共用同一个普通逻辑 peer，真实浏览器验证事件、完成、取消、切换与无重订阅恢复 |
| `7031f68`：心跳固定检查 events endpoint | 已撤除该固定选择，恢复普通 request 路径 | v4 所有物理通道都有独立 5 秒探活 / 15 秒失活判定，RTC 不再掩盖 baseline 故障 |
| v3 Preview 大 bulk window | 已由统一 3 MiB 流窗口替换 | 有界连接接收租约已接管，并通过原有吞吐/公平性验证 |
| `8385317`：RTC 订阅复现和回归 | 保留并升级 | 用实际 RTC 订阅、稳定逻辑 ID、无重订阅、Relay 暂停和真实 RTC 关闭替代固定 Fabric 路径断言 |
