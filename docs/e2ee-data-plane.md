# 提案：轻量 E2EE Data Plane（TransportEndpoint + Exchange）

> 状态：MVP 设计，尚未实现。本提案定义通用数据面边界、WebRTC direct provider、Settings 状态，以及从 legacy 协议一次性切换的规则；轻量 Preview 契约见 [轻量 Asset Preview](./assets-quick-preview.md)，安全边界见 [安全模型](./security-model.md)。

## 1. 决策摘要

- 产品只保留 **一套当前应用协议**。现有 legacy `Client`、单体 `Request/Reply` envelope、全连接业务 sequence、legacy Relay endpoints 和 `file.read` 全部迁移并删除；不保留双协议、兼容 adapter、feature flag 或静默 fallback。
- 每个 browser/CLI/daemon endpoint 维持 **一条长期 `/fabric/v2` WebSocket** 作为基线；远端且 RTC 已启用时，再为当前 peer 建立一个 WebRTC PeerConnection。所有客户端主动请求各占一条短生命周期 logical stream。
- 唯一稳定的连接抽象是 `TransportEndpoint`：它按 opaque route admission 打开已认证、E2EE、有界的 `SecureDuplexStream`。MVP 同时实现 WebSocket Fabric 与 WebRTC direct，两者对上提供同一接口。
- 中间语义层只有两种能力：普通主动请求使用 streaming `Exchange`；PTY、订阅和持续 push 使用 `DuplexStream`，需要消息边界时套一个轻量 `MessageChannel` codec。
- 每个 GeneHub wire frame 硬上限为 **16 KiB**。发送端自动切片，以等权 round-robin 在可发送 streams 间轮转；不引入业务 priority、专用 lane 或复杂 scheduler。
- endpoint reader/writer 永不执行 handler、文件 IO 或模型调用。每条 stream 有独立 task、credit、队列、取消和上限，慢业务只阻塞自己。
- Relay 只读通用 route/stream frame header 并转发 opaque E2EE payload。method、path、MIME、status 与 body 全在密文内；endpoint 准入不代替 daemon 的 workspace/path 业务授权。

公共架构只有三层，provider 是 `TransportEndpoint` 的内部实现：

```text
Business              asset.preview / file / agent / pty / events / ...
        │
Semantic framework    Exchange             DuplexStream + MessageChannel
        │
TransportEndpoint     route / peer auth / E2EE / bounded logical streams
        ├─ MVP base    one WebSocket Fabric endpoint
        └─ MVP direct  one WebRTC PeerConnection per active remote peer
```

这不是重新实现 HTTP/2 或 QUIC。它只是把仓库里已有的 Fabric logical stream 收口为安全、稳定的 endpoint API，再补一个很薄的请求—响应 codec。

### 1.1 MVP 交付边界

MVP 只有三个不可拆分的产品结果：

1. **E2EE/Data Plane 重构**：`TransportEndpoint`、Secure Stream、16 KiB frame、WebSocket provider、WebRTC direct provider、Exchange/Duplex、Settings RTC 开关与状态。
2. **协议层完整替换**：Web、daemon、proto、Relay、Control 全部迁到新协议并删除 legacy，不存在双栈或 fallback。
3. **轻量 Asset Preview**：唯一入口是已注册 workspace 的相对文件路径，支持图片、Markdown/text、单文件 HTML 和不超过 2 MiB 的小视频；完整文件或明确失败。规范 URL 直接携带 workspace handle/path，供 FilesPanel、Agent 与聊天共同生成链接。

MVP 明确不做 TURN、媒体 track、每 stream 一个 RTCDataChannel、多 WebSocket lane、live stream migration、通用 retry、大文件 overview、Range、多文件 WebRoot、Service Worker 或云端资源缓存。Cloud Gateway 与 SNI WebRoot 提案保留为后续能力。

## 2. 连接拓扑：基线 WebSocket + 可选 RTC，N 条 logical streams

当前 Hosted 基线路径与 RTC 直连路径并存：

