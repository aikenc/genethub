# 远程桌面接入：小幅扩展 Service Preview + 内置 H5

状态：已有未合入实现，复查及验收中；未部署。日期：2026-10-29。槽位：`dev-4`。

同步时源码基线：`genethub` `c6ac5610e5874d504fbed40a6df80a747b9e78b0`；`genethub-cloud` `cc0e6f0667a7d4082f352f349054c219e94bdfb5`。两仓已从原基线快进到本次 fetch 的 `origin/main`，没有合并冲突。随后已在 dev-4 写入首轮实现，当前构建、验证和阻塞见[总体提案 §12](remote-interactive-preview-proposal.md#12-首轮实现状态2026-10-29dev-4)；该基线不等于已部署版本。

## 1. 结论与修订顺序

**采用现有 Service Preview 的登记、鉴权、HTTP/WS 桥和 ICE 查询，加一个随 `genehub-preview` 分发、可复制修改的 H5 资源包；源端仍是独立 Capture App。** 首期 Windows/macOS、单个源端选定显示器、单观看者、H.264/Opus 与键鼠；Linux、Pixel Streaming 后置。

用户场景：Agent 在 Windows 打开 Blender，交付真实 `index.html`。用户用 Mac 工作台打开，沿用“启用本次登记服务”，在 H5 看当前画面，按已开启的源端策略申请控制。想加入项目进度或修改键位时，Agent 改项目里的 JS/CSS；想改采集实现时，改 Capture App，保持同一应用协议。默认包直接可用，不要求用户写集成代码。

决策演变及原因：

| 顺序 | 当时的设计 | 本次决定与依据 |
| --- | --- | --- |
| 初版 | 播放和输入固定在可信 React 面板 | 用户要求 Agent 可改客户端，因此增加获授权的 H5 播放；权限/停止仍由工作台提供 |
| 第二版 | 新 `service.session`、通用 broker、独立 SDK 包、页面委托及完整资源快照 | 检查源码后发现 `service.preview` 和 H5 已有可用 API；这些设计超出单用户远控首期，全部从当前实施范围删除 |
| 本版 | 小幅扩展现有 Service Preview，H5 包 + 独立 Capture App | 复用连接与权限，新增内容集中在应用串流、页面媒体能力和断线释放；下文是当前唯一有效细化 |

不新增全局 `remote:view/remote:control` Capability，不新增 Exchange 方法、broker 线格式、认证 HMAC 域、authority 定时器、renderer manifest/委托系统、不可变资源包平台或 npm SDK。仍保留源端共享开关、会话/控制租约和输入 watchdog，它们是实际桌面操作需要的状态。

## 2. 当前已经有的 API，及网络重构的影响

| 现有位置 | 已有能力 | 首期处理 |
| --- | --- | --- |
| [公开 Client](../packages/workbench/src/protocol/client.ts) `openServicePreview` | `service.preview` 的 `describe/connect/ice`；现有 DataStream 与选路策略 | 沿用方法和字段，不加平行 `service.session` |
| [serviceClient.ts](../packages/workbench/src/preview/serviceClient.ts) | `discover/fetch/websocket/ice/close`；route 检查、runId、有界消息、取消 | 补可选媒体字段类型及生命周期使用；保持为 Workbench 内部适配，不复制成新 SDK |
| [serviceBridge.ts](../packages/workbench/src/preview/serviceBridge.ts) | 已批准 iframe 中的 `fetch('/api/...')`、登记 WebSocket、MessagePort、背压与取消 | 继续使用；只补受限 `describe/ice`、控制 WS 的开启/撤销与状态观察 |
| [AssetPreviewPage.tsx](../packages/workbench/src/preview/AssetPreviewPage.tsx) | 服务发现、用户 enable、入口/连接切换、opaque iframe 与相对资源读取 | 增加可选 HTML 媒体模式，沿用当前页面生命周期 |
| [ServiceMediaPanel.tsx](../packages/workbench/src/preview/ServiceMediaPanel.tsx) | 原生 RTC 播放、单次 offer、停止、可选 TURN 与诊断 | 旧服务保持；将可复用的逻辑整理到 H5 模板，不要求旧面板导入用户代码 |
| [daemon 服务桥](../apps/daemon/src/dataplane/service_preview.rs) | 私有登记、runId/secret、v1 双向 HMAC、loopback HTTP/WS 代理、直接路径策略和最长一小时连接 | 继续使用；只验证新增公开字段和必要的取消清理，不导入桌面领域方法 |
| [authz.rs](../apps/daemon/src/authz.rs)、[endpoint.rs](../apps/daemon/src/dataplane/endpoint.rs) | 完整连接认证；PreviewShare 不可服务访问；撤销/过期中断连接并 abort handler | 复用现有模型；把 WS 断开后的 App 实际回收列为验收 |

本次同步包括 `1717c38a`（移除 UplinkPace/SendPace 和 ACK-paced send windows）、`a3655530`（删除兼容回退，握手字段显式必需）、`c6ac5610`（本地控制优先、有界 bulk lookahead）。Bulk write 完成可只表示逻辑 journal 已接收；载体有界队列和 await socket write 承担背压。**这不表示所有 ACK 都消失了**：resume journal ACK/grant、Service Preview 的 `0x02` 与 iframe 的消费 ACK 仍存在，意义不同。

远控信令沿用这条当前数据面，不增加第二套发送窗口、带宽探测、应用 ACK pacing 或恢复网络。媒体反馈/拥塞控制在 Capture App 的媒体栈中处理，不能把普通业务网络的 pacing 删除误读成 RTP 不需要拥塞控制。API 返回、stream.write 成功、WS send 完成都不等于桌面动作或按键释放已完成。

同步前后 `serviceClient.ts/serviceBridge.ts/ServiceMediaPanel.tsx/service_preview.rs/authz.rs` 无变化；`AssetPreviewPage.tsx` 只补了 `dial()` 的 `bulk` 投影。应以当前 Client 的完整握手/拨号路径测试，不能复制旧协议拨号代码或恢复主干已经删除的可选默认值。

## 3. 组件与资源放在哪里

```text
已有：packages/workbench/src/preview/
  serviceClient.ts       现有服务适配、ICE；补字段类型
  serviceBridge.ts       现有 H5 API；补 describe/ice 与控制连接门
  AssetPreviewPage.tsx   现有服务授权、HTML 模式及生命周期
  ServiceMediaPanel.tsx  保留已有可信媒体服务
新增资源：apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/
  index.html             默认播放器、连接状态与操作界面
  client.js              普通 fetch/WS + 原生 RTCPeerConnection 的薄封装
  input.js               键鼠映射、布局代次、两个输入 DataChannel
  style.css              默认界面
新增独立程序：apps/capture/
  app/                   图形会话、共享开关、系统权限、托盘/停止
  preview/               现有登记和本地桥协议、HTTP/WS 应用端点
  streaming/             原生组件适配、媒体 PC、反馈、会话
  input/                 控制租约、注入和独立 watchdog
协议源：packages/proto/src/service_preview.rs
  ServicePreviewMedia 的可选字段 + remote-desktop/1 的应用类型
```

以上是模块职责示意；首轮实际实现集中在 `apps/capture/src/`、`apps/capture/native/` 及内置 H5 文件，见 [Capture README](../apps/capture/README.md)。**浏览器薄封装就在 H5 的 `client.js/input.js`，首期没有 `packages/interactive-preview-sdk` 或 `packages/interactive-preview-client`，也不新增 npm 发布链。** H5 通过标准 fetch/WS 和少量宿主 API 工作；不相对 import Workbench 源码、React 或完整 daemon Client。

默认资源随现有 Skill 机制分发，使用时复制到 workspace 的 `preview/remote/`，Capture App 登记该真实入口，再交付链接。资源、依赖都用相对路径；不为静态文件起 HTTP 服务，不嵌入宿主专用加载器。离开 Workbench 直接打开入口可以展示界面/说明，但不伪装成已连接。若以后需要大量独立消费者，才另评估是否抽 npm SDK；目前不预建框架。

## 4. 最小的描述符和页面 API 增量

保持描述符 `version:1`，不新增 `sessionProtocols`。在现有 `media` 上增加可选字段；以下是公开子集示例：

```json
{
  "version": 1,
  "runId": "0123456789abcdef0123456789abcdef",
  "name": "Capture",
  "routes": [{"prefix": "/api/remote/", "websocket": true}],
  "media": {
    "offerPath": "/api/remote/offer",
    "stopPath": "/api/remote/stop",
    "microphone": "none",
    "client": "html",
    "protocol": "remote-desktop/1",
    "sessionPath": "/api/remote/session",
    "controlPath": "/api/remote/control"
  },
  "iceServers": [],
  "dataPolicy": "auto"
}
```

私有登记继续 v1、owner-only、16 KiB、原子发布、真实入口、runId/secret 与 loopback 端口。 Capture 在现有账户实例锁内记录自己发布内容的 SHA-256 归属回执；硬退出后仅自动恢复回执完全匹配的残留，新 run 重新开始且默认不共享/不控制。正常退出也按完整内容判断，不能只凭相同 runId 删除登记。回执缺失或内容被替换则保留并明确拒绝；不新增 daemon IPC、账号权限或迁移旧会话 token。`control` 依旧表示进程 shutdown，与键鼠无关；Capture 首期设 false，App 也拒绝普通请求触发 shutdown。源端实现检查路由、路径和方法，不能只信前端 `allows()`。`media` 目前为 Value 透传，也要在新增模式入口验证类型、路径范围、协议和长度；当前 TS 类型需显式增加可选字段，不能依赖类型断言。

`client` 缺失时走现有可信面板；`client:"html"` 且支持协议时交给 H5，可信外壳保留状态/停止。未知模式/版本明确不支持。旧 Web 可能忽略新字段而尝试传统 offer；Capture 在没有有效 WS 会话/token 时拒绝，不意外输出桌面；旧服务不需增加字段。

拟议的宿主小 API：

```js
// 注入由现有 serviceBridgeScript 统一负责；页面作者不复制私有桥实现。
const service = window.genehubServicePreview;
const { descriptor, controlAllowed } = await service.describe();
const { iceServers } = await service.ice();
const socket = new WebSocket('/api/remote/session');
```

这段 API 已在首轮源码实现，尚未上线；旧安装版本不能据此推断支持。`describe()` 只返回本入口公开描述符和宿主允许的页面状态；`ice()` 不接受 allowTurn=true 或任意 runId，使用可信工具栏当前选择，再调用已有 `ServicePreviewClient.ice()`。用户未 enable、服务不支持 HTML 媒体、runId 已换代或授权已撤销时明确拒绝。`client.js` 封装可用性等待与这些错误，不让页面无限挂起。

普通 HTTP/WS API 沿用原状。`/api/remote/control` 这条声明的 WS，在本页面可信工具栏允许接管后才开启；交还/失焦时宿主直接关闭对应桥，并在关闭 MessagePort 前通知 H5 的 WS shim，令其退出 OPEN 状态，同时禁用重开；观看 WS 可以继续。路径先规范化再匹配，不用 query/编码或另一条普通路径绕过；App 仅允许控制 WS 处理 acquire，观看 WS/HTTP 拒绝控制方法。取消服务则关闭所有相关桥。H5 可以发出请求接管的提示，但不能靠自报 trusted/gesture 打开门；该门只是本页面的能力限制，不替代 §5 的真实服务访问权限。

## 5. 权限采用现有模型，边界说清楚

沿用[产品安全模型](security-model.md)的完整连接合同：可驱动完整 Agent 的已认证连接具有目标 OS 账号的有效能力，不再按设备、Agent 角色或项目拆分 grants。本文的 `services` 仅指登记服务接口，不是独立授权档位。三个层次分别是：

1. **GeneHub 服务访问**：沿用连接认证和账号/机器归属，完整连接统一可访问登记服务。未认证、配对 bootstrap、仅展示的 PreviewShare 不能访问服务业务；撤销和过期继续中断已有连接。
2. **源端共享策略**：Capture 默认不采集/不允许注入；用户在 App 启用一个具体显示器共享，控制另有默认关闭的开关。策略由源端 UI 或已授权本机配置管理，不能通过普通远端 `/api/remote/` 调用放开。系统录屏和输入权限按 OS 分别取得，查询不触发弹窗。
3. **当前会话**：App 再决定 WS 观看/控制是否可用，只有有效控制 WS 和独占租约允许注入。页面按钮只是发起申请，不能自行宣告 granted。

**本版沿用完整连接模型。** 源端开启共享后，完整连接可以通过该登记入口申请观看；源端开启控制后，可以申请接管。源端开关、页面同意和 OS 隐私权限继续表达本次操作的业务意图，界面明确说明所共享的显示器及控制状态。

工作台的观看/接管按钮和 H5 的 enabled 约束本页面交互，不构成对其他完整连接或同 OS 账号进程的隔离。当前 Capture 未开启共享时不输出画面，控制关闭时不接受会话输入；仅展示分享仍按现有范围拒绝登记服务访问。

Capture 不采信请求体里的 principal、userId、scopes 或页面自报身份。首期按已认证本地桥连接和自己生成的 session/lease 区分访问，不需要传递账号身份。已有 v1 HMAC 仅证明 daemon 与登记 App 的运行关系；同 OS 账户恶意进程隔离不是该 shared secret 的能力。由此可以删除前版“认证主体上下文、broker/app 新帧域、daemon authority 存活证明”的整体设计。

获授权 H5 会看到本次画面、SDP 和必要的短期 TURN 配置，并能在已授范围内发输入；不声称用户脚本无法外传画面。账号、登记 secret 不给页面。首轮固定一个显示器；检测到尺寸、位置或旋转变化时结束旧会话/输入，重新选择目标要重启 App，不复用旧会话。generation 当前在每个新会话中从 1 开始，另由 runId/sessionId/token/lease epoch 隔离旧包；不提供运行中切换目标或透明热插拔恢复。首期不承诺应用窗口隔离，选中显示器上的其他内容也可能被看见/操作。检测与实际输入释放仍需真机验收。

## 6. Capture 的应用端点与会话合同

沿用现有 `/api/...` HTTP/WS；`remote-desktop/1` 是应用内容协议，不是新增数据面或 IPC 协议。类型统一在 `packages/proto` 定义；
首轮生成 Session/Target/Lease/Input 的 TS 投影，RPC envelope/端点见本文与实现。尚未交付独立 JSON Schema 生成器
或其他语言投影，不新增多仓手写副本与发布链。

建立源端观看会话前，先通过现有 `describe()/ice()` 准备配置并完成本地 RTCPeerConnection/offer 初始化。Windows 实测发现冷启动会阻塞 renderer，提前开短会话会错过续期；取消准备时不能留下源端会话。3 秒失联期限不因本地初始化而延长。

| 端点/消息 | 行为和事实来源 |
| --- | --- |
| `GET /api/remote/state` | App 的共享/输入策略、实际能力与当前目标/generation；状态不包含 token、画面或输入文本 |
| `WS sessionPath` | 一条观看的存活锚点；`session.open` → App 返回 sessionId、短期 sessionToken、目标/generation、协议与 TTL |
| `POST offerPath` | 沿用 type/sdp/iceServers，追加 sessionId/sessionToken/协商代次；校验会话仍属于有效 WS，绑定浏览器 DTLS fingerprint 后返回标准 answer |
| `WS sessionPath` 内 `media.signal` | 有类型、带协商代次的 trickle ICE；初版依然浏览器发 offer，不扩 UE offerer |
| `WS controlPath` | 独立控制连接，引用本次有效观看 sessionToken；`control.acquire` / `control.release`；以同 WS 的 `renew` 答复 challenge，App 原子仲裁单个可注入桌面的控制权 |
| `POST stopPath` | 带 sessionId/sessionToken，幂等停止本次会话；返回 `state:closing\|closed` 以及 `controlState:release-pending\|released\|release-unconfirmed`，区分仍在清理与实际确认结果；不等同退出 App |

sessionToken 由 App 生成，绑定观看 WS、运行和媒体协商，使用不可猜随机值；只在本次页面内存中传递，不进 URL、日志或项目文件。其他 WS/HTTP 客户端仅知道 sessionId 不够控制/关闭该会话。每次绑定有协商代次与一次性约束，旧 offer、旧 token 或旧 fingerprint 不能重放到新运行。App 重启换 appInstanceId/runId，不能恢复旧控制。

会话示例（App 接受并完成后才返回结果）：

```json
{
  "id": "req-1",
  "method": "control.acquire",
  "params": {"sessionId": "session-opaque", "sessionToken": "short-lived-opaque", "targetGeneration": 1}
}
```

```json
{
  "id": "req-1",
  "result": {
    "state": "granted",
    "leaseId": "lease-opaque",
    "epoch": 2,
    "targetGeneration": 1
  }
}
```

`waiting-for-yield` 为保留状态，当前 App 在另一个控制者占用时返回 `busy`，不自动暂停其他 Agent。Workflow 自行协调 GUI Agent 静止；不把 agent 名称、暂停逻辑加进 daemon。未参与的 OS 自动化不能声称已被强制排他。App 的真实状态事件与 lease epoch 用于外壳显示，页面上报的 granted 不被信任；宿主可从已登记控制/观看 WS 的后端事件观察状态，不建立第二条新协议。桥关闭后没有收到释放确认，外壳显示“释放未确认”，不把本地 close 当成 OS 释放证明。

WS 请求有 id；同连接内同 ID/同内容返回原结果，不同内容冲突。release/stop 幂等；创建/接管超时先查状态，不自动重放副作用；重连重新申请。错误区分 permission_required（OS 权限/源端策略分别说明）、not_shared、target_changed、desktop_unavailable（源OS会话锁定、非活跃或无法确认可用）、busy、encoder_unavailable、session_expired、lease_expired、release_unconfirmed。描述符的未知 client/protocol 由 Preview 明确拒绝；首轮没有额外版本协商框架。第一版只许一个观看和一个控制租约，不预建多观看者仲裁平台。

消息通常 ≤16 KiB、SDP 本体 ≤128 KiB，仍服从现有 256 KiB 包上限；应用起始预算为每 WS 8 个在途请求、20 条普通请求/秒、256 KiB 待发送数据，ICE 个数与协商次数有界。超限明确失败/关闭，不无限排队；这些是待实测固定的起始预算。已有一小时连接上限继续生效，提前提示重新连接，不自动续控。

## 7. 存活、释放与输入

**用已有 WS 生命周期代替前版 broker authority。** App 在观看 WS、控制 WS 各自发一次性随机 challenge，客户端只能从同一 WS 回答。初始按每秒检查、3 秒未收到有效答复到期，使用 App 单调时钟；同一时刻只有一个未消费 challenge，未应答时可重发同值，但不刷新期限，消费后下一轮才发新值。过期或消费后的答复无效；不能预排队大量 renew、靠递增 seq 或沿 DataChannel 续期。过期是终态，迟到答复不能复活。

观看 WS 断开/到期：停画面与声音、关闭媒体 PC、释放关联控制；控制 WS 断开/到期：立即停止新注入，释放按键/鼠标，观看继续。daemon 冻结、链路恢复期间或取消未及时到达时，不能仅靠仍活着的媒体 PC 保持权限，以上 WS 期限兜底。正常停用时宿主关闭桥，App 在收到关闭后立即处理，不等待下个 TTL；实际释放时间要实测，不能把 socket 已写入或已 drop 当作完成证据。

challenge/close 与 watchdog 不等待 GPU worker 或业务消息消费 ACK；现有 ACK 只是传输背压。App 异步协议泵有界，输入守护独立运行，不能让一个等待媒体写入的任务阻塞释放。若承诺“会话服务进程崩溃后仍可释放”，输入守护须独立进程；单进程析构不足以证明。整个守护/进程树被强杀后的 OS 状态单独实测，未确认时显示未知，不编造 released。

媒体 PC 使用 H.264/Opus 标准 RTP。输入在同一 PC 建立可靠有序的 `gh-control-v1`（键、按钮、滚轮、文本、状态）及 unordered/maxRetransmits=0 的 `gh-motion-v1`（移动）。每包带 session、lease epoch、target/layout generation 和序号，App 按对应控制 WS 的有效租约校验；纯 DataChannel 自报的 lease 不授予控制。媒体不逐帧经过 daemon/MessagePort/截图。

当前输入包示例：

```json
{"sessionId":"session-opaque","epoch":2,"targetGeneration":1,"seq":1,"event":{"type":"key","code":"KeyW","down":true}}
```

`event.type` 为 key/text/absolute/relative/button/wheel/state/reset，准确联合类型见
`@genehub/proto/remote-desktop`。绝对坐标 x/y 归一化到实际画面 0–1；按钮沿 DOM 编号 0–4。
相对移动使用同租约内累计的 dxTotal/dyTotal，运动/可靠通道各自递增 seq；新租约重新计数。
默认客户端每 250 ms 在可靠通道发送 `{type:"state",keys:[...],buttons:[...]}`。仅 WS 活着不能维持按住状态；
独立输入守护在持键/按钮时超过 1 秒没有可靠状态进度就释放退出。文本提交会同时清除客户端与源端的已按下集合，后续心跳不能重新按下旧键；发送异常会停止控制续期。拖出画面后的 pointerup 仍发送按钮释放，
pointercancel 重置并交还控制。守护还持有 OS 账户级输入锁，父进程退出/重启期间也不允许旧、新注入器重叠。
源端清理尚未完成时新观看返回 busy，重复 stop 返回 closing/release-pending，不能把“开始关闭”当成已释放。

绝对坐标按实际图像区域映射，处理黑边、DPI、Retina、负坐标显示器；相对移动用指针锁定。乱序运动不能重复累计位移，点击需与一致布局代次匹配。退出锁定、失焦/切页由外壳关闭控制桥；源端 watchdog 兜底，不能依赖用户定制脚本主动 release。目标是结合采集健康、编码及呈现进展判断冻结，静止画面不算故障。当前实现只结合编码回调与浏览器呈现，尚不能区分上游重复帧和真实采集健康；不得将该实现描述为已经证明持续有效的桌面。首帧/采集故障下暂停控制的验收仍是合入前缺口。

关闭观看不结束 Blender/UE、不杀 Agent、不退出 Capture App。App 仅回收自己创建的资源；用户工程仍在源机。可观测结果区分命令收到、控制 granted、目标动作发生、输入释放和媒体资源回基线。

## 8. H5 可定制与 Capture 可替换

默认 H5 和用户副本用相同 API：普通 fetch/WS + 窄 describe/ice，`client.js/input.js` 是可编辑源码。修改 UI、按键、布局、画质档位不触碰 daemon；源端编码能力仍由 App 声明并实际验证。协议公开意味着两端实现可替换，不意味着各自随意改线协议还能互通。

沿用已有预览授权生命周期：入口切换、页面重新加载、显示的源文件版本变化、runId 变化、断连时取消 enable 并关闭会话，新页面由用户重新开启；明确在 AssetPreviewPage 中将 source version 纳入重置条件。**首期不实现完整依赖闭包 hash、renderer manifest 或不可变快照**，也不宣称对同路径依赖被修改具备完整 TOCTOU 防护。获准执行的是所选预览页面的当前脚本及其依赖，采用现有可信服务模型；这条信任边界和服务能力在 UI 说明。

H5 仍是 opaque sandbox，不加 allow-same-origin，不顺带开放摄像头、麦克风、剪贴板或任意本机文件。接收远端媒体不要求调用本地 getUserMedia。只为声明 HTML 媒体的已启用页面评估必要的 pointer-lock/autoplay 能力，全屏以保留可信停止入口的外壳容器为单位；浏览器/WebView 中 RTC 播放、手势、锁定和失焦处理必须先过原型。普通 H5/旧服务维持当前策略；无法满足的端禁用相应控制，不借添加同源权限绕过。

Capture 的基础 profile 可改目标/画质/输入映射，但不能扩大系统权限；原生源码变化仍要独立构建、签名、安装与授权。替换 provider 先停止旧控制端并确认释放，再启动新 App、重新登记和授权；不搬旧 token/lease。首期同一可注入桌面只启用一个控制 provider；多个独立 App 不天然共享锁，不宣传跨 provider 强制互斥。无需动态原生插件、第三方市场或新账号系统。

## 9. 实施改动清单与交付出口

| 文件/范围 | 必须做的变更 | 保持/删除的范围 |
| --- | --- | --- |
| `packages/proto/src/service_preview.rs` + 生成类型 | media 的可选 client/protocol/sessionPath/controlPath；remote-desktop 应用消息类型 | descriptor v1 保留；不新增 Capability/Exchange/broker |
| `packages/workbench/src/preview/serviceClient.ts` | 按新类型使用已有 discover/ice/fetch/websocket/close，必要时补模式校验 | 不复制新 transport，不抽 npm SDK |
| `packages/workbench/src/preview/serviceBridge.ts` | 在已有桥内补 describe/ice；仅启用页面可用；controlPath 的连接门、定向关闭及真实状态观察 | 现有 HTTP/WS、消费 ACK/限额继续；不提供裸 Client/任意机器拨号 |
| `packages/workbench/src/preview/AssetPreviewPage.tsx` | media.client 分流、工具栏 relay/control 状态、source version/入口/run/连接变化失效、必要 sandbox 能力 | 旧面板和普通 HTML 不全局放宽 |
| `ServiceMediaPanel.tsx`、`ServiceStatusMenu.tsx`、`PreviewToolbar.tsx` | 旧服务保持；需要时复用 ICE/状态 UI，外壳提供交还/停止，HTML 模式不重复建第二个 PC | 不让 H5 覆盖可信停止入口，不重复创建播放器 |
| `apps/daemon/src/dataplane/service_preview.rs` | 校验新媒体模式/路径；沿用 v1 登记与握手；验证取消/撤销关闭本地 WS；仅发现清理缺口时补资源释放 | 不解析 control.acquire，不持有租约/输入状态，不新增 service_session.rs |
| `genehub-preview/assets/remote-desktop/` | 新增默认 HTML/JS/CSS、可编辑薄封装和输入实现 | 不新建跨包客户端框架 |
| `genehub-preview` 的接入/媒体/登记参考、示例 | 文档区分传统可信面板与新增 H5 媒体；复制入口、App 登记、错误/停止与定制步骤 | 现有安装/已发布版本不能据源码文档推断已具备能力 |
| `apps/capture` 与其独立制品 | OS 权限、共享策略、v1 本地桥、应用端点、原生采集硬编、RTC、输入、watchdog、签名/安装 | 不链接到 genehub-host、不改 WIT；不关闭用户工程 |
| `testing/specialties/preview` 及相关工作台测试 | 新/旧模式、桥门、真实 HTML RTC/输入、撤销/断线回收；OS/GPU/真实 Blender/Demo 另留平台证据 | 不以 mock SDP 或 WS echo 当远控验收 |
| Cloud / Fabric / Relay / 网络握手 | 使用同步后的原有实现与 ICE/TURN | 首期无业务改动；不重新引入网络 pacing/探测/兼容回退 |

交付顺序：M0 验证独立原生模块和真正 H5 沙箱 RTC/输入/断线合同；M1 打通默认 Capture + H5 观看/声音/关闭；M2 键鼠接管与 Agent 交还；M3 Demo 游玩和定制/回退验收。H5 包从 M1 就是实际客户端，不另造一套私有播放器后再迁移 SDK。Linux/Pixel 不阻塞。

GeneHub 本体的 Web/guest 小改可沿已有兼容门做 Live；Capture 首次安装和原生更新是独立 App 完整交付。当前不承诺更新 WIT 或重装 GeneHub 原生基座。旧 Web/guest/描述符组合按实际支持明确拒绝新模式；旧媒体服务继续可用，不做猜测性兼容回退。

## 10. 验收与未决的原型问题

下列为完整平台验收清单，尚未执行 Windows/macOS 真实远控验收。首轮源码已落地，实际实现/验证边界见
[提案 §12](remote-interactive-preview-proposal.md#12-首轮实现状态2026-10-29dev-4) 与 [Capture README](../apps/capture/README.md)：

- 已认证完整连接、未认证、配对 bootstrap、撤销/过期连接、PreviewShare；Capture 共享关闭/只看/允许控制：分别验证真实 App 是否输出画面/接受输入，保留认证与仅展示分享的真实边界。
- 使用当前完整 Client/握手，经 Fabric 或 RTC 数据路径跑 HTTP/WS；只给 `direct-only` 时策略仍生效；媒体允许 TURN 与数据策略独立，以 selected pair 为证据。
- 新 H5 用旧 fetch/WS API 和新增 describe/ice 完成真实媒体；停用 HTML 模式不重复建可信面板 PC；旧 `ServiceMediaPanel` 服务原样工作；旧 Web 对新 Capture 不意外输出桌面。
- 控制 WS 关闭仍能观看，观看 WS 关闭同时释放输入；用户页不发 release、页面卡死、daemon 冻结、设备撤销而媒体仍直连、弱网恢复：挑战期限后资源与输入实际回收，迟到 renew 不复活。
- 改当前入口版本、重载、换 runId；旧客户端/session/token 不继承；动态依赖完整快照不在首期保证内。修改 H5 布局/一项键位不改产品即可用，切回默认资源成功。
- Windows 独显工作站、Apple Silicon Mac；Chrome/Edge、Safari、WKWebView/WebView2 分别测试标准 RTP、音频、指针锁定、失焦释放、OS 权限与持续负载。原生输入守护崩溃行为单独验证，不能用 Linux 编译替代。
- 实际 Blender 旋转/平移/选择/文本/撤销、指定普通 Demo 连续移动/转向/声音；坐标、静止场景健康、30 分钟资源/延迟曲线可追溯。安装和协议 schema 通过不等于这些结果通过。

实施前 M0 需固定：H5 各端 RTC/锁定能力；现有取消是否可靠断开 App WS；challenge 与现有背压下的预算；原生模块独立抽取和实际媒体拥塞反馈。若需要新的底层能力或更细设备权限，应提出具体缺口再扩，不能重新默认引入整套通用框架。
