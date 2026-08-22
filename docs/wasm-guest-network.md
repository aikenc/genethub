# wasm guest 的出网

> 合同：daemon 跑在 component 里时，跨设备连接的能力与原生 daemon 一致。
> 差别只在「谁开这条 socket、谁做这次握手」，不在「能不能连」。

## 1. 为什么需要这一层

`genehub_guest.wasm` 里就是 daemon 本体。它要连的东西有两类：

| 目标 | 协议 | `wasi:http` 够不够 |
| --- | --- | --- |
| Hub / Cloud / provider | HTTPS 请求-响应 | 够，走 `wasi:http` |
| relay `/fabric/v2`、本机 `/ws` | WebSocket | **不够**，`wasi:http@0.2` 没有 upgrade |

Fabric 是跨设备的 baseline carrier（见 [e2ee-data-plane.md](./e2ee-data-plane.md)）。它连不上，`--machine`、远端桌面、远端 Preview 就全都连不上。所以在 v2 形态里，「guest 能不能自己开一条 WebSocket」不是优化项，是产品面在不在的问题。

之前的 `transport/fabric_wasm.rs` 是一个诚实的桩：`is_online` 恒为 false。诚实，但产品面是缺的。这份文档描述的就是把它删掉之后的东西。

## 2. 切法：socket 归 guest，密码学归壳

```
daemon（guest）
  └─ tokio-tungstenite     HTTP upgrade + 帧编解码   ← 与原生同一份代码
       └─ genet-wasi::tls  wasi:tls  client-handshake ← 明文两端在壳里被加密
            └─ genet-wasi::net  wasi:sockets          ← DNS + TCP connect
                 └─ genehub-host（wasmtime）
                      ├─ wasmtime-wasi        sockets
                      └─ wasmtime-wasi-tls    rustls + webpki-roots
```

三条边界都是标准 WASI import，没有为此新增私有 ABI：

- **`wasi:sockets`**：guest 自己解析地址、自己 `start-connect`。宿主 `WasiCtxBuilder` 上的 `allow_tcp` / `allow_ip_name_lookup` 仍是那道闸门，能力没有被这层绕过。
- **`wasi:tls@0.2.0-draft`**：guest 交出「服务器名 + 一对明文字节流」，拿回「一对密文字节流」。证书链、根信任、cipher suite 全在壳里，component 里没有 crypto provider，也就不需要它自己跟进 CVE。该提案仍在 Phase 1，WIT 因此 vendor 在 `packages/wasi-guest/wit/tls/`。
- **tungstenite**：只保留 `handshake` feature（不带 native-tls / rustls），在 `wasm32-wasip2` 上照常编译。原生与 guest 因此共用同一份 upgrade 与帧实现——Fabric 的帧层没有第二个实现，这正是这层存在的目的。

汇合点是 `apps/daemon/src/transport/ws.rs`：

```rust
pub async fn connect(url: &str, config: WebSocketConfig) -> Result<Socket, Error>
```

两个 target 返回同一个 `WebSocketStream`，错误也同为 tungstenite 的 `Error`——拨号方靠 `Error::Http` 上的状态码区分「relay 拒绝」和「relay 没应答」，这条判断在 WASI 底下必须继续成立。`fabric.rs`、`cli_front/rpc_wire.rs` 因此不含任何 `cfg(target_family = "wasm")`。

`ws://` 与 `wss://` 的选择只看 URL scheme。明文只在 loopback 出现，也只有那里没有需要保护的网络。

## 3. 不阻塞

`genet-wasi` 全 crate 的规矩在这里一样成立：任何 import 都不许阻塞整个 instance。WASI socket 按契约是非阻塞的，就绪用 `pollable` 表示，而 `pollable.ready()` 立即返回——所以每一次等待都是「探一下 + 共享定时器退避」，与 `stdio.rs` 用的是同一个 `Backoff`。`poll_read` / `poll_write` 里没有 `pollable.block()`。

## 4. RTC

RTC direct 在这个形态下暂缺。`webrtc-rs` 是原生栈：ICE 要裸 UDP、要自己的定时器，component 托不住它。

处理方式是**如实回答**而不是静默失败：`connection.identity` 的 `rtcSupported` 现在来自 `dataplane::rtc::SUPPORTED`，在 wasm 上是 `false`。对端因此停在 baseline，`rtcState` 是 `unavailable`，而不是先花一轮协商再报一次失败。

能力上这不是缺口而是慢一跳：`DataEndpoint` 把 baseline 当正式 transport，RTC 只是升级项（[e2ee-data-plane.md](./e2ee-data-plane.md) §2.3）。原生构建不受影响，`rtc_host.rs` 一行未动。

## 5. 完成门

- `specialty.wasm.fabric.guest-opens-its-own-uplink`：站在 relay 的位置上，收到的是 daemon 发来的 `GET /fabric/v2?ticket=…` WebSocket upgrade，随后 `device.list` 的 `remote.online` 才为 true
- `specialty.wasm.fabric.wss-is-encrypted-before-it-is-http`：对 `wss://` 端点写下的第一批字节是 TLS record（`0x16 0x03 …`），明文 upgrade 行不出现；握手无法验证时 `remote.online` 保持 false
- `--machine` 在默认 wasm 路径上走通本机 daemon → relay → 对端 daemon，不再返回「fabric 不可用」

## 6. 非目标

- 不在 guest 里放 crypto provider（那等于把根信任和 CVE 跟进搬进 component）
- 不为 WebSocket 造私有 host ABI（`wasi:tls` 是标准 import，能随提案毕业而稳定）
- 不在本变更接通 guest RTC
