# relay

> 认证过的两端之间搬字节。除此之外它什么都不做，这是设计目标而不是待办事项。  
> 上层背景见 [architecture.md](./architecture.md) §6。

---

## 1. 它解决的唯一问题

你的机器在 NAT 后面。手机连不上它，另一台电脑上的浏览器也连不上。relay 是双方都能连到的汇合点：机器主动拨出去挂着一条连接，客户端连上来，relay 把两边接起来。

仅此而已。它不知道会话是什么，不知道用户是什么，不知道帧里装的是聊天还是终端输出。

---

## 2. 它不做什么，以及为什么

| 不做 | 为什么 |
|------|--------|
| 鉴权决策 | 判断票据有效需要账号与撤销状态，那是控制面的数据。relay 只执行答案 |
| 存储 | 存东西的 relay 就是需要被信任的 relay。它的全部状态是内存里的在线表，重启即空 |
| 解析 payload | 一旦开始理解流量，"它看不到内容"就不再是一句能验证的话 |
| 提供 HTTP 业务接口 | 除了 `/api/health`（liveness）与 `/api/ready`（readiness），只有两个 legacy WS 入口与一个 endpoint-neutral Fabric WS 入口 |

这些不是自律，是有测试守着的（`test/boundaries.test.ts`）：依赖方向、数据路径上不许出现 JSON 解析、依赖清单里不许出现数据库。

---

## 3. 端点

| 路径 | 谁连 | 凭证 |
|------|------|------|
| `GET /forward/daemon` (WS) | 机器上的 daemon | `Authorization: Bearer <一次性 uplink admission>` |
| `GET /forward/client` (WS) | 浏览器 / 手机 | `?ticket=<票据>` |
| `GET /fabric/v2` (WS) | 浏览器、CLI、daemon 等统一 endpoint | 短期 endpoint credential；一条连接复用多条 route |
| `GET /api/health` | 运维 | 无 |
| `GET /api/ready` | 部署 readiness；远端撤销流完成初始 sync 后才返回 200 | 无 |

客户端票据走查询串是不得已：浏览器发起 WebSocket 握手时无法设置请求头。

托管模式下，daemon 在**每次**连接或重连前，先把长期 enrollment secret 只发给 Control 的 HTTPS
`POST /api/relay/v1/uplink-admissions`，换回 60 秒内有效、一次性、只可用于 v1 uplink 的随机票据。
Relay 的握手、内存和日志边界只能接触这张短票；Control 在 `authorizeDaemon` 中原子核销它，不再接受
`<daemonId>.<secret>`。Control 暂时不可达或返回 5xx 时 daemon 退避重试换票，不会降级把长期 secret
交给 Relay；只有 Control 明确返回 401/403 才视为 enrollment 已失效。

---

## 3.1 两种模式

同样两个端点，票据的含义由 `RELAY_MODE` 决定：

| 模式 | 票据是什么 | 谁判断准入 |
|------|-----------|-----------|
| `control`（托管） | 控制面签发的一次性票据 | 控制面回答，relay 执行 |
| `rendezvous`（自建） | 就是 rendezvous id 本身 | **daemon 自己**，relay 只负责撮合 |

汇合模式下 relay 退化到最小：按 id 把两条 socket 接起来，不问任何人，不记任何事。机器挂上行连接时要出示 join token（`RELAY_JOIN_TOKEN`，票据形如 `<joinToken>.<rendezvousId>`）；客户端不需要，因为它只能连到一个已经存在的槽位。

这不会让 relay 变成信任锚：客户端与 daemon 会在通道建立之后互相证明一次身份（[security-model.md](./security-model.md) §4.2），抢占槽位的人答不出来。relay 能做的最坏的事仍然是"不转发"。

代码上这是**一个 `ChannelAuthority` 的另一种实现**，转发层一行都不用改——这正是把准入外包成一个接口的回报。

---

## 4. 帧格式

一条 WebSocket 连接上要跑多个客户端通道，所以每帧前面加十七个字节：

```
┌────────┬──────────────────┬─────────────┐
│ kind   │ channel id       │ payload     │
│ 1 byte │ 16 bytes         │ 不透明       │
└────────┴──────────────────┴─────────────┘

kind: 1=Open  2=Text  3=Binary  4=Close
```

relay 读前十七个字节，剩下的原样转发。方向是对称的：客户端发来的整条消息被包成一帧送进机器的上行连接，机器发来的帧拆掉头部送给对应客户端。

`Open` 由 relay 生成——它是"有个新客户端接进来了"的通知；`Close` 两个方向都可能发。

---

## 5. 与控制面的契约（仅 `control` 模式）

relay 只能问三个问题、订阅一件事，定义在 `src/contract/wire.ts`：

| 方法 | HTTP | 语义 |
|------|------|------|
| `authorizeDaemon` | `POST /internal/authorize-daemon` | 200 带 grant，或 204 表示"不行" |
| `authorizeClient` | `POST /internal/authorize-client` | 同上；票据的一次性由控制面保证 |
| `reportPresence` | `POST /internal/presence` | 204 |
| 撤销 | `GET /internal/revocations` (SSE) | relay 订阅，控制面推送 |

两个刻意的选择：

**票据无效返回 204 而不是 4xx。** 拒绝是正常业务结果，不是错误；混在一起的话，真正的故障就被淹没了。

