# Relay：endpoint-neutral Fabric v2

> 状态：protocol-v3 MVP 已实现。Relay 只有 `/fabric/v2` 一条 WebSocket 数据入口；旧 `/forward/client` 与 `/forward/daemon` 已删除。

## 1. 职责边界

Relay 是有界的 opaque byte router：

| Relay 做 | Relay 不做 |
|---|---|
| 验证 endpoint admission | 不持有配对 PSK 或 hosted channel secret |
| 用 opaque route ticket 找 target endpoint | 不知道 account、machine、workspace、method 或 path 的业务含义 |
| 转发 Fabric frame、维护 outer stream credit | 不解密 protocol-v3 record |
| endpoint presence、generation fence、revocation | 不执行业务授权、文件读取或 RTC signaling 解析 |
| 心跳、背压、容量和超时 | 不存业务数据，不依赖数据库 |

公开 HTTP 只有：

| path | 用途 |
|---|---|
| `GET /api/health` | liveness 与当前 Fabric 统计 |
| `GET /api/ready` | authority/revocation 同步完成后 200，否则 503 |
| `GET /fabric/v2` + WebSocket upgrade | 所有 browser、CLI、daemon endpoint 的唯一数据入口 |

其他 WebSocket upgrade 返回 404。Relay 不提供 Preview HTTP URL，也不是 Assets Gateway。

## 2. Fabric 拓扑

```text
browser/CLI endpoint ── WebSocket /fabric/v2 ─┐
                                              ├─ Relay FabricCore
daemon endpoint      ── WebSocket /fabric/v2 ─┘
                              │
                              └─ opaque routed outer streams
                                   └─ peer hello + E2EE v3 records
```

一条物理 endpoint WebSocket 可以同时拥有多条 outer stream。browser 以 `OPEN(routeTicket, opaqueHello)` 发起；Relay 向 target 改写 stream id 并发送 `INCOMING(opaqueHello)`。target `ACCEPT(opaqueWelcome)` 后，两端使用 `DATA / WINDOW_UPDATE / FIN / RESET`。

Fabric outer frame：

```text
version:u8 | kind:u8 | flags:u16 | streamId:16 bytes | value:u64 | payload
```

frame kinds 为 `OPEN / INCOMING / ACCEPT / DATA / WINDOW_UPDATE / FIN / RESET / PING / PONG`。outer stream id 是 Relay 路由状态，不是 E2EE 内部 logical stream id。Relay 对两侧重写 id，避免全局 id namespace 和跨 socket 混淆。

Fabric v2 的默认 receive credit 是 256 KiB。daemon/browser 的 peer adapter 把单个 protocol-v3 record 限制为 16 KiB；Relay 自身 `RELAY_MAX_FRAME_BYTES` 的默认 4 MiB 是通用 Fabric 防护上限，不代表当前业务会发送 4 MiB frame。

## 3. 准入模式

### 3.1 托管 control 模式

Relay 不自己判断身份，而是通过极小的 authority contract 请求 Control：

```ts
interface FabricAuthority {
  authorizeEndpoint(credential): Promise<FabricEndpointGrant | null>
  authorizeRoute(sourceEndpointHandle, routeTicket): Promise<FabricRouteGrant | null>
  reportEndpointPresence(endpointHandle, generation, state): Promise<void>
  onFabricRevoked(handler): void
}
```

Control 返回的只有随机 opaque handles、expiry、presence lease 和 generation；Relay contract 中没有 account、workspace 或业务 schema。Control 连接或 revocation stream 失联时 Relay fail-closed：拒绝新 admission，并关闭当前 endpoints，避免在失去撤销信息后继续转发。

browser 因 WebSocket API 不能设置 Authorization，使用 query 中短期、单次 endpoint ticket。daemon 可使用 bearer 或 ticket URL。OPEN 中另有单次 route ticket；两类 credential 都有独立长度和 pending budget。

hosted peer E2EE secret 由 Control 分别交给 browser 并允许目标 daemon 兑换；Relay 只能看到 opaque capability selector，不能兑换 secret。

### 3.2 自建 rendezvous 模式

自建不需要数据库或账号：

- daemon 用 `<joinToken>.<32-hex-slot>` 接入；literal loopback listener 可省 join token。
- client endpoint 用 `client:<slot>` 接入；只有对应 node endpoint 当前 online 才允许。
- client OPEN 的 route ticket 就是同一个 slot；route 只允许 client → 当前 online node。
- endpoint/route credential 只负责 anti-abuse 和路由，不授予 daemon 权限。
- browser 仍必须在 opaque peer carrier 内证明 daemon 签发的 device/invite secret；daemon 本地设备表是最终授权者。

Relay 重启会丢失所有内存状态，daemon 和 client 重新连接即可。Relay 不落库。

## 4. E2EE 与可观察性

Fabric OPEN payload 由 `routeTicket + opaqueHello` 组成。Relay 必须读取 route ticket 才能选 target，只把 hello 当 bytes 转发。准确的隐私边界：

