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
| 提供 HTTP 业务接口 | 除了 `/api/health`，它只有两个 WebSocket 端点 |

这些不是自律，是有测试守着的（`test/boundaries.test.ts`）：依赖方向、数据路径上不许出现 JSON 解析、依赖清单里不许出现数据库。

---

## 3. 端点

| 路径 | 谁连 | 凭证 |
|------|------|------|
| `GET /forward/daemon` (WS) | 机器上的 daemon | `Authorization: Bearer <daemonId>.<secret>` |
| `GET /forward/client` (WS) | 浏览器 / 手机 | `?ticket=<票据>` |
| `GET /api/health` | 运维 | 无 |

客户端票据走查询串是不得已：浏览器发起 WebSocket 握手时无法设置请求头。

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

---

## 6. 限额

| 项 | 环境变量 | 默认 |
|----|---------|------|
| 模式 | `RELAY_MODE` | `control` |
| 自建模式的 join token | `RELAY_JOIN_TOKEN` | 自动生成并打印 |
| 最大在线机器数 | `RELAY_MAX_DAEMONS` | 5000 |
| 单机最大客户端 | `RELAY_MAX_CLIENTS_PER_MACHINE` | 8 |
| 单连接缓冲上限 | `RELAY_MAX_BUFFERED_BYTES` | 8 MiB |
| 单帧上限 | `RELAY_MAX_FRAME_BYTES` | 4 MiB |
| 心跳 | `RELAY_HEARTBEAT` | 30s |

缓冲超限直接断开那一个慢读者。给一个跟不上的连接无限缓冲，代价会落到所有人身上。

---

## 7. 自建

见 [self-hosting.md](./self-hosting.md)。核心是两个环境变量：`RELAY_MODE=rendezvous`，以及 relay 监听哪里。不需要数据库，不需要控制面。

---

## 8. 现状与限制

relay 转发的是 TLS 解密之后的应用层字节。它在代码上不解析、不存储，但**技术上具备读取能力**——真正的端到端加密（两端基于公钥直接握手，relay 只见密文）尚未实现，在路线图上。

在那之前，请不要把"平台看不到你的内容"当成已经成立的结论。可以成立的是：代码开源、不落库、可自建。见 [security-model.md](./security-model.md)。
