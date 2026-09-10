# 逻辑连接 v1 落地设计

状态：设计推进中。已建立 [续接核心候选与修订契约](logical-connection-core.md)，其已验证范围以该文和 testctl run 为准。dev-net 候选已接入 v4 单类通道恢复与普通 RTC/Fabric 接管，受限恢复与完整发布尚未完成。下文与修订契约冲突时，以修订契约为准。
日期：2026-09-10。落点：dev-net / genethub。
源码基线：genethub `8385317bfe571e07fd3bea9eba8f3582ef3c555d`；genethub-cloud `baaa6518aba574875c2ffb135c02bd09a9e34093`。

## 1. 决策与交付目标

建立稳定的 LogicalConnection API，将流、请求和订阅的生命周期从物理通道中剥离。第一版支持 RTC DataChannel、Fabric 和本地 WebSocket；跨设备优先 RTC，Fabric 作为可用备用。同一时刻只用一条活动通道发送逻辑数据，不做带宽聚合。

业务创建一次连接、发起一次操作。在同一 daemon 进程、有效恢复窗口内，通道切换或全部通道短暂断开后，保留同一连接对象、流 ID、订阅和处理任务，恢复原传输。聊天、文件、终端不选择通道、不因通道切换重新发起操作。音视频媒体继续走原生 WebRTC track，独立处理媒体连接生命周期。

必须区分三种结果：

- **通道故障**：底层恢复，上层的读写可以等待；没有虚假 EOF，没有自动重执行业务。
- **逻辑连接失效**：恢复超时、daemon 重启、权限撤销等产生明确终态，协议客户端负责建立新会话和恢复可重建状态。
- **业务失败**：业务协议照常返回错误；连接层不解释 method，也不替业务判断重试安全性。

“无感”指业务无需通道分支、不会因切换丢失已承诺保留的数据或重复分发操作，不是网络故障期间没有延迟，也不是跨进程 exactly-once 保证。

## 2. 现状与问题依据

以下是上述源码基线的事实，区别于后文拟新增的类型和行为。

| 现有模块 | 当前职责与限制 |
| --- | --- |
| [endpoint.ts](../packages/workbench/src/dataplane/endpoint.ts) | 定义 RecordCarrier、DataEndpoint、DataStream；endpoint 持有 carrier 和加密 key，stream 持有 endpoint；有流控，但没有跨 carrier 续接 |
| [exchange.ts](../packages/workbench/src/dataplane/exchange.ts) | 在 endpoint 上执行 OPEN、body、FIN、响应读取 |
| [protocol/client.ts](../packages/workbench/src/protocol/client.ts) | 同时管理 RTC、基线 endpoint、心跳、重连、订阅、RPC 排队及选路 |
| [daemon endpoint.rs](../apps/daemon/src/dataplane/endpoint.rs) | serve 为每个 carrier 创建 PeerServices、订阅表、stream 表和 handler；carrier 退出后 abort handler、订阅及 fanout |
| [RTC 浏览器入口](../packages/workbench/src/dataplane/rtc.ts) / [daemon RTC 入口](../apps/daemon/src/dataplane/rtc.rs) | 协商 DataChannel，生成独立已认证连接；Rust 分 native 与 WASM carrier 实现 |
| [数据面说明](./e2ee-data-plane.md) | 描述现行 v3 framing、E2EE、Exchange 和资源限制；不是本文续接协议 |

`7031f68` 将订阅、补拉、取消订阅及心跳绑定基线；`8385317` 增加回归。它们修复了不同 endpoint 间订阅与事件错配，但没有延长 endpoint 生命周期。本方案保留故障证据和行为回归；新架构通过验收后删除按业务请求类型固定 endpoint 的临时策略。

不能只在 RecordCarrier 外增加一个换指针函数：加密序号、发送完成含义、重复 OPEN、接收信用以及服务端任务销毁都需要一起调整。

## 3. 目标分层和状态归属

```text
聊天 / 文件 / 终端 / Preview
              ↓
业务协议客户端：RPC、事件解码、快照恢复、业务错误
              ↓
Exchange / LogicalStream：head、双向 bytes、FIN、RESET
              ↓
LogicalConnection：稳定身份、流表、顺序、确认、重放、期限、配额
              ↓
ChannelManager：通道建连、探活、候选选择、激活代次
              ↓
AuthenticatedChannel：独立握手、E2EE key 与 record 序号
              ↓
RecordCarrier：RTC DataChannel / Fabric outer stream / 本地 WebSocket

音视频内容 → 原生 RTC track；协商控制 → 上述普通协议路径
```