- Relay 可见来源 IP、opaque endpoint/route/outer stream handle、frame kind、长度和时序。
- 恶意 Relay 技术上可查看首个有界 `PeerHello` 的版本、通用 client label、RTC capability、credential/capability selector、nonce 和 HMAC proof；实现不会解析或记录它。
- Relay 不持有 proof 所需 secret，也看不到握手后 E2EE record 内的 logical stream、method、workspace/path/MIME、status、RPC、Preview、事件或 PTY 内容。
- record 使用严格方向 sequence 与 AES-256-GCM；Relay 重放、篡改或跨 peer 注入都会让 endpoint fail-close。
- RTC direct 成功后，新业务 record 不经过 Relay；加密的 SDP signaling 仍通过基线 Fabric。

所以可以承诺“Relay 单独不能读取或伪造业务内容”，不能承诺隐藏 IP、流量形状或全部握手元数据，也不能把它扩大成“托管平台整体零知识”。

## 5. 背压与资源边界

Relay 的边界按 endpoint、pending upgrade、pending OPEN、stream、socket buffer 和进程总 buffer 分开：

| 环境变量 | 默认 | 含义 |
|---|---:|---|
| `RELAY_MAX_FABRIC_ENDPOINTS` | 10000 | 在线 endpoint 上限 |
| `RELAY_MAX_FABRIC_PENDING_UPGRADES` | 256 | 等待 authority 的 raw upgrades |
| `RELAY_MAX_FABRIC_PENDING_OPENS_PER_ENDPOINT` | 32 | 单 endpoint 等待 route authorize 的 OPEN |
| `RELAY_MAX_FABRIC_PENDING_OPENS` | 1024 | 进程级 pending OPEN |
| `RELAY_MAX_FABRIC_STREAMS_PER_ENDPOINT` | 256 | 单 endpoint active outer streams |
| `RELAY_MAX_FABRIC_STREAMS` | 100000 | 进程级 active outer streams |
| `RELAY_MAX_FABRIC_GENERATION_FENCES` | 100000 | 防旧 admission 重放的 endpoint generation 记录 |
| `RELAY_MAX_FABRIC_STRIKES` | 8 | socket 协议错误阈值 |
| `RELAY_MAX_ADMISSION_CREDENTIAL_BYTES` | 4096 | header/query credential 上限 |
| `RELAY_MAX_FRAME_BYTES` | 4 MiB | Relay 接受的单个 Fabric frame 上限 |
| `RELAY_MAX_BUFFERED_BYTES` | 8 MiB | 单慢读 socket 的发送预算 |
| `RELAY_MAX_OUTBOUND_QUEUED_BYTES` | 64 MiB | 进程级等待发送回调预算 |
| `RELAY_HEARTBEAT` | 30 s | WebSocket heartbeat |
| `RELAY_FABRIC_PRESENCE_REFRESH_MAX` | 30 s | presence lease 最大刷新间隔 |

每个 outer stream 独立 credit；只有对端返回 `WINDOW_UPDATE` 才继续发送。慢读者超过单 socket 或全局预算时只关闭触发 socket，不将无界 bytes 留在 Node heap。

pending OPEN 在 authority 返回前用 per-endpoint/global limit 限制；同一 stream id 的并发 frame 会取消 reservation，迟到 grant 不能复活已 reset stream。endpoint generation、route expiry、revocation tombstone 和 connection object identity 防止旧连接或跨 socket frame 接管新状态。

## 6. 进程配置

```bash
RELAY_MODE=control \
RELAY_CONTROL_ORIGIN=https://control.example \
RELAY_CONTROL_TOKEN=... \
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8788 \
npm start
```

或自建：

```bash
RELAY_MODE=rendezvous \
RELAY_JOIN_TOKEN="$(openssl rand -hex 32)" \
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8080 \
npm start
```

关键配置：

| 环境变量 | 默认 | 规则 |
|---|---|---|
| `RELAY_MODE` | `control` | 只有精确 `rendezvous` 使用自建 authority |
| `RELAY_HOST` | `0.0.0.0` | 对外部署由反向代理终止 TLS |
| `RELAY_PORT` | `8788` | 可设 0 让 OS 分配测试端口 |
| `RELAY_CONTROL_ORIGIN` | 无 | control 模式必填；非 literal loopback 必须 HTTPS |
| `RELAY_CONTROL_TOKEN` | 无 | control 模式必填 |
| `RELAY_JOIN_TOKEN` | 无 | rendezvous 绑非 literal loopback 必须为 32–256 个 base64url/hex 字符 |

公网必须经 HTTPS/WSS 反向代理；不要把 endpoint ticket 写入 access log。query ticket 是一次性短期材料，但仍应对 URL/query 做日志脱敏。Relay 日志只记录服务状态、容量和低基数错误，不记录 OPEN payload、proof、route ticket 或业务 bytes。

## 7. 代码边界与验证

CI/测试维持以下不变量：

- `forward/` 不能 import Web/daemon/proto 业务 schema。
- data path 不使用 `JSON.parse` / `JSON.stringify` 解释 payload。
- Relay package 没有数据库依赖。
- hosted authority wire 与 Cloud 镜像契约有 cross-repo 测试。
- invalid admission、revocation race、generation fence、route expiry、credit、慢读者、全局预算和 heartbeat 均 fail-closed。
- `/forward/*` 不再注册，旧 wire/authority/forwarder 文件和测试已删除。

Preview 不要求 Relay 增加任何分支：对 Relay 来说，它只是 E2EE peer carrier 中若干相同大小的 binary records。
