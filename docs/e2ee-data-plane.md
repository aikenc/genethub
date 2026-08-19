# E2EE Data Plane v3

> 状态：MVP 已实现并通过全量验证，作为 validated candidate 提交。Asset Preview 的产品契约见 [轻量 Asset Preview](./assets-quick-preview.md)，Relay 信任边界见 [安全模型](./security-model.md)。

## 1. 结论

GeneHub 现在只有一套当前数据面协议：**protocol v3**。它把业务语义与物理连接分开，并在一个已认证的 peer link 内复用有界 logical streams。

```text
业务层             RPC / events / asset.preview / shell.run / rtc.negotiate
                         │
语义层             Exchange request/response + 长事件流
                         │
DataEndpoint       有界 frame、logical stream、credit、公平发送、取消
                         │
E2EE peer link     PSK 双向证明、AES-256-GCM record、严格方向序号
                  ┌──────┴────────┐
carrier        WebSocket        WebRTC DataChannel
              local/Fabric        direct
```

MVP 的取舍如下：

- 本地连接使用 daemon 的 loopback WebSocket `/ws`。
- 跨设备基线使用 endpoint-neutral `/fabric/v2` WebSocket；浏览器和 daemon 都只建立长期 Fabric endpoint，Relay 在其中路由短生命周期 outer streams。
- 每个 browser/CLI peer 在一条 outer stream 内完成一次 E2EE handshake；随后在同一个 `DataEndpoint` 内复用多条业务 logical stream。
- 每个客户端主动请求占一条独立 logical stream。一个大 Preview 不会占住其他请求的应用层队列。
- 事件使用一条长期 logical stream；现有 PTY 控制仍是独立 RPC exchange，PTY 输出由事件流推送。MVP 不再为了形式统一增加一套公开 Duplex API。
- 远端连接且双方支持时，在 E2EE 基线连接内协商一条 WebRTC DataChannel。RTC 连通后，新请求优先走 RTC；失败时基线 WebSocket 仍是正式 transport，不是旧协议 fallback。
- 不实现多 WebSocket lane、TURN、trickle ICE、live stream migration、自动重放、业务 priority 或通用重试框架。

这套设计的稳定抽象是 `DataEndpoint` 与 `Exchange`，不是 WebSocket。未来增加 WebRTC 配置、TURN 或其他 carrier 时，不改变业务 method 和 Preview 契约。

## 2. 实际连接模型

### 2.1 本地

```text
Web/Desktop ── loopback WebSocket /ws ── daemon
                 peer hello/welcome
                 E2EE DataEndpoint
```

loopback admission 使用 owner-only、短期、单次核销的 proof；本地连接仍完成双向证明和 v3 framing。RTC 对 loopback 没有收益，因此状态显示“本机直连，无需 RTC”。

### 2.2 托管或自建跨设备

```text
browser Fabric endpoint ─┐
                         ├─ Relay /fabric/v2 ─ daemon Fabric endpoint
                         │       opaque route
                         └─ one routed peer carrier
                                  └─ E2EE DataEndpoint
                                       ├─ RPC stream A
                                       ├─ Preview stream B
                                       ├─ RPC stream C
                                       └─ events stream
```

Fabric v2 只负责 endpoint admission、opaque route、outer stream、credit 和转发。每个 routed peer carrier 再承载 protocol-v3 logical streams。这样 Relay 不需要知道 method、workspace、path、MIME、status 或业务 body。

这里的“短连接”指 logical stream，不是每个请求重建 TCP、WebSocket 或 PeerConnection。建立新请求只分配 stream id 和有界状态。

### 2.3 WebRTC direct

```text
browser ── encrypted rtc.negotiate Exchange over baseline ── daemon
browser ═════ ordered reliable DataChannel genehub-data-v3 ═════ daemon
                       fresh short-lived PSK handshake
                       same v3 DataEndpoint and Exchange
```

MVP 使用一次非 trickle SDP offer/answer：双方等 ICE gathering 完成后，通过已经 E2EE 的 `rtc.negotiate` exchange 交换 SDP。默认只配置 Cloudflare STUN，不配置 TURN，所以部分 NAT/企业网络下会失败。

RTC DataChannel 自身有 DTLS 加密；GeneHub 仍在其上完成新的短期 PSK 双向证明并继续使用相同的 AES-GCM record。这保持 carrier-neutral 的端到端身份语义，也防止“拿到 SDP 就获得业务权限”。RTC admission 继承基线 peer 的设备和 workspace scope，30 秒后未完成认证会自动回收。