| 状态 | 唯一所有者 | 通道关闭后的行为 |
| --- | --- | --- |
| 认证主体、scope、逻辑连接 ID、恢复 secret | LogicalConnection / daemon registry | 有限保留；撤销立即销毁 |
| stream ID、head、信用、收发状态、handler、PeerServices 订阅 | LogicalConnection | 保留；不重建 handler |
| 双向逻辑发送日志、接收确认位置 | LogicalConnection | 保留并按确认位置补传 |
| 活动通道及激活代次 | ChannelManager，服务端串行裁决 | 选择备用或进入恢复 |
| 加密 key、AEAD 序号、底层缓冲、物理心跳 | AuthenticatedChannel | 销毁；新通道重新认证和派生密钥 |
| 已持久化聊天时间线、业务操作状态 | 业务服务 | 保持现行持久化语义 |

连接 ID 不是 sessionId。一个浏览器连接可订阅多个聊天会话；两个标签页默认是两条独立逻辑连接，不能按用户或设备 ID 自动合并。一个标签页也可按不可放宽的 path policy 分设普通与 direct-only 服务连接，二者不共用重放日志。

## 4. 上层 API 契约

以下 TypeScript 为拟议接口。实现时让现有 DataEndpoint 演进或提供薄兼容别名，不保留两套长期流引擎。

```ts
type ConnectionState = 'connecting' | 'ready' | 'recovering' | 'closed';
interface LogicalConnection {
  readonly id: string | undefined; // 首次认证完成前尚未分配
  readonly state: ConnectionState;
  ready(options?: { signal?: AbortSignal }): Promise<void>;
  open(head: ExchangeRequestHead, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LogicalStream>;
  onState(listener: (state: ConnectionState) => void): () => void;
  close(reason?: string): Promise<void>;
}
interface LogicalStream {
  readonly id: number;
  readonly responseHead: Promise<ExchangeResponseHead>;
  readonly done: Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  body(): AsyncIterable<Uint8Array>;
  finish(): Promise<void>;
  reset(reason?: string): Promise<void>;
}
```

- `open` 可在 connecting/recovering 中等待，但有有限等待队列、signal 和绝对 deadline；进入发送日志才分配不可复用的 stream ID。超过配额必须显式拒绝。
- `write` 在取得信用和发送日志空间后接纳数据；resolve 只代表数据已归逻辑层保管，不代表对端消费、业务提交或落盘。并发 write 按调用入队顺序串行化；限制等待写入的字节和调用数，禁止隐式无限保留调用者 buffer。
- `body` 是单消费者；恢复期间等待，返回过的字节不重复交付。消费者取走数据才归还 stream credit。
- `finish` 是有序半关闭，排在此前 write 后；不会关闭读方向。`done` 仅在本地和远端正常结束、必要终帧已确认时完成，RESET/连接终态则拒绝。
- `reset` 立即终止本地消费者和后续写入；可靠发送取消，离线时不能保证远端立即停止。RESET 已入日志后的投递遵循顺序；业务取消不意味着副作用回滚。
- `close` 是主动终态，有限时间发送 CLOSE 后清理本地状态，不触发重连；对端不可达时依赖恢复 TTL 回收。
- deadline 包含离线时间，不能每次重连重新计时。长订阅没有普通 RPC 的默认业务期限，但受连接恢复 TTL 和资源上限约束。
- body 收集器的 stall timeout 要区分暂停恢复与 ready 状态下的数据停滞；暂停不能越过绝对 deadline。避免现有 Preview 收集器先于恢复窗口错误关闭流。

普通业务仅注入 LogicalConnection。RTC 开关、优先级、物理状态放到 composition root 的 TransportPolicy / TransportDiagnostics，设置页和诊断页可读取；业务 method 不得接受 `transport` 参数。协议客户端仍可保留逻辑连接状态供 UI 显示“正在恢复”。

## 5. Wire 设计：新增续接封套，复用流语义

第一版选择**连接级、有序重放日志**，不引入逐流恢复清单或多路径乱序重组。现有多流公平调度先挑选 DataFrame，再为选中的帧分配连续逻辑序号。

拟将数据面升级为 v4；业务 JSON PROTOCOL_VERSION 仍可为 v3。版本号正式占用前核对主干；以下 v4 表示新数据面世代。Fabric outer 协议不因此改版。

每条已认证通道内，在 E2EE 明文中定义有界封套：

