# 自己部署

先说清楚一件事：**大多数人不需要部署任何东西。**

| 你想做的事 | 需要跑什么 |
|-----------|-----------|
| 在自己电脑前用 | 装个桌面端就完了 |
| 同一个 Wi-Fi 下用手机连电脑 | 同上，走局域网直连 |
| 人在外面连家里的电脑 | 需要一个 relay，以及一个签发票据的控制面 |

只有第三种情况才有本文。

---

## 1. relay 是什么，不是什么

你的机器在 NAT 后面，手机连不上它。relay 是双方都能连到的汇合点：机器主动拨出去挂一条连接，客户端连进来，relay 把两边接起来。

它**不做**鉴权决策。判断一张票据该不该放行需要账号和撤销状态，那是控制面的数据。relay 只是把票据转手一问，然后执行答案。

所以自建 relay 有两种玩法：

| 玩法 | relay | 控制面 |
|------|-------|--------|
| A：全部自己跑 | 自己的 | 自己的（实现契约即可） |
| B：只跑 relay | 自己的 | 用现成的 |

B 的价值在于：流量只经过你自己的机器，而你不必自己实现账号系统。

---

## 2. 跑一个 relay

```bash
cd apps/relay
npm install && npm run build

RELAY_PORT=8080 \
RELAY_HOST=0.0.0.0 \
CONTROL_ORIGIN=https://control.example.com \
CONTROL_TOKEN=<控制面给你的 token> \
npm start
```

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `RELAY_PORT` | 8787 | 监听端口 |
| `RELAY_HOST` | 127.0.0.1 | 对外提供服务时设成 `0.0.0.0` |
| `CONTROL_ORIGIN` | — | 控制面地址（必填） |
| `CONTROL_TOKEN` | — | 契约端点的 bearer token |
| `RELAY_MAX_DAEMONS` | 5000 | 在线机器上限 |
| `RELAY_MAX_CLIENTS_PER_MACHINE` | 8 | 单机客户端上限 |
| `RELAY_MAX_BUFFERED_BYTES` | 8 MiB | 单连接缓冲上限，超了就断这一个慢读者 |
| `RELAY_MAX_FRAME_BYTES` | 4 MiB | 单帧上限 |
| `RELAY_HEARTBEAT` | 30s | 心跳间隔 |

前面放一个终止 TLS 的反向代理，并且**允许 WebSocket 升级**。这是最常见的踩坑点：默认配置的代理会把 `Upgrade` 头吃掉，表现为连接总是立刻断开。

Caddy 的话不需要额外配置：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

relay 不需要公网入口以外的任何东西：不用数据库，不用持久卷，重启即空。它连控制面是**出站**方向，所以放在家里的路由器后面也能工作——前提是 daemon 和浏览器连得到它。

---

## 3. 自己实现控制面

只要实现四个端点，任何 relay 都能对接。契约在 `apps/relay/src/contract/wire.ts`，那是唯一的事实来源，下面是它的摘要：

| 端点 | 语义 |
|------|------|
| `POST /internal/authorize-daemon` | 机器的上行票据换机器 id。200 带 grant，204 表示不放行 |
| `POST /internal/authorize-client` | 客户端票据换机器 id。票据的一次性由你保证 |
| `POST /internal/presence` | 机器上线 / 下线通知。204 |
| `GET /internal/revocations` | SSE 流。relay 订阅，你推送 |

四个都要求 `Authorization: Bearer <CONTROL_TOKEN>`。

三个要点：

**票据无效返回 204，不要返回 4xx。** 拒绝是正常业务结果，不是错误；混在一起的话真正的故障会被淹没。

**撤销是 relay 来订阅的，不是你去回调 relay。** 这样你永远不需要连得上 relay。每次订阅先推一个 `sync` 事件，列出最近撤销过的机器 id，补上 relay 断线期间漏掉的那些。

**控制面不可达时 relay 一律拒绝。** 这是 relay 的行为，你不用做什么，但设计容量时要知道：控制面挂了，新连接就建不起来。

---

## 4. 工作台

`packages/web` 构建出来是一堆静态文件，随便什么静态托管都行：

```bash
cd packages/web && npm install && npm run build   # 产物在 dist/
```

浏览器打开时，连哪台机器由 URL 片段里的 `endpoint` 决定。用**片段**而不是查询串是刻意的：片段不会发给服务器，票据因此不会出现在访问日志里。

托管工作台的那台机器上**不要跑 daemon**（[security-model.md](./security-model.md) §6）。

---

## 5. 你的 relay 能看到什么

诚实起见：

- **能看到**：谁连了谁、什么时候、多少字节、连接持续多久。
- **看不到**：它不解析 payload，也不落库。
- **技术上能不能看到**：能。当前是传输层加密，relay 处理的是 TLS 解密后的应用层字节。端到端加密还没做（[security-model.md](./security-model.md) §1.1）。

这也正是"自己跑一个 relay"有意义的原因：在 E2EE 落地之前，把这一跳放在自己手里，是唯一能从技术上而不是承诺上解决问题的办法。
