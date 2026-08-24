# CLI 薄转发器

> 合同：`genet` 原生二进制不再解析业务动词，也不再作为 E2EE 端点。
> 它只做本机生命周期与把 argv 交给本机 daemon。业务语义在 daemon（guest）里。
> 产品没有原生业务模式：daemon/agent 只装载 `genehub_guest.wasm`，缺件或不匹配即失败，禁止回退。
>
> 状态（2026-08-22）：实现与默认 WASM journey 已落地；它消除了高频模式的 CLI 业务漏网点，但**没有**自动生成 guest+官网制品、发布、验签或更新。交付愿景与剩余门见 [architecture.md](./architecture.md) B5 和 [roadmap.md](./roadmap.md)“WASM 持续交付”。

## 1. 为什么要改

今天的 `genet` 静态链接整个 `genet-daemon` crate。8.7k 行 CLI 源码里，约 85% 是「连上某台 daemon、发 `Request`、把 `Reply` 打成 JSONL」。剩下的重量来自它把自己当成一等 peer：

```
genet --machine X shell ls
        │
        ├─ 本机 daemon   （不在链上）
        └─ CLI 自己带着设备密钥，经 relay E2EE 直连对端 daemon
```

后果：

- daemon 改一行，`genet-cli` 整包重编
- 模式 2（只发 `genehub_guest.wasm`）盖不住 CLI 动词
- 每个 verb 的 schema / Routing / 远程选择都冻在原生二进制里

目标形态：

```
genet <argv>  ──(loopback /cli)──►  本机 daemon
                                      ├─ 本地：router::handle
                                      └─ --machine：本机 daemon 作为 E2EE 端点去连对端
```

原生 CLI 不再知道「session.list 是什么」。它不知道的动词，自然不用 wasm 装载。

## 2. 原生 CLI 还留下什么

| 留下 | 原因 |
| --- | --- |
| `--version` / `-V` | 不碰磁盘，release 冒烟也问它 |
| `daemon run/start/stop/restart/status/endpoint` | daemon 挂了也得能停它；不能转发给它自己 |
| confine 隐藏参数 | Linux user namespace 必须在从未起过线程的进程里创建 |
| `agent-serve` | 前门 exec 壳的 agent 入口，不是用户动词 |
| 无参数 usage | 没 daemon 也要能读用法 |
| `update` | 针对**这个**原生二进制的 fail-closed 声明 |

其余全部转发。`schema` / `capabilities` 也走 daemon：它们是合同的一部分，必须和 guest 同一份源。

## 3. 本机合同：`POST /cli`

与 `/health`、`/shutdown` 同一条 loopback HTTP 监听。

- 只接受 `127.0.0.1`
- 一次性、短寿命 HMAC 证明，域名为 `cli`（与 `shutdown` / `websocket` 分开，避免跨动作重放）
- 证明材料与现有控制面相同：`endpoint.json` 的 bearer + pid + machineId + fingerprint
- 请求体：

```json
{
  "argv": ["session", "list", "--workspace", "ws_…"],
  "cwd": "/absolute/caller/cwd",
  "stdin": "<base64, optional>"
}
```

- 响应：`application/x-ndjson`

```json
{"stream":"stdout","line":"{…json object as the CLI would have printed…}"}
{"stream":"stderr","text":"error: …"}
{"exit":0}
```

stdout 的每一行仍是原来的 JSON 对象（`genet.cli/v1` 信封或对话事件）。exit 码冻结不变：0 / 2 / 3 / 4。

`cwd` 必须由调用方传入。guest 自己的工作目录不是人敲命令时的目录；相对路径和「当前工作区」都针对调用方。

stdin 只用于 `genet shell` 的管道输入，上限仍是 1 MiB。更大的输入写文件再在 argv 里点名。

## 4. 信任模型变更

以前：远程流量的 E2EE 两端是「这台机器上的 CLI 进程」和「对端 daemon」。

现在：两端是「**本机 daemon**」和「对端 daemon」。

接受这条，才能把 CLI 从加密端点降成转发器。本机 loopback `/cli` **不再走数据面 E2EE**：它已经用 owner-only 的 `endpoint.json` bearer 做控制面证明，和 `/shutdown` 同一等级。把 loopback 再包一层 E2EE 只会把 `channel_auth` + `dataplane` 重新链进原生 CLI。

本机 daemon 必须在跑。`genet --machine X …` 在本机 daemon 没起来时不再能工作——这是刻意的。agent 在会话里调 `genet` 时 daemon 一定在；笔记本当瘦客户端、不启本机 daemon 去打远程，不再是支持的用法。

## 5. daemon 内侧

`apps/daemon/src/cli_front/` 就是从前的 CLI 动词实现。

本地（无 `--machine`）：

- 不再自己再拨一条 loopback WebSocket
- `LocalRpc` 直接 `router::handle(state, Loopback, LocalUser, request)`
- `Subscribe` 的 `SideEffect` 接到事件通道
- `shell.run` 走与数据面相同的 `dataplane::exec` 启动路径，只是帧不再上 WS

远程（`--machine` / Hub ticket）：

- 本机 daemon 作为 peer 去拨对端（原 `Rpc::connect_remote` / `connect_hosted`）
- guest 自己开 Fabric socket（`wasi:sockets` + `wasi:tls`，见 [wasm-guest-network.md](./wasm-guest-network.md)），这条路在默认 wasm 形态上是通的。`cli_front/rpc*.rs` 因此不再有 wasm 分支

## 6. 和发布模式的关系

| 模式 | 编什么 | 覆盖什么 |
| --- | --- | --- |
| 1. host + guest + 官网 | 原生 CLI/host 变了才编 | confine、daemon 启停、壳、装载 |
| 2. guest + 官网（高频） | `genehub_guest.wasm` | 几乎全部产品动词、会话、工作区、本机 shell |

模式 2 不再漏 CLI 业务面。原生 `genet` 与 `genehub-host` 只在启停/装载/隔离语义变时才需要重发。

这是源码边界已经具备的能力，不是当前发布能力：现有 `release.yml` 仍只有 tag/full release，没有独立的 guest+website Live workflow。非 stable 的 guest 编译已改走 `[profile.iterate]`（`opt-level=1` + `strip`），不再为热改付 fat LTO；Stable 安装包仍用 `[profile.release]`。客户端也还没有签名组件 manifest、自动应用或回滚。只有这些门关闭后，表里的模式 2 才能计入 95% 的端到端交付分子。

CLI crate 若仍 `depend` `genet-daemon`（为 Paths / lifecycle / isolation / 控制面证明），`cargo build --workspace` 仍会连带重编。这不影响已安装的原生二进制，也不影响模式 2 只替换 wasm。把控制面抽成独立小 crate 是后续清理，不是本变更的完成门。

## 7. 完成门

- `genet session list`（本机、daemon 已起）stdout 合同与改前相同，且原生 CLI 源码不再含 `Request::SessionList`
- `genet daemon stop` 在 daemon 无响应时仍能按 lock-file pid 停掉它
- `genet` 无参数、daemon 没起，仍打印 usage、exit 2
- `--machine` 在默认 wasm 路径上真的连到对端；连不上时报连接失败，不得假装在本机执行
- 既有 CLI journey / specialty 在默认 wasm 路径上通过

## 8. 非目标

- 不把 CLI 装进 wasm 再 exec 一次（那是更慢的同一重量）
- 不在 CLI 中实现 Fabric/RTC、更新策略或签名；这些属于 daemon guest 与发布/host 边界
- 不改桌面壳；桌面继续走 `/ws` 数据面
- 不把 `/cli` 暴露到 loopback 以外