| 消息 | 必需字段与语义 |
| --- | --- |
| CREATE / CREATED | 协议能力、双方限制；返回 connectionId、serverIncarnation、恢复凭证和有效期 |
| ATTACH / ATTACHED | connectionId、incarnation、新 challenge 与 proof；认证附着到现存逻辑连接，尚不能发业务数据 |
| ACTIVATE / ACTIVATED | attemptId、expectedEpoch；服务端提交新 epoch、绑定 channel；响应包含两侧同步所需确认位置 |
| SYNC | 当前 epoch、收到的最高连续 logicalSeq；握手完成双方才进入数据发送 |
| PAYLOAD | epoch、logicalSeq、完整 DataFrame；OPEN/HEAD/DATA/WINDOW_UPDATE/FIN/RESET 均纳入日志 |
| ACK | epoch、receivedThrough；表示已按序接纳至该位置，不表示业务完成 |
| BUDGET | epoch、累计 dataGrant 与 progressGrant；分别约束业务帧和 WINDOW_UPDATE/FIN/RESET，控制消息本身不占 PAYLOAD 信用 |
| PING / PONG | 通道内 nonce、时限；探测具体 channel，不占 logicalSeq |
| CLOSE / ERROR | 连接终止原因；恢复拒绝须明确区分过期、权限拒绝、状态丢失、协议错误 |

所有整数固定编码，logicalSeq/epoch 用 u64；TS 用 bigint，不经 JSON number。字段布局、枚举、长度和 transcript canonical encoding 在首个实现提交中固化为 Rust/TS 共用 golden vectors。

保留 record 总长 16 KiB 时，新增封套会减少最大 DATA payload，必须由头部开销推导常量，不能继续使用 v3 的 16,340 字节。head 仍有硬上限，超限在分配前拒绝；控制消息也要有独立大小和速率限制。

### 5.1 四条不能混用的序号

1. **AEAD record 序号**：每个新通道、每个方向独立；严格递增。
2. **激活 epoch**：服务端对一条逻辑连接单调增加；隔离旧通道。
3. **logicalSeq**：逻辑连接内每方向单调递增，跨通道不归零；用于去重和重放。
4. **stream 内 DATA 序号/credit**：保留流协议语义；重复逻辑帧在进入流状态机前丢弃。

重放的是保留的明文逻辑帧，使用新通道 key 和新 AEAD 序号重新加密。禁止把旧密文直接发到新通道，禁止为了续接重复使用 nonce。

### 5.2 接收、ACK 和重放

发送顺序：获得配额 → 把帧和 logicalSeq 存入日志 → 发送。通道 send 成功不删除日志。

接收顺序：验证通道和 epoch → 比较 logicalSeq → 为帧预留有界接收空间 → 接纳帧并推进连续位置 → 安排 ACK。逻辑接纳必须是单一串行状态机事务；OPEN 只能登记一次 handler。ACK 后允许业务尚未消费，但相应帧/状态必须仍在进程内受控保留。

- `seq == receivedThrough + 1`：正常接纳。
- `seq <= receivedThrough`：重复，不重复 dispatch、扣 credit 或启动 handler；可重发 ACK。
- `seq > receivedThrough + 1`：同一活动有序通道上不应出现；停止数据接纳并报告协议错误，不用无限乱序队列掩盖实现缺陷。
- ACK 只能推进到本端确实发送过的位置；虚高 ACK 拒绝，较旧 ACK 忽略。恢复位置小于本端已经丢弃日志的边界表示状态不一致，必须拒绝续接。
- ACK 可以批量发送；PING、ACK、BUDGET、SYNC 不进入重放日志，避免 ACK 互相确认形成循环。WINDOW_UPDATE 必须入日志并去重，防止重复增加信用。

FIN、RESET 的重复也要在连接层挡住。stream 退休必须考虑双方终态和终帧确认；stream ID 在连接生命周期内不复用。全局确认位置继续存在，因此不需要无限保存已退休 stream 的去重表。计数器耗尽时有序关闭并重新建连，禁止回绕。

## 6. 通道建立、切换和恢复算法

### 6.1 首次连接与 RTC 升级

1. 经 Fabric 或本地 WS 完成现有 admission 的新版握手，建立 AuthenticatedChannel。
2. CREATE 分配逻辑连接及 PeerServices，激活首条 channel，打开唯一 events stream。
3. ChannelManager 经已可用的逻辑控制路径进行 RTC 协商；不依赖一个名为 baseline 的业务 endpoint。RTC 协商仍需设置独立时限。
4. RTC DataChannel 完成身份认证、ATTACH；ChannelManager 决定切换时执行 ACTIVATE。
5. SYNC 双方确认位置，按顺序重放未确认帧，再发送新帧。上层连接和 stream 对象不变。