MVP 资源边界：daemon 同时最多保留 32 个 RTC peer，入口队列 16 个 16 KiB record。RTC 开关保存在当前浏览器：关闭会立即关闭 RTC；重新开启会在当前 ready 基线连接上重新协商。状态为：`disabled / unavailable / standby / connecting / connected / failed`。

RTC 中断时，在途 RTC stream 明确失败；之后的新请求走仍然存活的基线 endpoint。系统不会把可能已执行的请求自动重放到另一 carrier。

## 3. Peer authentication 与 E2EE

每个 peer carrier 的第一条应用消息是有界 JSON `PeerHello`：

```text
PeerHello {
  version: 3,
  clientName,
  rtcSupported,
  auth: loopback | device | hosted | invite
}
```

`auth` 包含 credential/capability 的选择器、client nonce 和 HMAC proof。daemon 返回 `PeerWelcome { version, serverNonce, proof }`。双方用已有的配对 PSK、hosted channel secret、loopback proof 或 RTC 临时 secret 验证对方，并从两个 nonce 派生本次连接的 256-bit session key。

握手成功后的每个 carrier message 都是一个最多 16 KiB 的 binary AEAD record：

```text
SecureRecord {
  magic, version, directionSequence,
  AES-256-GCM(
    DataFrame,
    nonce = direction || sequence,
    AAD = protocolVersion || credentialContext || direction || sequence
  )
}
```

每个方向使用严格递增、连接级 sequence。乱序、重复、版本不符、tag 失败或超限都会 fail-close 当前 peer endpoint。AES-GCM 已同时提供机密性与完整性；HMAC 用于 handshake 和 key derivation，不再给每条密文叠加独立 MAC。

MVP 是**每个已认证 peer link 一套 E2EE session**，不是每条 logical stream 单独派生密钥。stream id 位于 AEAD 密文内，因此 Relay 看到的 Fabric outer stream 与内部业务 stream 不同，也不能根据内部 stream 区分业务。

### Relay 能看到什么

准确的承诺是“Relay 单独没有业务密钥，且数据路径不解析或持久化业务内容”，不是隐藏全部流量元数据：

- 可见：来源 IP、endpoint/route/outer stream opaque handle、连接时间、record 长度与时序。
- Fabric OPEN 中的 `PeerHello` 作为 opaque bytes 被原样转发；Relay 实现不解析它，但恶意 Relay 技术上可查看其中的版本、通用 client label、RTC capability、credential/capability 选择器、nonce 和 proof。
- 不可见：握手 secret、派生 session key、内部 logical stream id、Exchange method/metadata/status、workspace/path/MIME、Preview bytes、RPC、事件和 PTY 内容。
- RTC connected 后，业务 record 不经过 Relay；Relay 仍参与基线 signaling 和 presence。

托管 Control 负责发行或兑换 hosted secret，因此当前系统不是“平台整体零知识”，也没有前向保密。Relay 与 Control 仍是分离信任边界；只攻破 Relay 不能解密或伪造业务 record。

## 4. Data frame 与流控

解密后的 v3 frame 有固定 16-byte header：

```text
version:u8 | kind:u8 | flags:u16 | streamId:u32 | value:u32 | length:u32 | payload
```

`kind` 只有：`OPEN / HEAD / DATA / WINDOW_UPDATE / FIN / RESET / PING / PONG`。

固定边界：

| 边界 | 值 |
|---|---:|
| 完整 E2EE record | 16 KiB |
| record header | 12 bytes |
| AES-GCM tag | 16 bytes |
| DataFrame header | 16 bytes |
| 单 DATA plaintext payload | 16,340 bytes |
| Exchange head | 8 KiB |
| 初始 stream credit | 256 KiB |
| endpoint active streams | 256 |
| 通用 finite response body | 64 MiB |
| Preview source/body | 64 MiB |

client-opened stream 使用奇数 id，server-opened stream 预留偶数 id，0 只用于 endpoint control。所有已知长度的 request/response 都在 FIN 时核对精确长度；无 head 的 response DATA、序号跳跃、credit 溢出和非法状态转换都会被拒绝。