```text
browser TransportEndpoint  ═══ RTC DataChannel direct ═══  daemon TransportEndpoint
        │                                                        │
        │ endpoint WebSocket                         uplink WebSocket
        ▼                                                        ▼
                              Fabric Relay
                 route/stream header 可见；payload 不透明

任一 provider 都向上返回 SecureDuplexStream：Exchange 或长生命周期 Duplex
```

daemon 的一条 endpoint WebSocket 可以同时承载来自多个已授权 browser/service 的 streams；每条 stream 分别绑定 route admission、peer identity、E2EE state、credit 与生命周期。Local/loopback 没有 RTC 收益，始终使用本地 WebSocket。

远端连接先让 WebSocket endpoint 可用，并在后台通过一条加密 signaling stream 建立 RTC。RTC connected 后，新开的 logical streams 使用 RTC；已经在 WebSocket 上运行的 stream 留在原 provider。RTC 失败或断开时，在途 RTC streams 明确失败，之后新 streams 使用 WebSocket；不迁移、不自动重放。

所以这里的“短连接”是短生命周期 logical stream，不是每次请求新建 TCP/WebSocket/PeerConnection。它给每个 request 独立取消、backpressure 和公平调度，同时避免握手开销。

RTC direct 能绕开 Relay 数据路径并通常减少网络绕行；WebSocket 路径仍有 TCP packet-loss HOL，但小 frame、公平轮转和有界队列可避免大业务包独占应用发送链。MVP 不再叠加多 WebSocket lane。

代码锚点：legacy 队列见 [`protocol/client.ts`](../packages/web/src/protocol/client.ts)，现有 Web Fabric endpoint 见 [`fabric/endpoint.ts`](../packages/web/src/fabric/endpoint.ts)，frame 见 [`fabric/frame.ts`](../packages/web/src/fabric/frame.ts)，daemon legacy uplink 见 [`transport/uplink.rs`](../apps/daemon/src/transport/uplink.rs)，Relay 当前边界见 [relay](./relay.md)。

## 3. 稳定边界：TransportEndpoint

### 3.1 最小接口

```text
interface TransportProvider {
  connect(endpointAdmission): Promise<TransportEndpoint>
}

interface TransportEndpoint {
  openStream(routeAdmission): Promise<SecureDuplexStream>
  incomingStreams(): AsyncIterable<SecureDuplexStream>
  status(): TransportStatus
  onStatusChange(listener)
  close(reason?)
}

interface SecureDuplexStream {
  id
  peerIdentity
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  closeWrite()
  reset(code)
}
```

`routeAdmission` 是 Control/本机 admission 层签发的 opaque、短期、单用途路由能力。业务不能解析它，也不能把 workspace path、method 或 MIME 放进去。

只有完成 route admission、对端身份校验与 E2EE setup 后，provider 才向上返回 `SecureDuplexStream`。该 stream 保证：

- 每个方向都是有序 bytes，并支持 half-close、RESET 与 backpressure；
- 一次大 write 自动切成 bounded frames，多个 runnable streams 公平推进；
- payload 在两个终端之间 E2EE；Relay 只能看到通用 frame header、长度与时序；
- carrier 断开时明确终止未完成 streams，不自动重放。

它不保证自动重连、跨 provider live migration 或业务幂等。endpoint 可以用新 admission 恢复 carrier，但旧 streams 全部失败；是否新建 Exchange 由上层依据业务语义决定。

Semantic framework 可以依赖 `TransportEndpoint`；业务 handler 只能依赖 `Exchange`/`DuplexStream`。业务不能 import WebSocket、RTCDataChannel、Fabric frame encoder、socket buffer 或选择 provider。

`TransportEndpoint` 自己按 provider readiness 选路，不接受 method、MIME、body size 或业务 priority。Settings 修改的是 client-local RTC preference；业务请求不能强制走 RTC 或 WebSocket。

### 3.2 内部只有两个职责，不新增公共层