第一条可用通道的发现/信令仍需要现有 Fabric 控制路径；两条数据通道都没有时，不承诺凭空建立 RTC。连接发现器重试 Fabric，成功后再协商 RTC。已有 RTC 可用而 Fabric 断开时，逻辑业务继续运行，同时后台恢复 Fabric 备用。

### 6.2 激活仲裁与旧通道隔离

客户端是 v1 的切换发起者，daemon 是唯一 epoch 裁决者；daemon 发现故障可发提示或关闭 channel，但不同时启动另一套独立选主算法。

- 候选通道认证成功不影响活动通道。双方只允许一项待定激活；重复 attemptId 必须返回同一结果。
- 服务端在逻辑连接 actor 内串行执行激活：验证 expectedEpoch、冻结旧路径的新发送、提交新 epoch 和 channelId、返回 ACTIVATED。
- 客户端收到后冻结旧路径、绑定新 epoch，发送 SYNC。服务端收到匹配 SYNC 后可发 PAYLOAD；客户端只接受已确认激活的通道。切换期间的旧通道数据在提交点之前可接纳，之后一律不进入逻辑流。
- ACTIVATED 或 SYNC 丢失：在已认证候选上重试同一个 attempt，或新附着后查询当前 epoch；不能猜测激活成功，不能递减 epoch。若原候选已死，下一次切换使用新 attempt 与当前 epoch。
- 原活动通道能否继续用取决于激活是否已提交。提交前失败保持原路径；提交后失败必须重新激活可用路径，不能直接恢复旧 epoch 的发送。
- 切换后旧通道可保留为备用，只允许通道控制和探活；任何新数据都必须经新 epoch 激活。

每一侧只需有序发送一条活动通道；两端切换确认有时间差，旧在途帧可能丢弃，可靠性由确认位置和重放负责。禁止以“同一时刻绝无两个在途包”作为正确性前提。

### 6.3 故障和全部断开

活动通道关闭或探活超时 → 有已认证备用则激活 → 否则 state=recovering、启动恢复期限、继续有界保留流和任务 → 新通道认证附着成功后续接 → 超时转 closed。

RTC 恢复稳定一段时间后才升回，避免反复抖动；用户禁用 RTC 时先迁到可用 Fabric，再关 RTC；没有备用则进入 recovering。不能因 Fabric 关闭而连带关闭健康 RTC。

逻辑 state=ready 以已完成同步、可推进数据为准；候选握手期间活动路径仍健康可以保持 ready。连接层不强求 UI 每次切换都闪现重连提示。

## 7. daemon 生命周期与恢复安全

新增进程内 LogicalConnectionRegistry，由 daemon Shared 状态持有。主键至少为随机 connectionId；记录绑定 daemon incarnation、认证主体、设备或 capability、workspace scope、授权版本、有效期和恢复凭证。每个逻辑连接对应一个串行 actor，负责 attach、激活、ACK 和销毁。

PeerServices、streams、handlers、event queue、fanout 移入逻辑连接对象。carrier task 退出只通知 actor，不执行现有 serve 末尾的全面 abort。仅逻辑终态统一关闭流、订阅、fanout、处理任务和配额；使用幂等 cleanup，防止多条 carrier 同时退出导致重复回收。

恢复凭证在首次 E2EE 会话中生成并交付，只保留内存，不进 URL、localStorage、日志或诊断。每次 ATTACH 必须完成新通道认证，并用恢复 secret 对 connectionId、incarnation、channel handshake transcript、双方 fresh nonce、attempt 上下文做域分离 HMAC。connectionId 本身不是权限。

认证必须匹配原主体和 scope，并重新核对撤销、凭证到期和授权版本；不允许在 attach 时提升权限。loopback 单次 proof、RTC 短期 admission 不能直接拿旧票据重复使用：续接有专门的 challenge/proof 路径，限于原权限和 TTL；进程丢状态后仍须重新走正常 admission。invite/claim 等一次性建权流程不纳入 v1 可恢复业务连接，保留一次性语义。

恢复 TTL 不因失败握手、探测包或恶意 attach 延长，只有完成同步并恢复健康活动才结束本轮恢复计时。设备撤销要同时清理活动与脱机逻辑连接；不能只关闭当前 socket。

