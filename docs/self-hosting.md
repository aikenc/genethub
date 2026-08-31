# 自己部署

大多数人不需要自建。自建适合“让手机或另一台电脑，经公网连接自己的 daemon，但不需要账号系统”的场景。

```text
资源电脑 daemon ──出站 WSS /fabric/v2──┐
                                       ├─ 无状态 rendezvous Relay
手机/另一台浏览器 ──WSS /fabric/v2─────┘
         ▲
         └─ 任意 HTTPS 静态托管的同一份工作台
```

跨设备不开放 daemon 的明文 LAN bearer。Relay 只做 endpoint-neutral Fabric 路由；最终授权由 daemon 本地的配对设备表完成。没有数据库、账号服务或云端文件缓存。

## 1. 安装 daemon

Windows/macOS 使用桌面端。Linux、服务器和 VM 安装 CLI/daemon：

```bash
curl --proto '=https' --proto-redir '=https' --max-redirs 5 --globoff -fsSL https://genehub.dev/install.sh | sh
genet daemon run
```

安装脚本校验发布的 `SHA256SUMS`。当前不自动升级；校验和能发现传输损坏，但不能替代独立签名根。

## 2. 启动 rendezvous Relay

```bash
cd apps/relay
npm install
npm run build

RELAY_MODE=rendezvous \
RELAY_HOST=0.0.0.0 \
RELAY_PORT=8080 \
RELAY_JOIN_TOKEN="$(openssl rand -hex 32)" \
npm start
```

关键配置：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_MODE` | `control` | 自建必须设为 `rendezvous` |
| `RELAY_HOST` | `0.0.0.0` | literal loopback 以外的监听必须有强 join token |
| `RELAY_PORT` | `8788` | 示例使用 8080 |
| `RELAY_JOIN_TOKEN` | 无 | 非 literal loopback 必须为 32–256 个 base64url/hex 随机字符；`localhost` 不算安全例外 |
| `RELAY_MAX_FABRIC_ENDPOINTS` | 10000 | 所有 endpoint 总上限 |
| `RELAY_MAX_FABRIC_STREAMS_PER_ENDPOINT` | 256 | 单 endpoint outer streams |
| `RELAY_MAX_FABRIC_STREAMS` | 100000 | 全进程 outer streams |
| `RELAY_MAX_BUFFERED_BYTES` | 8 MiB | 单慢读 socket 发送预算 |
| `RELAY_MAX_OUTBOUND_QUEUED_BYTES` | 64 MiB | 全进程发送预算 |
| `RELAY_MAX_FRAME_BYTES` | 4 MiB | Relay 通用 frame 防护上限；当前 v3 peer record 仍限制为 16 KiB |
| `RELAY_HEARTBEAT` | 30 s | socket heartbeat |

其中 8 MiB/64 MiB 是 Relay Node 进程里真实 socket 排队预算，不是应用层传输窗口。新
client/daemon/Relay 三端协商 `transport-flow` 后，持续发送由每条 TCP 腿的本地 drain 推进；这些预算
只在下游异常慢或进程内排队增长时触发保护。任一旧端存在时仍回退 256 KiB outer credit。

join token 只让 daemon 占用 node slot，不授予文件或业务权限。client 只能接入一个当前 online 的 slot，随后仍必须在 E2EE peer handshake 中证明 daemon 签发的 device/invite secret。

公网前面必须有 TLS reverse proxy，并允许 WebSocket upgrade：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

daemon 会拒绝非 literal loopback 的 `ws://` Relay URL。公网必须使用 `https://relay.example.com` 配置，实际数据连接转换为 `wss://.../fabric/v2`。

不要记录完整 query string：browser endpoint ticket 位于 `/fabric/v2?ticket=...`，虽然短期或由自建 slot 派生，仍应在 proxy/access log 中脱敏。

Relay 不需要持久卷，重启即清空在线 endpoint/route；daemon 会自动重新挂接。

更多运行时限额和信任边界见 [relay.md](./relay.md)。

## 3. 托管静态工作台

```bash
cd packages/workbench
npm install
npm run build
```

`dist/` 是静态文件，可以放在任意 HTTPS 静态托管。SPA host 必须把不存在的前端路径回退到 `index.html`，因为 Preview 使用真实 deep link：

```text
/assets/preview/v2/<deviceHandle>/<projectHandle>/<rootHandle>/<relative-path>
```

如果部署在子路径，构建时设置正确的 Vite base；Preview builder/parser 会保留该 base。静态 host 不需要安装 daemon，也不代理文件内容。

建议静态工作台与 Relay 分开部署。至少设置 CSP、`frame-ancestors 'none'` 和 HTTPS；工作台自身位于浏览器凭证信任路径中，不要加载第三方脚本。普通页面应保持 `script-src 'self'`。只有 `/assets/preview/v2/*` 的独立 Preview 文档需要允许 `unsafe-inline`/HTTPS script 与 HTTPS/WSS connect，因为 `srcdoc` 会继承父文档 CSP；它仍必须保持 `frame-ancestors 'none'`，并由代码中的 opaque-origin iframe sandbox 再隔离活动 HTML。不要把这条放宽后的策略全站复用。