`TransportEndpoint` 内部可以拆成两个模块，但不向业务暴露：

1. Frame Link：endpoint admission、route OPEN、bounded frame、stream state、credit、调度和 carrier 生命周期。
2. Secure Stream：逐 stream peer authentication、key derivation、AEAD record、sequence/replay 与 secure hello。

这个内部拆分是为了保持 Relay 可路由而不见内容：Relay 必须读 Frame Link header，却永远不解析 Secure Stream payload。它不是第三套业务 API。

## 4. MVP 基线 provider：单 WebSocket Fabric

browser/CLI/daemon 各自使用一个 `WebSocketFabricProvider`。一个 endpoint 对应一条物理 `/fabric/v2` WebSocket，并在其中复用所有 routed streams；不再保留 `/forward/client`、`/forward/daemon` 业务通道。远端模式即使 RTC 已连通也保留这条基线连接，用于 signaling、presence 和 RTC 不可用时的新 streams。

通用 frame 与现有 Fabric v2 对齐：

```text
FabricFrame {
  kind: OPEN | INCOMING | ACCEPT | DATA | WINDOW_UPDATE | FIN | RESET | PING | PONG
  streamId
  value
  payload
}
```

- Relay 可读 `kind/streamId/value` 和 OPEN 中的 opaque route admission，以完成路由、flow bookkeeping 与拒绝；
- OPEN/ACCEPT 的 secure hello 是不透明 bytes，不携带 method、path、MIME 或业务 status；
- DATA payload 是 Secure Stream ciphertext；WINDOW_UPDATE、FIN、RESET 只描述通用 stream 状态；
- Relay 不解密、不反序列化业务 payload，也不根据业务类型分配 lane 或 priority。

建议初始边界：

```text
MAX_WIRE_FRAME_BYTES          = 16 * 1024   // 完整 Fabric frame；不含 WS/TLS 外层
MAX_OPEN_PAYLOAD_BYTES        = 8 * 1024    // route admission + secure hello
MAX_SEMANTIC_HEAD_BYTES       = 8 * 1024
MAX_CONTROL_PAYLOAD_BYTES     = 1 * 1024
INITIAL_STREAM_WINDOW_BYTES   = 256 * 1024
MAX_SOCKET_BUFFERED_BYTES     = 64 * 1024
MAX_ENDPOINT_BUFFERED_BYTES   = 4 * 1024 * 1024
```

业务 DATA 的实际 plaintext chunk 小于 16 KiB，由 provider 扣除 Fabric header、secure record 和 AEAD tag 后计算；业务永远不硬编码 chunk 大小。route admission 或 secure hello 超出 OPEN 上限就明确失败，不能借 OPEN 传大 metadata。