daemon 重启生成新 incarnation；旧连接返回 SESSION_LOST。资源压力不能静默逐出并仍承诺可续接：先拒绝新连接；必要清理已超期连接。管理性关闭返回明确原因，断线方下次 attach 得到恢复拒绝。

## 8. 内存、背压和业务生产者

以下是首轮实现和压测的**提议默认值**，不是已测性能结论。修订契约将进展帧另设 64 KiB 接纳与日志预算；这些字节数不等于 JS/Rust 实际 heap，registry 准入还须覆盖条目、任务与其他缓冲。客户端与 daemon 握手协商较小值，服务端仍执行全局硬上限。

| 项目 | 初始预算 |
| --- | --- |
| 同一连接活动 streams | 256，保留现有限制 |
| 每方向未确认发送日志 | 4 MiB，达到上限停止接纳新帧 |
| 每方向 endpoint 接收队列总量 | 4 MiB，另加业务显式分配，不与 stream credit 等同 |
| 每连接所有等待 open/write | 最多 256 项、待接纳 bytes 共 4 MiB；超限拒绝 |
| 控制消息保留空间 | 每方向 64 KiB；控制优先且限速，PAYLOAD 不可占用 |
| 全部通道中断恢复窗口 | 60 秒；使用单调时钟 |
| active 通道探活 | 5 秒发送，15 秒无有效应答判失活；后台节流恢复时立即探测 |
| RTC 升级稳定期 / 升级冷却 | 3 秒 / 10 秒；失败退避加 jitter，上限 30 秒 |
| 每逻辑连接物理通道 | 最多 2 条已附着，1 条额外握手候选，候选限时回收 |
| daemon 保留逻辑连接 | 首轮最多 32；实际准入同时受全局 bytes 配额约束 |
| daemon 逻辑传输缓冲总预算 | 首轮 128 MiB，含日志、待接纳、接收和控制队列；按实际分配核算 |

发送日志上限不是 64 MiB 文件大小上限；Preview 边发边 ACK 即可推进。现行 bulk credit 是接收许可，不是可无界保留未确认数据的许可。浏览器最终文件 buffer、daemon Preview worker、carrier/host 缓冲还需另行计入总内存压测。

ACK 表示接纳，WINDOW_UPDATE 表示消费，两者独立。接收队列满时，不能让唯一 reader 永久等待业务入队而读不到 ACK：reader 持续解析有界控制，数据接纳遵守事先授信及连接预算。实现需增加连接级 admission/发送预算协商，确保合法对端不会投递超过接收可用预算的数据；预算更新用单调累计额度，通过不占数据日志的 BUDGET 控制消息发送；丢失时重复通告最新值，旧值忽略，并在 SYNC 交换。调度器必须保留控制进展，禁止通过未界定的额外队列“解决”死锁。

连接接收预算按完整逻辑帧编码字节计费。设接收容量 C、累计释放字节 F，则公布 grant=C+F；发送方首次分配逻辑序号时累计 charged，只有 charged+frameBytes<=grant 才能入队。重放不再次收费，重复接收不增加 F；仅接收队列把帧交付受独立配额约束的流状态/消费者后释放一次。双方在同一逻辑连接内保留计数，不能因重连重置；新的 grant 不得低于旧值或发生整数溢出。ACK 释放发送日志，BUDGET 释放连接入队许可，WINDOW_UPDATE 释放流许可，三者各自独立。接收方初始公布的 C 必须有真实全局预算预留；配额不足则降低协商值或拒绝准入。

BUDGET、ACK 和激活消息走独立有界控制队列，不受 PAYLOAD 信用限制；PING/PONG 同样如此。传输 reader 不直接等待业务消费，队列合法上限由已授信预算保证。流级接纳另受 stream window 约束；bulk 许可不能越过连接预算。控制洪泛采用限速并终止违规通道，不能无界排队。

慢消费者只阻塞其 stream 的新增 DATA；其他有信用的流继续公平调度。已分配 logicalSeq 的重放必须有序；未取得资源的帧不要提前分配序号，避免制造无法跨越的日志空洞。

事件生产者不都支持背压：聊天存储已有事件位置可供协议层补拉；当 fanout/broadcast lagged 或事件队列无法保留时，必须显式发 Desync 或失败该事件流，由协议客户端恢复快照，不能静默停止事件 task。连接层保证的是已接纳传输帧的可靠性，不创造业务上游丢弃事件的副本。PTY 等不可重放源需明确报告输出缺口，不能伪装完整输出；不得无限阻塞全局 fanout。

## 9. 请求执行与失败语义