## 4. 开启远程访问与配对

1. 在资源电脑的工作台进入「设备」，填写 Relay HTTPS 地址和 join token，开启远程访问。
2. daemon 根据自己的 machine secret 派生稳定、不可猜的 32-hex rendezvous slot，并维持一条 `/fabric/v2` uplink。
3. 点「添加设备」，daemon 生成一次性、限时配对链接/二维码。
4. 在手机或另一台电脑浏览器打开链接；双方完成 invite PSK 双向证明。
5. daemon 在加密的 `device.claim` response 中返回长期 device credential；浏览器只保存在自己的本地 roster。

配对链接是一次机会，不是长期钥匙。长期 secret 不在连接中直接发送；每次连接用新 nonce + HMAC proof 证明持有它，再派生本次 AES-GCM session key。

每个浏览器 profile 独立配对。撤销某个 device 会让对应在线 peer endpoint 立即断开，其他设备不受影响。

## 5. 同一 Preview 链接跨设备打开

文件链接的形态是：

```text
https://workbench.example/assets/preview/v2/
  <deviceHandle>/<projectHandle>/<rootHandle>/docs/result.md
```

URL 明文保留设备、workspace 和相对路径，便于 Agent 输出可点击文档链接。它不是 capability：

- 已配对电脑或手机打开同一 URL 后，从自己的 roster 找到 `deviceHandle`，重新连接对应 rendezvous slot，并用自己的 device credential 完成 E2EE。
- 未配对浏览器只会得到“尚未获准连接资源所在设备”，不会因为知道 URL 而读取文件。
- 查看设备不需要 daemon；资源所在电脑的 daemon 必须在线。
- daemon 先检查项目是否包含 URL 中的全局 rootHandle，再按递归相对路径读取完整文件；超过 64 MiB 会直接拒绝。
- `asset.preview` request、MIME 与 bytes 都在 v3 E2EE record 内，Fabric Relay 看不到；但浏览器首先请求的 Preview URL locator 是普通 HTTPS path，静态站点/反向代理会看到它。若不希望写入日志，应在 edge 对 `/assets/preview/v2/*` 关闭或脱敏 access log。

同一个 URL 的“相同”包括 workbench origin。如果你有多个静态域名，需要由产品层选择 canonical origin；MVP 不做跨 origin credential 同步。

## 6. WebRTC

跨设备先建立 WSS Fabric baseline，再在该 E2EE link 中协商 WebRTC DataChannel。成功后新请求（包括 Preview）优先点对点传输；失败时仍走 E2EE Relay baseline。

MVP 只有公共 STUN、没有 TURN，所以严格 NAT、企业防火墙或 UDP 被禁时 RTC 可能显示 `failed`。设置中可查看状态和关闭 RTC。关闭 RTC 不会关闭 baseline，也不会降低业务层 E2EE。

RTC direct 只减少数据绕行，不能替代静态工作台、配对或 Relay baseline signaling/presence。

## 7. Relay 能看到什么

- 能看到：IP、连接时间、opaque endpoint/route/outer stream handle、frame 长度与时序。
- Fabric OPEN 中的初始 peer hello 被当 opaque bytes 转发；Relay 实现不解析，但恶意 Relay可查看其中的版本、通用 client label、RTC capability、credential/invite selector、nonce 和 proof。
- 看不到：配对/hosted secret、派生 key，以及握手后的 method、workspace/path、MIME、RPC、Preview bytes、事件和 PTY 内容。
- 无法伪造：AES-256-GCM record 绑定 credential context、方向和严格 sequence；重放或篡改会 fail-close。

AES-GCM 已提供密文完整性；HMAC 用于双向握手和 key derivation，不是每个 record 的第二层 MAC。当前 PSK 模型没有前向保密。

## 8. 自建与托管差异

| 能力 | 自建 | 托管 |
|---|---|---|
| 远程连接自己的 daemon | 有 | 有 |
| 多设备分别配对、撤销 | 有 | 有 |
| 同一 Preview URL 在已授权设备打开 | 有 | 有 |
| RTC direct（网络允许时） | 有 | 有 |
| 账号机器目录 | 无，本地 roster | 有 |
| 新浏览器通过账号找设备 | 无，需配对 | 有 |
| Relay/Control 数据库 | 无 | Control 有账号与 admission 状态；Relay 仍无业务存储 |

自建的授权模型是完整的，只是没有账号带来的设备目录和身份同步。

## 9. 最小运维检查

- `GET /api/health` 返回 `status: ok`；`GET /api/ready` 返回 200。
- reverse proxy 允许 `/fabric/v2` WebSocket upgrade。
- daemon 只配置 `https://` Relay URL，uplink 状态在线。
- browser 完成一次配对，目标列表能看到资源电脑。
- 打开一个不超过 64 MiB 的 `.md` Preview 链接，另一已配对浏览器打开同一链接得到相同内容。
- 设置中 RTC 至少给出明确状态；RTC `failed` 时 Preview 仍可经 baseline 成功。
- 撤销 browser device 后，它的 live connection 和 Preview 立即失效。