**撤销由 relay 主动订阅，而不是控制面回调 relay。** 这样控制面永远不需要连得上 relay——家里那台自建 relay 因此不需要公网入口。重连时控制面先推一份最近撤销列表，补上断线期间漏掉的。

**控制面不可达时一律拒绝**。宁可这一分钟谁都连不上，也不能因为控制面抽风就放所有人进来。
拒绝状态仍要可恢复：只有 Control 明确返回 204（票据无效/已消费）才映射为 WebSocket 握手 403；
网络失败、超时、5xx、非预期响应或无法解析的 grant 一律映射为 503。这样客户端可以退避重试，daemon
也能换一张新短票，而不会把控制面抖动误报成永久撤销。

---

## 6. 限额

| 项 | 环境变量 | 默认 |
|----|---------|------|
| 模式 | `RELAY_MODE` | `control` |
| Control 地址 | `RELAY_CONTROL_ORIGIN` | control 模式必填；远端必须 HTTPS，只有字面 loopback 可 HTTP |
| Control bearer | `RELAY_CONTROL_TOKEN` | control 模式必填；缺失时 Relay 拒绝启动 |
| 自建模式的 join token | `RELAY_JOIN_TOKEN` | 只有字面 `127/8` 或 `::1` 可省略（不接受 `localhost`）；其余监听必须为 32–256 个随机 base64url/hex 字符，Relay 不生成也不打印 |
| 最大在线机器数 | `RELAY_MAX_DAEMONS` | 5000 |
| Legacy admission 代际 fence 上限 | `RELAY_MAX_LEGACY_GENERATION_FENCES` | 100000；满额后此前未见过的机器 fail-close，已有机器可用更高 generation 重连；普通断线、Authority 抖动都不清 fence |
| 单机最大客户端 | `RELAY_MAX_CLIENTS_PER_MACHINE` | 8 |
| 单连接缓冲上限 | `RELAY_MAX_BUFFERED_BYTES` | 8 MiB |
| 全进程发送队列上限 | `RELAY_MAX_OUTBOUND_QUEUED_BYTES` | 64 MiB |
| 握手凭证上限 | `RELAY_MAX_ADMISSION_CREDENTIAL_BYTES` | 4 KiB（按 UTF-8 字节） |
| 单帧上限 | `RELAY_MAX_FRAME_BYTES` | 4 MiB |
| Control JSON 响应上限 | `RELAY_MAX_AUTHORITY_RESPONSE_BYTES` | 16 KiB |
| Control 撤销 SSE 单事件上限 | `RELAY_MAX_REVOCATION_BUFFER_BYTES` | 1 MiB |
| Presence 本地刷新硬上限 | `RELAY_PRESENCE_REFRESH_MAX` | 30s；Legacy/Fabric 实际都取 Control grant 租约一半与此值的较小者 |
| 心跳 | `RELAY_HEARTBEAT` | 30s |
| 日志级别 | `RELAY_LOG` | `info`；`debug` 额外打每条 channel 的开与关 |

单连接或全进程发送预算超限都只断开触发发送的慢连接；已经健康的其他连接不受牵连。每笔预算在 `ws.send` 回调、错误或 socket 关闭时只释放一次。

### 6.1 每一次断开都写下原因

上面这些限额是会**主动切断连接**的，而被切断的一方看不到原因：浏览器只知道 socket 没了，正在飞的那个请求变成「结果未知」。原因只存在于 Relay 这一侧。

所以 `closeSocket` 与 `terminate` 是全部主动关闭的唯一出口，且每次都写一行 `warn`，带上 close code 与理由（`too slow`、`frame too large`、`the client missed a heartbeat`……）。这不是可选的观测点：不写在这里，就没有任何人能回答一个会话为什么掉了。

浏览器侧对应地把 close code 与 reason 原样带进报错文案。用户报「它就是断了」没法查，报 `1013 too slow` 直接指到是哪条预算。

---

## 7. 自建

见 [self-hosting.md](./self-hosting.md)。核心是两个环境变量：`RELAY_MODE=rendezvous`，以及 relay 监听哪里。不需要数据库，不需要控制面。

---

## 8. 现状与限制

### 8.1 严格短票切换的发布约束

这是一个有意的、不向旧认证降级的 wire 安全边界，因此**不能把新 Control 与旧 daemon 任意滚动混跑**：

- 先上新 daemon、Control 仍旧：换票接口返回 404，新 daemon 保持离线并重试，不泄漏长期 secret。
- 先上严格新 Control、daemon 仍旧：旧 daemon 仍发送 `<daemonId>.<secret>`，会被拒绝。

无停机迁移需要先发布一个过渡 Control（先提供换票接口，旧 authority 仅在受控迁移窗口保留），待所有
daemon 已升级后再部署本节描述的严格 authority；否则必须安排一次协调维护窗口。最终严格版本不提供
运行时 fallback 或长期 secret 兼容开关，避免迁移遗留永久扩大 Relay 泄漏面的半成品状态。

转发通道的初始 Hello 只带固定客户端标签、opaque capability/invite id、随机 nonce 与 HMAC proof；双向证明通过后，业务帧全部是带严格序号的 AES-256-GCM + HMAC 密文。Relay 仍能看到 IP、时序、长度、channel id，也能丢包或断线，但单独拿不到 secret，不能读取或伪造业务内容。

托管 Control 会生成 channel secret，并分别交给浏览器与 daemon，所以“Relay 不知道内容”不等于“平台零知识”；当前也没有公钥握手或前向保密。准确边界见 [security-model.md](./security-model.md)。