| 故障位置 | 处理与上层结果 |
| --- | --- |
| OPEN 尚未进入发送日志 | 排队等待或明确取消/超限失败，没有远端操作 |
| OPEN 已发送但 ACK 丢失 | 重放同一个 logicalSeq；服务端去重，不创建第二个 handler |
| 操作已执行、响应未确认 | 原 handler/响应日志继续存活，经新通道传原响应 |
| 恢复窗口内暂停 | 保留 Promise 和迭代器；deadline 到期仍可失败 |
| daemon 重启 / 续接过期 | 关闭旧连接；已可能发送的写操作返回 OutcomeUnknown，禁止连接层重新执行 |
| 权限撤销 | 立即终态 PermissionRevoked，不使用备用通道绕过 |
| 接收源明确断档 | 协议层 Desync / snapshot 恢复；不把旧流装成连续 |
| 用户主动关闭 | 终态 ClosedByUser，不重连 |

以现有 ConnectionOutcomeUnknownError 为兼容起点，补充 ResumeExpired、SessionLost、PermissionRevoked、ResourceExhausted、ProtocolViolation 等内部分类。对业务写入，“收到 ACK”也不能解释为已提交；确认完成只能依赖业务响应。deadline/取消同样不等于远端副作用未发生。

新的逻辑连接建立后，协议客户端可以重订阅持久化时间线和重查状态；这一过程与旧连接成功 resume 严格分开。成功 resume 不调用 resubscribe、不重开 events、不清空 UI 缓存。

## 10. 模块改造清单

下表中的“新增”是拟新增文件，未实施前不应被当成已有 API。

| 位置 | 工作 |
| --- | --- |
| workbench dataplane/endpoint.ts | 将 streams、流控、逻辑发送队列与 carrier 生命周期解耦；兼容现有 open/Exchange 用法 |
| workbench dataplane/logical-connection.ts（新增） | 公共连接状态、deadline、恢复、配额、流表协调 |
| workbench dataplane/channel-manager.ts（新增） | 拨号、探活、RTC 优先策略、attach/activate、备用通道管理 |
| workbench dataplane/resume.ts（新增） | 重放日志、ACK、水位、序号和恢复校验 |
| workbench dataplane/secure.ts、handshake.ts、frame.ts | 新版封套、新通道认证及 transcript；重算最大 payload |
| workbench dataplane/rtc.ts、fabric.ts、websocket.ts | 返回 AuthenticatedChannel 或 carrier 工厂，不再创建独立业务 PeerServices 语义 |
| workbench protocol/client.ts | 注入逻辑连接；移除业务请求级 endpoint 选择和物理 heartbeat；保留业务 schema 与终态后的快照恢复 |
| workbench dataplane/exchange.ts | 面向稳定连接接口；核对 write/finish 和 response 消费的等待语义 |
| daemon dataplane/endpoint.rs | 拆分 carrier reader/writer 与逻辑服务 actor；重构 serve 的 cleanup 边界 |
| daemon dataplane/logical_connection.rs、resume.rs（新增） | registry、恢复凭证、actor、重放与全局配额 |
| daemon Shared 状态初始化及撤销入口 | 持有 registry；撤销同时终止 suspended connection |
| daemon dataplane/handshake.rs、frame.rs、rtc_host.rs、rtc_guest.rs | 新版认证和通道附着；native/WASM 使用同一逻辑引擎 |
| daemon dataplane/client.rs、CLI 连接入口 | 同步新数据面版本；无 RTC 的客户端也使用同一连接语义 |
| packages/proto/src/data.rs 及 TS 对应生成/导出链 | 维护版本和协议定义；生成产物从源更新，不手改投影 |
| 设置与诊断 composition root | 保留 RTC 设置和诊断，业务组件依赖检查 |
| Cloud Console 集成 / Relay 契约 | 更新引用和版本兼容提示；Relay 保持 opaque，不存逻辑订阅或恢复日志 |

ServiceMediaPanel 的音视频 track 不进入字节重放引擎；媒体控制调用使用统一连接。`carrier_kind` 同时参与 Service Preview 的 direct-only 授权，不能只改成诊断采样。安全约束提升为连接级不可放宽的 path policy，受限服务独立连接；诊断按实际传输事件采样。

## 11. 开发阶段与每阶段退出条件

