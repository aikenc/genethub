# 逻辑连接：续接核心候选

2026-09-10，dev-net。关联 [v1 总体设计](logical-connection-v1-plan.md)。

这是一项可单独验证的协议核心里程碑。`packages/proto/src/resume.rs` 是 Rust 合同与日志实现；
`packages/workbench/src/dataplane/resume.ts` 是浏览器对应实现；两端读取同一独立字节向量。
生产握手仍声明数据面 v3，现有端点、业务客户端、admission 和 daemon 清理路径未切换。
本候选不是阶段 1/2 全部完成，也不宣称真实连接、流或 handler 已能续接。

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

## 字节合同（候选，未启用）

所有整数为大端，无 JSON number 搬运 u64。Rust 定义为源，TS 实现必须通过
`packages/proto/fixtures/resume-payload.json` 与 `resume-control.json`。

通用头：offset 0 为候选世代 `4`；offset 1 为 opcode；offset 2..3 必须为零；offset 4..11 为
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

CREATE/ATTACH/ACTIVATE/SYNC、PING/PONG、CLOSE/ERROR 的正式 opcode、transcript 和布局仍未冻结，
不能根据本核心支持三个 opcode 就开始发布 v4。数据面正式版本常量仍为 3。

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
核算。128 MiB 不能被描述成已经验证的进程内存上限；32 连接是数量上限，不保证都能协商 4 MiB。

流隔离集成要求：v4 首轮把单流未消费 DATA 限制为连接 data 容量的至多 1/16（默认 256 KiB），
取消 v3 对 Preview 的大 bulk window 特例。单慢流不能占满连接；多个慢流耗尽全局资源时允许明确
背压。小 RPC 的实际调度延迟、4 MiB 日志对吞吐的影响仍须真实流引擎压测，当前日志专项不证明它们。

## 单线程事务与错误处理要求

- 所有读写、激活、回收由逻辑连接 actor 串行化；core 不调用异步 handler，也不持锁 await。
- 只有经过新通道认证与 registry scope/policy/撤权校验的路径才能调用 activate。
- 原始 ACK/BUDGET 必须通过 receiveControl/receive_control 检查 epoch；直接 acknowledge/update_grants
  仅供已经认证且绑定同一 epoch 的 SYNC/actor 内部事务。
- 同 incarnation 的 receiver 位置小于已释放日志边界、恢复 grant 回退均为 StateLost；不猜测对端重启。
- owner 用单调时钟调用 tick，事件循环恢复后先检查期限；计数器或时钟溢出错误必须终止连接。
- `next` 返回的旧 epoch 字节不得被 writer 再发到新路径。新路径只发送重新编码且重新加密的记录。
- ready 仅在双方 SYNC 已完成、重放可以推进时公布；认证成功或调用 activate 本身不构成网络续接证据。

## 验证与下一道门

`specialty.connectivity.resume-core` 经 testctl 执行同文件附近的协议不变量测试。TS 和 Rust 都对照
独立的 literal binary corpus，覆盖超过 2^53 的 u64、长度/reserved 篡改、ACK 丢失、旧 epoch、
日志已释放后的状态丢失、预算伪造、双向 DATA 满载、三类进展帧、重复释放、direct-only 和 TTL。
100 次交替丢帧/丢确认轨迹核对累计输出与缓冲回收。不是 RTC 模拟器，也不是产品端到端验收。

进入完整阶段 2 仍需：

- 拆出已有 DataEndpoint/daemon serve 的逻辑状态，接入此日志，验证同一个 stream/handler 存活。
- registry 的全局准入、定时清理、撤权和 incarnation；head、事件、PTY 的真实配额与 Desync。
- 完成认证 transcript、激活丢回复的事务状态表和控制编码，再验证真实加密单通道断开/续接。
- 端点消费归还租约、终帧 ACK 与 stream retirement、write/finish/Abort/deadline 的联合语义。

进入阶段 3/发布前还须真实 Fabric/RTC/WS、host/guest 权限与内存验收，以及 Web/CLI/App/guest
混合版本与成套回滚。任何这些门未过都保留现有 v3 入口和订阅修复，不声称“聊天已经无感续接”。