16 KiB 是简单、成熟的起点：HTTP/2 默认 frame payload 为 16,384 bytes，[RFC 9113](https://www.rfc-editor.org/rfc/rfc9113)；TLS 1.3 plaintext record 上限为 2^14 bytes，[RFC 8446](https://www.rfc-editor.org/rfc/rfc8446)。这只是量级参考，不假设 GeneHub frame 与 TLS record 一一对应。

WebSocket 自身允许 fragmentation 和 control-frame interleaving，但浏览器 API 不提供可依赖的底层调度，因此 GeneHub 仍需自己保持小 frame，[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)。第一版不协商更大的 frame；需要吞吐时先调整 window 和并发。

### 4.1 公平与内存

固定 frame 上限后，第一版使用最简单的等权 round-robin：每个 runnable stream 每轮最多发送一个 DATA frame；没有竞争者时单 stream 可以连续跑满 carrier。无需权重、deficit 或业务 priority。

每 stream 使用独立 bounded send/receive queue 与 wire credit。endpoint 另设总内存和 active-stream 上限；接近总预算时停止接收新 stream 或停止为已有 stream 补 credit，不再增加一套 endpoint-level wire credit。

```text
carrier reader
  -> parse one bounded Fabric frame
  -> verify/decrypt Secure Stream payload
  -> update stream state / bounded receive queue
  -> return

handler task
  <-> one stream buffer
  <-> bounded async or blocking IO pool

round-robin scheduler
  -> one ready frame per runnable stream
  -> bounded carrier writer queue
  -> WebSocket.send
```

硬规则：

1. reader 不 `await` handler，也不写无界 channel；receive queue 满后只停止该 stream 的 credit。
2. writer 不读取文件、不拉取业务 generator；handler 只能向自己的 bounded stream buffer 写入。
3. 每个 accepted stream 有独立 task，并受全局 semaphore、deadline 和内存预算限制。
4. 阻塞文件/Git/进程 IO 进入有界 blocking pool；卡住只影响当前 stream。
5. `WebSocket.bufferedAmount` 达到上限后 writer 暂停取 frame，业务不能把完整 body 预灌进 socket。
6. malformed frame、未知状态转换和超限输入明确 RESET stream 或关闭 endpoint，不尝试猜测旧协议。

## 5. E2EE 与 Relay 保密性

endpoint admission 与 peer authentication 必须分开：

- endpoint admission 只允许 browser/CLI/daemon/service 接入 local endpoint 或 Relay Fabric，并限定 endpoint lease；
- route admission 只允许建立到某个 opaque target 的一次 stream；
- Secure Stream handshake 才证明远端 peer identity，并建立 payload E2EE；
- Exchange capability 最终证明这个 peer 是否能操作某 workspace/path。

逐 stream crypto state 复用现有配对设备身份、hosted channel secret 与 domain-separated E2EE 构造。每个方向和 stream 有独立 key/nonce/sequence 域；重复 sequence、认证失败、串 stream ciphertext、过期 admission 与未知 epoch 均 fail-close。不能再使用一条 legacy WebSocket 的全连接业务 sequence。

Relay 可以观察 endpoint/route/stream id、frame kind、长度和时序；看不到 secure hello、Exchange head/body、path、MIME 或业务错误。Hosted Control 可能知道账号、设备、placement，当前也可能参与 channel secret 编排。因此准确承诺是“Relay 单独不能解密”，不是隐藏全部元数据或平台零知识。

连接身份仍不代替业务授权：每个 Exchange 携带短期 capability，daemon handler 校验 workspace、path、operation 与 placement generation。Relay/Control 的 route 通过不能扩大文件权限。

## 6. Semantic framework：只保留 Exchange 与 Duplex

### 6.1 Exchange：所有客户端主动请求

一次普通主动请求占一条短生命周期 `SecureDuplexStream`：

```text
RequestHead {
  version
  method
  metadata
  bodyLength?
  timeoutMs?
}
RequestBody(bytes...)
RequestEnd

ResponseHead {
  status
  metadata
  bodyLength?
}
ResponseBody(bytes...)
ResponseEnd
```

request/response 由 stream identity 关联，不再维护全连接 request id、pending sequence 或“大请求专用 WebSocket”。head 使用有确定边界的版本化 encoding，硬上限 8 KiB；body 始终可流式，已知长度时 daemon 可在读取前拒绝超限。

第一版明确不做 trailers、header compression、`expect-continue`、priority、通用 retry 或幂等框架。提供一个小对象 `unary()` convenience wrapper，默认最多聚合 256 KiB；超过就使用 streaming body。业务 status 放 ResponseHead；取消、deadline 和资源超限映射单 stream RESET；endpoint authentication 或 framing 错误才关闭 carrier。

### 6.2 DuplexStream 与 MessageChannel

PTY、订阅和其他持续双向交互直接使用长生命周期 `SecureDuplexStream`。需要消息边界时，在字节流上使用有独立 message 上限的 length-delimited `MessageChannel`；它是 codec，不是新 transport。

第一版由 client 主动打开 subscription Duplex，daemon 在同一 stream 回推事件；订阅控制和事件不再穿插进全连接 special envelope。这样不需要立即设计 server-initiated route admission。以后若确有需求，`incomingStreams()` 已保留通用能力。

### 6.3 业务映射

| 当前能力 | 新模型 |
| --- | --- |
| 普通 query/mutation | unary Exchange |
| blob、snapshot/backfill、较大 request/response | streaming Exchange |
| `session.send` | Exchange；持续 Agent 事件走 subscription Duplex |
| subscribe/unsubscribe 与事件 | client-opened Duplex MessageChannel |
| PTY open/write/resize/close | 一条 client-opened Duplex MessageChannel |
| `file.tree` / `file.write` | Exchange |
| `file.read` / `FileContent` | 删除；用户查看统一为 `asset.preview` Exchange |
| Cloud WebRoot GET/HEAD | Gateway 发起 `asset.web.*` Exchange |
| SNI raw TCP tunnel | Edge 发起 `tls-tcp/1` Duplex |

业务表里没有 WebSocket、lane 或 DataChannel。

## 7. 全量 legacy 迁移

迁移目标是 Web、daemon、proto、Relay 与 Control 的整个旧数据路径，不只是 `file.read`。

### 7.1 一次切换，不留 fallback

开发可以在未发布的分支中分步建设，但可交付产物必须原子完成以下事项：

1. 以现有 Fabric v2 为基础补齐 `TransportEndpoint` contract、16 KiB frame、公平 writer、Secure Stream、Exchange/Duplex 和 handler registry。
2. 将 `Hello` 拆到 endpoint admission 与 Secure Stream handshake；将 `device.claim` 等受限引导操作迁为 restricted bootstrap Exchange。
3. 逐项迁移 Web、daemon、local、hosted、配对/认领、Agent、PTY、push、测试与开发工具的全部调用点。
4. daemon hosted/local transport 统一接入 Fabric endpoint；Relay/Control admissions 全部切到 `/fabric/v2`。
5. bump 应用协议版本，并让 Web、daemon、Relay 与 Control 只发送/接受新版本。
6. 删除 Web legacy `Client` 的 pending map、`sendChain`/`receiveChain` 和旧 codec；若仍需要小型 socket test interface，将其归入 WebSocket provider。
7. 删除 daemon legacy request loop、单体 `Request/Reply` 分发入口、业务 sequence 和 legacy uplink adapter；业务改为按 method 注册的 Exchange handlers。
8. 删除旧 proto envelope、`FileRead`/`FileContent`、daemon handler、Web store 字段及其旧协议测试。
9. 删除 Relay `/forward/client`、`/forward/daemon` endpoints、legacy channel frame/限额/代际 fence 和对应 Control admission；只保留 endpoint-neutral Fabric。
10. 仓库中不得存在运行时 dual stack、旧协议 feature flag、自动降级或“解析失败后试 legacy”的路径。

版本不匹配只在固定 Fabric/secure handshake 位置返回明确的 `upgradeRequired { supportedVersion }` 并关闭 stream/endpoint；客户端展示升级提示，不重试旧协议。被删除的 legacy HTTP/WS path 可以返回静态 410/426，但不能继续转发或解析旧 payload。

WebRTC 与 WebSocket 的 provider selection 不是协议 fallback：二者返回相同的 `SecureDuplexStream`，承载同一 Exchange/Duplex 业务协议。被删除的是 legacy wire；WebSocket Fabric 仍是 MVP 的正式基线 provider。

### 7.2 干净 cutover 的检查项

- 不再 import `packages/web/src/protocol/client.ts` 的 legacy `Client`；新连接入口只构造 `TransportEndpoint`。
- proto 不再导出单体 legacy wire `Request/Reply`，只保留 method payload schemas 与通用 semantic heads。
- daemon `router.rs` 不再对单体 enum 做大 match；handler registration 与 handler task 生命周期分离。
- Cloud Relay 不再暴露 legacy forwarding endpoints，也不读取任何业务 schema。
- `rg`、TypeScript/Rust compile、unit/integration/e2e 和跨版本拒绝测试共同证明无遗漏。

早期项目适合做这次协调切换。代价是混合版本不能工作，收益是仓库不会永久背两套协议、两套错误语义和两套测试矩阵。

## 8. MVP WebRTC direct provider

### 8.1 可行性与边界

MVP 实现 WebRTC 是可行的，但“实现 RTC 直连”和“任何网络都保证 RTC connected”是两个目标。浏览器的 `RTCDataChannel` 原生提供通用双向数据传输，并可配置为 reliable + ordered，[W3C WebRTC](https://www.w3.org/TR/webrtc/) 与 [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831)。daemon 侧则需要 ICE、DTLS、SCTP 与 DataChannel 栈；仓库当前没有这类依赖，因此必须先完成 Phase 0 技术门禁。

Rust 候选优先评估 [webrtc-rs](https://github.com/webrtc-rs/webrtc)：它覆盖 PeerConnection/ICE/DataChannel，并适配当前 Tokio daemon。若其构建、平台或控制面不满足要求，再评估 Sans-I/O 的 [str0m](https://github.com/algesten/str0m)。具体依赖和版本是 adapter 内部决策，公共协议不绑定某个库。

首版只做 host 与 server-reflexive ICE candidates，并使用受控 STUN；不部署 TURN。RTC 能在很多网络直连，但 UDP 被限制、NAT 组合不利或网络切换时可能失败。此时 WebSocket baseline 继续提供可达性。若产品目标升级为“所有网络尽量保持 RTC transport”，则必须加入 TURN、短期 relay credential、UDP/TCP/TLS 入口、容量与滥用治理，这不属于当前 MVP。

无论 DataChannel 自带 DTLS，GeneHub 仍在其 payload 内运行同一 Secure Stream E2EE。这样 peer identity、capability 与加密承诺不依赖 provider；将来即使经过 TURN，中继也只看到网络元数据和密文。

### 8.2 一个 PeerConnection、一个 DataChannel

每个活跃 remote browser/CLI 与 daemon peer 最多建立一个 PeerConnection，并在其上建立一个固定的 reliable、ordered DataChannel：

```text
PeerConnection(peer A ↔ peer B)
  └─ RTCDataChannel "genehub.fabric.v1" (ordered, reliable)
       └─ existing bounded Fabric frame mux
            ├─ logical stream 1 -> Exchange
            ├─ logical stream 2 -> Exchange
            └─ logical stream 3 -> Duplex
```

DataChannel 只是 frame carrier。WebSocket 与 RTC 使用相同的 Fabric frame、stream state、Secure Stream、credit、公平 scheduler 和 Exchange/Duplex codec；RTC provider 不复制业务协议。首版不做每 logical stream 一个 DataChannel，否则会把 stream 数、SCTP 调度和 provider 差异泄漏到上层，也会显著扩大互操作测试面。

RTC writer 同样尊重 16 KiB wire frame 与 bounded queue，并用 `RTCDataChannel.bufferedAmount`/low-water signal 做 carrier backpressure。不要依赖浏览器或 SCTP 帮 GeneHub 实现跨 logical-stream 公平性。

### 8.3 私密 signaling 与 STUN 元数据

WebSocket endpoint 先完成 admission 与 Secure Stream setup，然后打开内部 `rtc.signal/1` Duplex，承载 offer、answer、trickle ICE candidate 与 restart 消息：

```text
browser ── E2EE rtc.signal/1 over WebSocket Fabric ── daemon
   │                                                     │
   └──────────── ICE connectivity checks / STUN ─────────┘
```

- Relay 只转发 signaling stream ciphertext，不解析 SDP、candidate 或设备地址；
- Control 只下发受控 STUN 配置与 opaque route admission，不代替 peer authentication；
- daemon 仅对已授权 peer 的 signaling 作答，并限制每 peer 的 pending offer、candidate 数、消息大小、频率和总 PeerConnection 数；
- glare 使用固定角色解决，例如 daemon 为 polite peer；ICE restart 有次数与退避上限；
- SDP、candidate、私网/公网 IP 不进入日志、telemetry 或 Settings UI。

E2EE 不会隐藏所有网络元数据：STUN 服务会看到发起端公网地址，直连 peer 必然能获知连接候选/地址，Relay 仍能看到 signaling 的长度和时序。产品隐私说明必须准确披露，而不能声称 WebRTC 零元数据。

### 8.4 provider 选择与失败语义

provider 选择只依赖连接状态，不依赖 method、文件类型、大小或业务优先级：

1. local/loopback 始终使用 local WebSocket，不建立 RTC；
2. remote WebSocket 先可用，RTC enabled 时后台协商；
3. RTC connected 后，新 logical streams 绑定 RTC；既有 WebSocket streams 原地完成；
4. RTC failed/disconnected 后，在途 RTC streams 明确 RESET/失败，之后新 streams 绑定 WebSocket；
5. 不跨 provider 迁移、不复制 bytes、不自动重放未知结果的 mutation。

这不是 legacy fallback：两条 provider 承载同一个当前协议。WebSocket 是产品的正式 baseline transport；被完全删除的是旧 wire、旧 endpoints 与旧 codec。

### 8.5 Settings：client-local 开关与动态状态

RTC 开关属于查看端的本地偏好，默认开启，并像主题设置一样存于当前 browser/CLI，而不是写入 daemon 的 machine-level settings。一台手机关闭 RTC 不应改变同账号笔记本的选择。daemon 在 secure handshake 中广告 `rtcSupported`，但不能远程改动用户开关。

Settings 新增“连接”区域，直接订阅 `TransportEndpoint` 的动态状态；状态不是持久配置：

```text
TransportStatus {
  active: loopback | webrtcDirect | websocketRelay
  rtc: disabled | unsupported | signaling | checking | connected | failed
  reason?: daemonUnsupported | browserUnsupported | iceTimeout |
           signalingFailed | networkChanged
}
```

UI 使用低基数、可行动的文案：

| 场景 | 主状态 | 辅助说明 |
| --- | --- | --- |
| 本机 | 本机连接 | 无需 WebRTC |
| 开关关闭 | WebSocket 中继 | RTC 已关闭 |
| 协商中 | WebSocket 中继 | 正在建立 RTC 直连 |
| 已连通 | WebRTC 直连 | 可显示最近连接时间，不显示地址 |
| 失败 | WebSocket 中继 | RTC 连接超时/网络变化，可重试 |
| 不支持 | WebSocket 中继 | 当前浏览器或 daemon 不支持 RTC |

关闭开关后停止新 RTC streams，给已有操作一个有界 drain 时间，再关闭 PeerConnection；不自动重放未确认 mutation。重新开启会在 WebSocket endpoint 就绪后开始一次受限协商。Settings 可以提供显式“重试 RTC”，但不能显示 SDP、candidate、IP 或内部错误堆栈。

## 9. MVP 实施顺序

### Phase 0：RTC 技术门禁

- 在 daemon 的独立 adapter 中以 webrtc-rs 为第一候选，完成 browser↔daemon DataChannel spike；不让候选库类型进入公共接口；
- 验证 Chrome/Edge、Firefox、Safari/iOS 与目标 daemon OS/cross-build；覆盖 LAN、跨 NAT/STUN、UDP 受限和网络切换；
- 通过 16 KiB frames、2 MiB Preview、多个并发小 Exchange、backpressure、cancel、disconnect 与 reconnect 测试；
- 审核 signaling E2EE、依赖许可、二进制体积、CPU/内存和崩溃边界。

Phase 0 是 MVP gate，不是可静默延期的探索项。若候选实现未通过，先修正 adapter/库选择与范围；不能对外宣称 MVP 已包含 WebRTC。

### Phase A：统一 TransportEndpoint 与两个 provider

- 以现有 `/fabric/v2` 为基础完成 WebSocket provider、Secure Stream、16 KiB frame、公平 writer、有界队列与 handler 隔离；
- 实现 WebRTC provider、E2EE `rtc.signal/1`、受控 STUN、provider routing 与统一状态机；
- fake、WebSocket 与 WebRTC provider 必须通过同一 endpoint/stream contract suite。

### Phase B：Semantic framework 与 Settings

- 实现最小 Exchange、Duplex/MessageChannel；用一个小 unary method 与 `asset.preview` 验证小响应和 2 MiB streaming response；
- 增加 client-local RTC toggle、连接状态、显式重试和隐私文案；
- 按迁移表覆盖所有主动请求、push、Agent、PTY、配对/认领与开发工具，中间双协议状态不发布。

### Phase C：跨组件原子 cutover 与删除

- 同一协调交付中 bump version，切换 Web/daemon/proto/Relay/Control 默认入口，并删除全部 legacy 类型、endpoint、handler、Client、adapter 与测试；
- 用静态搜索、编译、端到端和跨版本拒绝测试证明没有 fallback 或遗漏调用点；
- 旧客户端只得到升级提示或静态 410/426；通过 gate 后才合并或发布。

### Phase D：轻量 Preview 完成

- 完成 2 MiB exact-or-error handler、独立 Viewer、图片/Markdown/text/单文件 HTML/小视频；
- 在 WebSocket 与 RTC provider 路径各跑 Preview、取消、并发小请求与 daemon 离线测试；
- 保持 Viewer provider-neutral，不为 Preview 加专用 transport、priority 或 retry。

## 10. 验收标准

架构与迁移：

- 业务代码只依赖 Exchange/Duplex；只有 provider adapter import `WebSocket`、`RTCPeerConnection` 或 daemon RTC 库。
- fake、真实 WebSocket 与真实 WebRTC provider 通过同一 endpoint/stream contract tests；切换 provider 不修改 handler。
- Fabric/Relay 模块中没有 method、path、MIME、Preview、PTY 或业务 priority。
- 仓库中不存在 legacy `Client` 运行路径、旧 `Request/Reply` wire codec、legacy Relay endpoints、`FileRead`/`FileContent`、compat adapter 或 fallback 分支。

隔离与资源：

- 两个 carrier 上每个 GeneHub Fabric frame 都 `<= 16 KiB`；一次写 2 MiB 自动切片。
- 一个持续 2 MiB producer 与多个小 Exchange 并发时，小 Exchange 持续推进，不等待大 body 完成。
- handler 停止读写或阻塞 IO 时，carrier reader/writer 与其他 streams 继续推进。
- per-stream queue/credit、endpoint memory、active tasks、socket/DataChannel buffer 和 RTC signaling 全部有硬上限。

RTC 与产品状态：

- RTC 默认开启；开关只影响当前 client，关闭后不再建立新 RTC streams，重新开启可受限重试。
- 支持网络直连时 Settings 最终显示 `WebRTC 直连`；直连失败时显示原因类别并保持 `WebSocket 中继` 可用。
- WebSocket→RTC readiness 或 RTC→WebSocket failure 不迁移、不复制、不自动重放已有 stream。
- Relay 抓包和日志看不到 SDP、candidate、peer secure hello、Exchange method、workspace path、MIME、status 或 body；STUN/peer 可见的地址元数据在产品说明中被准确披露。

协议与 Preview：

- 所有客户端主动调用均为独立 Exchange stream；PTY 与订阅各占独立 Duplex，不再复用 legacy event/request envelope。
- 协议不匹配明确 `upgradeRequired` 后断开，不静默重试旧 wire。
- `asset.preview` 在 WebSocket 和 RTC 路径均满足 2 MiB exact-or-error、安全路径解析、取消与公平性要求。

结论：MVP 同时交付“一套 provider-neutral E2EE 协议、WebSocket baseline、WebRTC direct、完整 legacy cutover、轻量 Preview”。WebRTC 是真实首发能力；TURN、全网络 RTC 保证和复杂迁移机制留到明确需要时再扩展。