1. **契约冻结**：固化 API、封套编码、认证 transcript、ACK/预算语义、激活故障状态表。输出 TS/Rust golden vectors 和不变量测试清单。未解决控制死锁与激活响应丢失前不批量迁业务。
2. **单通道逻辑引擎**：实现有界重放、ACK、stream retirement 和 actor 生命周期；用可控 carrier 做确定性断点验证。先通过同进程断线恢复，尚不宣称 RTC 切换完成。
3. **真实多通道**：接入 Fabric/RTC/本地 WS；实现双通道激活、旧 epoch 隔离、权限恢复和自动退避。native 与 WASM daemon 都验证。
4. **协议客户端收敛**：迁移 RPC、events、Preview、shell 控制；删除临时 method 选路分支，处理收集器 timeout 和生产者 Desync；业务组件无需新增 RTC 分支。
5. **故障与容量验收**：执行下节矩阵和资源压测；保存精确双仓 SHA、测试结果和已知限制。
6. **候选与发布交接**：开发槽按提交审查流程保存候选，release-beta 执行版本、部署、CLI/App 覆盖审计和回滚验收。本文不授权或执行发布。

工作量判断：属于中高复杂度的双端协议演进。投入主要在第 2、3、5 阶段，不能用“接口文件完成”估算完成率。阶段 1/2 产出后再根据真实故障和内存数据给出工期估计。

## 12. 验收矩阵

本节是待执行验收要求，不是本次文档编写的测试结果。实现测试遵守 dev-net 的 test-development / test-runner 约束，通过 testctl 注册、选择和运行；不另造一套发布 gate。

| 场景 | 必须断言 |
| --- | --- |
| RTC 就绪后首次打开空会话 | 用户消息、增量、最终 turnCompleted 到达；同一订阅和 events stream |
| Fabric → RTC → Fabric 连续 100 次 | 连接对象/ID、已有 stream ID 不变；字节 hash 一致、handler 计数一次 |
| RTC 正常、Fabric 完全断开 | 不关闭 RTC；现有流继续推进；Fabric 后台重建 |
| RTC 故障、Fabric 可用 | 自动切换；业务 Promise 不因通道关闭提前 reject |
| 双通道中断 30 秒后恢复 | 在 TTL 内同 incarnation 续接；不 resubscribe、不重复 OPEN |
| 双通道超过 60 秒 | 明确 ResumeExpired、资源释放；旧操作不自动重发 |
| 激活各步骤前后丢包/关闭 | 只有一个已提交 epoch；ACK/ACTIVATED 丢失能收敛，无双重 handler |
| 旧通道延迟投递 | 旧 epoch 不进入流状态机；新通道完成补传 |
| 响应生成后、ACK 前断开 | 服务端副作用计数为 1；客户端取得原响应 |
| OPEN/FIN/RESET/WINDOW_UPDATE 重放 | 无重复执行、虚假 EOF、重复 credit 或流泄漏 |
| ACK 虚高、回退、缺口、非法大小 | 明确拒绝；不删除未确认数据、不无限分配 |
| 双向同时写满、消费者暂停 | 内存封顶；控制通道继续进展；小 RPC 不被文件业务永久堵塞 |
| 64 MiB Preview 与实时事件并发 | hash 正确，增量可推进，重放缓存不随文件长度增长 |
| daemon 重启 / 主动 close / 撤权 | 正确终态；无“续接成功”假象；OutcomeUnknown 分类正确 |
| 不同设备、scope、标签页、过期 proof 附着 | 拒绝越权与错误合并；合法旧通道不被恶意 attach 踢下线 |
| 慢事件消费者 / broadcast lagged | 明确 Desync 或失败；不会静默永久停更 |
| 浏览器休眠、恢复、Abort、deadline | 定时器延迟后重新核验期限；无无穷等待和未处理 rejection |
| native / WASM / CLI / Console | codec 一致；可互通；运行权限和撤销路径一致 |
| 原生媒体播放时数据通道切换 | 媒体 track 生命周期不被数据连接误关闭 |

验证分三层：确定性状态机故障注入用于覆盖每个提交点；TS/Rust 交叉 golden vectors 用于编码与边界；真实 Chromium、Relay、RTC、native/WASM 进程用于端到端行为。模型可 mock，传输和 daemon 不用 mock 替代最终证据。

保留 [现有 RTC 专项](../testing/specialties/connectivity/rtc-subscriptions.specialty.ts) 的空白/输出中断场景；把“subscribe 必须走 Fabric”实现断言替换为“逻辑订阅不变且末尾事件完整”。旧版本证明故障，新版本证明行为；不要把临时实现细节当长期契约。

## 13. 版本、迁移与回滚