发送端按 stream 维护队列，并以简单 round-robin 每轮发送一帧。每条 stream 有独立 256 KiB credit；只有消费者取走 bytes 才返回 `WINDOW_UPDATE`。Web 与 daemon 同时有 endpoint、carrier 和 handler 队列上限。

daemon carrier reader 只做 record 验证、frame decode 和有界入队，不等待文件 IO、Agent 或业务 handler。每条 incoming stream 在独立 task 中处理；Preview 文件读取进入最多 2 路的 blocking worker 槽。因此慢 IO 只占用自己的 stream/window，不堵塞连接 reader。

## 5. Exchange 语义

每次主动操作使用一条 logical stream：

```text
OPEN  RequestHead { version, method, metadata, bodyLength?, timeoutMs? }
DATA* request body
FIN

HEAD  ResponseHead { status, metadata, bodyLength?, error? }
DATA* response body
FIN
```

head 是最多 8 KiB 的 UTF-8 JSON；body 是原始 bytes，不做 base64。method、metadata 和 body 都处于 E2EE record 内。MVP 注册的方法是：

- `rpc`：现有业务 `Request/Reply` schema 作为 exchange body；它已不再是连接层 envelope，也没有全连接 request id、pending sequence 或 authenticated wrapper。
- `events`：一个长期 response body，消息使用 `u32be length + JSON`。
- `asset.preview`：文件系统 Preview，见下文档。
- `shell.run`：在 workspace 内执行一条命令。request body 是命令的 stdin（可以为空），response body 是 `u32be length + JSON` 的 `ShellFrame` 序列（`stdout` / `stderr` / 末帧 `exit`）。stdin 随请求一次给全而不是边打边送：命令必须等输入齐了再启动，否则先读的那一方会读到一个提前到来的 EOF；要让输入取决于命令的输出，那是终端而不是这里。
- `rtc.negotiate`：E2EE SDP 协商。

保留 `Request/Reply` 作为业务 schema 是刻意的最小迁移，不是 legacy transport fallback。连接层、加密、关联、并发、背压和取消已经全部由 v3 stream 承担。

## 6. 版本切换与删除项

这是一次 clean cutover：

- 删除旧 Web connection-wide JSON envelope、request id、authenticated wrapper 和全连接 send/receive sequence。
- 删除 daemon legacy session/uplink transport。
- 删除 Relay `/forward/client`、`/forward/daemon`、legacy authority、wire codec 和测试。
- 删除 Cloud legacy channel/uplink admission API 与数据路径。
- 删除 `file.read` / `FileContent`；用户可见读取改为 `asset.preview`。
- CLI、测试工具、self-hosted journey 全部迁到 v3。

没有 runtime dual stack、解析失败后尝试旧协议、旧 endpoint 或兼容 feature flag。版本不匹配在固定 handshake 位置直接关闭；MVP 不虚构尚未实现的结构化 `upgradeRequired` response。

WebSocket baseline 与 RTC direct 是同一当前协议的两个 carrier。RTC 不可用时使用 WebSocket，不属于协议降级。

## 7. MVP 验收

- Web、daemon、CLI、Relay、Cloud Control 使用同一 v3/Fabric 契约，跨语言 frame golden vector 一致。
- 同一 peer 的两个大/小 exchange 能公平推进；无效序号、长度、credit、stream transition 均 fail-close 或 reset。
- handler/Preview IO 不运行在 carrier reader；队列、stream、RTC peer 和文件大小均有硬上限。
- RTC 开关和六态状态可见；支持网络可 direct，不支持或失败时基线仍可用。
- Relay 代码不 import 业务 schema，数据路径不做 JSON parse/stringify，不依赖数据库。
- 旧 forwarding endpoint、wire、daemon transport、Web envelope 和 `file.read` 不存在运行路径。
- 完整 self-hosted 真实进程旅程能够让两台独立配对客户端通过同一个 Preview URL locator 读取完全相同的文件 bytes。

## 8. 明确留到后续

- TURN 和可配置 ICE policy；
- trickle ICE、ICE restart、网络切换和 RTC 自动重试策略；
- 前向保密的公钥握手；
- 多 carrier 并行调度或 live stream migration；
- 通用 streaming upload、大文件 Range/overview；
- 多文件 HTML/WebRoot、云端资产缓存、Service Worker；
- 将 PTY 重构成公开的通用 Duplex API。

这些能力都可以在现有 `DataEndpoint`/Exchange 边界之上演进，不需要让业务重新依赖 WebSocket 或 Relay。