本方案改变数据面握手和 framing，**不能沿用上一版补丁的纯 Web 更新判断**。需要审计 daemon、CLI、App 内 daemon/WASM、Web workbench、Console bundle 以及配套测试客户端。

采用明确版本切换，不在解析失败后试旧协议，也不长期保留两套运行引擎。握手前识别数据面版本，不兼容时在该边界报版本不匹配，UI 提示更新；任何结构化 upgradeRequired 消息都必须先定义并测试，不能假定旧端认识它。

部署步骤：核对全部消费者与版本 → 构建配套新端 → 自托管/开发环境完整互通验收 → Beta 发布交接审计 → 控制升级窗口和客户端缓存 → 新建连接验收。旧活跃连接不会被升级成新逻辑连接；滚动更新或 daemon 重启会终止它们，需要正常重建业务状态。

回滚以匹配的数据面组件集合执行，不能只回滚 Web 后让它连接不兼容 daemon。回滚后旧进程内恢复状态不保留；持久化聊天数据按原业务恢复。发布交接须列出精确产物和回滚集，业务 PROTOCOL_VERSION 保持不变不代表传输兼容。

`dev-net` 的订阅归属补丁保留到新路径完整通过验收；不先删除止血逻辑再留下不可用中间版本。若先单独发布补丁，它与后续新数据面作为两个独立候选审计。

## 14. 可观测性与完成定义

记录脱敏逻辑连接关联 ID、server incarnation、epoch、channel kind、切换原因、恢复耗时、未确认 bytes、重复丢弃计数、队列高水位、Desync 和终态原因；禁止输出恢复凭证、认证 proof、完整业务内容。逻辑连接关联标识与用户数据的保留策略保持现有诊断规范。

最低指标：切换成功率、恢复耗时分布、ResumeExpired/SessionLost 数量、每方向队列高水位、handler 重复分发（必须为零）、悬挂连接清理数。性能阈值先记录同环境 v3 基线，再评估 v4 的小 RPC 延迟、大文件吞吐和内存；不能用未经测量的固定吞吐承诺替代证据。

最终完成必须同时满足：

- 普通业务不 import RTC/Fabric 实现、不按 method 选 endpoint；设置/诊断/媒体边界有明确允许清单。
- API、TS/Rust wire、安全与资源约束一致，激活及 ACK 丢失场景有确定性验证。
- 同进程恢复窗口内现有流、订阅和 handler 保留；跨进程失败边界明确。
- 全部通道断开时有界等待、有界内存、确定终态；无控制死锁和静默事件断档。
- 回归、真实 RTC 与资源验收通过，精确候选可审查；发布另行绑定环境证据。

实现前需要细化而非留给业务层的事项：封套字节布局与错误码、连接级累计预算公式、各 actor 提交点、scope 撤销来源、版本升级消费者清单。它们属于阶段 1 的阻止进入后续阶段条件，不改变本方案已确定的“单活动通道、同进程续接、RTC 首版支持”范围。


## 实施校准（2026-09-10，dev-net 单通道候选）

阶段 2 的真实单通道恢复已接入，状态与范围见 [实现说明](logical-connection-core.md)。两个参数
经实测修订：单流窗口从 256 KiB / data 容量 1⁄16 调整为 3 MiB / 4 MiB，仍留出跨流 data 空间和
独立 progress 桶；原参数在 100 ms 中继链路仅约 22% 同链路 TCP 吞吐，新参数通过原门槛。
registry 以 20 MiB/项保守预留传输资源，128 MiB 默认最多并存 6 项；32 仍为数量硬上限。
后续扩大并存量需实现可验证的配额协商，不能把数量上限误写为默认满额能力。

本校准不表示阶段 3 的 RTC/Fabric 同连接切换、策略池或整套发布已经验收。原生 CLI 暂不保存
可重拨的逻辑 endpoint，明确声明不保留断线状态；浏览器是当前真实单通道重接消费者。

跨通道接入校准（2026-09-11）：普通 RTC/Fabric 已共用一个逻辑连接并撤除订阅 method 选择器。
ATTACHED 增加服务端恢复凭据持有证明；RTC 继承原主体，Hosted 原主体由 Control 稳定声明并在
admission 时复核。真实浏览器保持连接 ID、事件和订阅，Relay 暂停不影响活动 RTC，RTC 关闭后恢复
原基础通道流。direct-only 服务连接当前在 RTC 丢失时明确失败，禁止回放到 Fabric；其自动重接、
Hosted 即时撤销推送和原生 CLI 重拨 owner 仍属后续边界，不能以本候选宣称全部 v1 目标已完成。
