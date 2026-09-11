# 数字人类服务 Preview：WebRTC 基建落地提案

状态：提案，尚未实施或部署。日期：2026-09-07。

交付目标：在 GeneHub 中打开一个有真实本地后端的数字人应用，完成视频/声音播放、文字交互和用户授权后的语音输入；媒体优先采用原生 WebRTC，可选择只直连或允许标准 TURN 中继。开发服务器先验证，随后按 dev → beta → stable 推进。

本文件只交付设计，不代表 RTC 修复、STUN/TURN、服务桥或数字人实网验收已经完成。所有新增 API、配置名、端口和预算均为建议值，实施时通过版本化契约确定。域名示例不是新部署链接。

## 1. 决策摘要

1. 保留 Asset Preview 的文件加载与隔离，新增一个登记服务的 HTTP/WS 桥。
2. 音视频继续由浏览器和数字人后端的原生 WebRTC 处理；不把媒体塞进 GeneHub Fabric 字节流，不模拟完整 RTCPeerConnection。
3. 首期由可信 Workbench 媒体面板持有 PeerConnection、video/audio 元素和麦克风权限；沙箱应用通过有限的媒体适配接口发出控制命令。
4. 自建 coturn，先启用 STUN；TURN 作为用户明确允许的媒体中继能力，独立启用和计量。
5. 复用已有腾讯云 Fabric Relay 承载 GeneHub 业务及信令。Fabric Relay 与 TURN 协议不同，不互相替代。
6. GeneHub DataChannel RTC 与应用媒体 RTC 独立连接、独立诊断；复用 ICE 配置和基础设施，不共享同一个 PeerConnection 对象。
7. 第一阶段不做完整浏览器 origin 平台、动态应用域名、自动 GPU 环境安装或长期应用 supervisor。

核心验收不是“RTCPeerConnection 变成 connected”，而是“手机能看到连续画面、听到声音、授权后发送语音，且能证明实际媒体路径符合选择”。

## 2. 当前代码和环境证据

本次基线：dev-net 开源仓 HEAD `37febb50a033e036624f8ee6b9b6060bd549549e`，Cloud HEAD `4dd5a5d13f606158050a8b2299278ad102f77982`。开源仓已有十个未提交的 RTC/设置/测试文件修改，Cloud 工作树干净。已有修改不是已验证上线能力，本提案不修改或打包它们。

| 已读代码 | 现状 | 设计影响 |
| --- | --- | --- |
| [AssetPreviewPage.tsx](../packages/workbench/src/preview/AssetPreviewPage.tsx) | srcdoc 使用 allow-scripts；禁止麦克风和摄像头；fetch 拦截走 URL 文件请求 | 不能直接把后端 POST 或麦克风当作已经支持 |
| [htmlSite.ts](../packages/workbench/src/preview/htmlSite.ts) | 静态资源改写、模块处理和运行时资源桥 | 继续复用；后端 API 必须显式分流 |
| [preview.rs](../apps/daemon/src/dataplane/preview.rs) | asset.preview 拒绝请求正文，处理工作区文件 | 新增服务契约，不改变文件读取含义 |
| [浏览器 RTC](../packages/workbench/src/dataplane/rtc.ts) | 有序 genehub-data-v3 DataChannel；STUN 写死；非 trickle 协商 | 统一配置；独立验证超时、候选与恢复 |
| [client.ts](../packages/workbench/src/protocol/client.ts) | 新请求优先 RTC，否则基础 endpoint | 不代表已建立的订阅全部迁移，也没有业务仅直连门禁 |
| [daemon RTC](../apps/daemon/src/dataplane/rtc.rs) / [host RTC](../apps/host/src/rtc.rs) | 原生与 WASM 宿主实现并存 | 两条执行路径都要验证，不只更新网页 |
| [WIT](../wit/genehub-host.wit) | ice-servers 为 URL 列表，接口面向 DataChannel | STUN 配置可复用现有字段；不是完整 TURN 凭证/媒体轨道接口 |
| [Cloud Caddyfile](../../genethub-cloud/deploy/Caddyfile) | /fabric/v2 到 Relay，其他到 Control；已有 stable/beta 站点 | 无需新建信令服务；STUN/TURN 不经过 HTTP 路径路由 |
| [Cloud deploy.sh](../../genethub-cloud/deploy/deploy.sh) | 按 Channel 分端口、环境变量、服务单元；Caddy 由独立同步步骤管理 | coturn 独立生命周期，不能普通发版就重启全部基础设施 |
| [安全模型](security-model.md) | Relay 没有业务密钥，托管 Control 仍持临时 secret | 不宣称整个平台零知识 |

用户确认当前机器是开发服务器；本次仅读取确认 Linux 环境，没有探测公网地址、DNS、安全组、GPU 或实际在线服务，也没有登录腾讯云。官方腾讯云 Relay 的部署事实由用户提供，仓库配置与其一致；不推断当前开发服务器就是那台公网服务器。

数字人历史拓扑仅作为输入：前端 7860、数字人 8010、语音 WS 8765、模型 8080。该应用源码未在本次检查范围内；真实启动命令、SDP 形态、编解码和语音输入格式必须在 M0 实测确定，不按端口号编造适配实现。

## 3. 范围和应用契约

### 首期支持

- 一个静态入口及现有 Preview 支持的资源；一个逻辑应用可绑定多个登记后端路由。
- JSON/二进制 HTTP 请求、完整状态码与必要响应头；通过 fetch 消费的流式响应。
- 有界 WS 消息桥，用于真实语音服务或应用事件；不先模拟全部浏览器网络栈。
- 一路数字人视频和音频下行；一路用户授权的麦克风输入；文字输入、停止与重连。
- 应用本地数据存储和既有模型调用，继续由后端负责。
- LAN 与跨网手机试用；直连失败可明确失败，允许中继时使用标准 TURN。

### 明确不承诺

任意嵌套 iframe 原样运行、cookie/OAuth 全兼容、任意 RTCPeerConnection API Hook、任意媒体编解码、摄像头/屏幕共享、多方会议/SFU、跨重启永久托管、官方 TURN 无限流量。没有 TURN 不意味着 Preview 普通 API 不能用；没有 GeneHub DataChannel RTC 不意味着应用媒体 RTC 不能连接。

## 4. 架构和连接过程

```text
手机 / PC 的可信 Workbench（安全上下文）
  ├─ Preview 沙箱：应用 HTML、控制界面
  │    └─ 受限消息桥：HTTP / WS / 媒体控制
  ├─ 服务客户端 ── GeneHub Data Plane ── 源机器 daemon ── 登记后端
  │                 ├─ 已有 Fabric Relay
  │                 └─ 可用时 GeneHub RTC DataChannel
  └─ 可信媒体面板：原生 PeerConnection + video + 麦克风
          ║ 原生 DTLS-SRTP，直接或经 TURN
          ╚════════════════════════ 数字人后端自己的 WebRTC 端点

ICE 配置：所属 Control / 自托管配置 → Workbench 与后端适配器
STUN/TURN：独立 coturn；不解码、不转码，不承担业务信令
```

连接步骤：

1. 已认证客户端打开工作区入口；daemon 返回登记服务身份、运行代次和 readiness。
2. Workbench 绑定本次 Preview 会话和服务权限；页面只拿到不透明句柄。
3. 用户点击可信媒体面板“连接”；面板根据所选策略获取 ICE 配置，需要 TURN 时获取短期凭证。
4. 媒体面板创建原生 PeerConnection，SDP 经服务桥交给后端适配器；支持 trickle 的应用转发增量候选，不支持则发送收集后的完整 SDP。
5. 双端应用自己的 ICE 建连，独立于 GeneHub DataChannel；后端必须正确配置媒体监听地址、候选和可用 ICE 服务。
6. ontrack 直接接到可信 video 元素，浏览器处理解码、同步和播放。首期不跨 iframe 转移 MediaStream，不依赖各浏览器轨道可转移能力。
7. 用户点击“启用麦克风”，可信宿主请求浏览器授权，按该应用已验证的输入方式发送。
8. 停止、撤销、页面销毁或运行代次变化时，关闭连接、停止采集、释放后端会话；网络短断由有界状态机恢复。

WebRTC 负责原生媒体传输，信令由应用实现；这正是可以复用 GeneHub 服务桥、又不重造媒体栈的边界。[WebRTC 官方连接说明](https://webrtc.org/getting-started/peer-connections/)

## 5. Preview 权限与业务适配

### 5.1 首期选择可信媒体面板

保留现有沙箱，不给 srcdoc 同时增加 allow-scripts 和 allow-same-origin。后者可能让工作区任意 HTML 获得与官网同源的能力，不能以“需要麦克风”为理由放开。

可信媒体面板是 GeneHub 自带代码，与应用沙箱并列展示。用户页面可申请连接、停止、静音和读取粗粒度状态；设备权限按钮、目标应用名称和持续采集指示必须由可信界面呈现。页面脚本不能伪造授权按钮，也不能自行选择麦克风发送目标。

消息验证采用 frame.contentWindow 身份、会话代次、私有 MessagePort/能力绑定和结构校验；opaque origin 的 "null" 不是鉴权依据。父页面不接受页面提供的任意 URL、机器 ID、TURN 凭证或 SDP 网络配置来扩大权限。

浏览器拒绝麦克风、系统无设备或当前入口不是安全上下文时，仍允许只观看/文字模式，并说明原因。不是简单删掉 Permissions Policy 就保证可用。[getUserMedia 限制](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

如果后续必须让视频完整嵌入任意应用布局，再评估受控媒体 surface 或独立来源媒体视图；不得把整个应用提升到可信 Workbench DOM 中。

### 5.2 API 兼容承诺

- 应用 fetch/WS 尽量保持标准调用形式，对声明路由做转发；不模拟整个浏览器的 cookie、导航和源模型。
- 媒体通过版本化的小型适配接口，例如 connect/status/stop/mute；这些名称为建议，不是已存在 SDK。
- 将原应用“建立 PeerConnection 并设置 video.srcObject”的播放组件替换成媒体面板接入，保留后端媒体协议。
- 不伪造原生 getStats、ICE 状态和完整 SDP API；应用需要未声明能力时明确拒绝。
- 摄像头不在首期；不会为了兼容 getUserMedia 任意参数自动增加权限。

### 5.3 语音输入必须按后端实际协议选择

若后端接受 WebRTC 音轨，使用 addTrack，保留浏览器原生采集/编码。若原项目使用 WS PCM 或编码音频，宿主采集后由受信适配器按其采样率、声道、帧格式送入登记 WS 路由；需有限 AudioWorklet 和格式转换工作。不能假装数字人媒体端点天然接收麦克风，也不为此重做视频编解码。该差异在 M0 固定，计入范围与验收。

## 6. 服务登记、HTTP/WS 和生命周期

建议新增三种身份：应用定义、一次服务运行、一次 Preview 访问。实例绑定 Channel、源机器、工作区、run generation 和登记后端；端口不是身份。

首期由已有启动流程启动后端，再登记 readiness。优先使用 daemon 管理的进程归属；受控附加需要验证归属和端点挑战或等效证明，不能通过“端口能连”授权。进程退出、端口重新被占用或 daemon 重启使旧登记失效；关闭预览取消访问与媒体，不默认停止共享模型服务。

路由示意：

| 浏览器语义路由 | daemon 绑定目标 | 可见范围 |
| --- | --- | --- |
| /api/avatar/offer | 已登记数字人后端的 /offer | SDP 请求/响应 |
| /api/avatar/session/* | 已登记数字人会话接口 | 状态、停止等必要操作 |
| /api/realtime | 已登记语音 WS | 声明的二进制/文本消息 |
| /api/config/* | 已登记业务配置接口 | 有权限的读写 |

这些是适配映射示例，不能照搬为任意后端代理。模型端口、宿主管理接口、数据库端口不直接暴露。

新增独立服务 Exchange 契约，传递 method、path/query、受控 headers、body；返回 status、headers 和流。禁止拿 asset.preview 的缓存、整文件授信和 64 MiB 文件上限套用到服务流。

HTTP 错误状态正常返回 Response，网络错误才 reject；默认不跟随重定向，不自动重试非幂等请求，不缓存 API。WS 保留消息边界、文本/二进制、关闭和取消语义。浏览器、父页面、Data Plane、daemon、上游之间保持有界背压。

初始预算建议：SDP 256 KiB、普通请求体 8 MiB、每视图并发 HTTP 8、WS 2、WS 单消息 256 KiB；流式响应按时间与在途窗口计量，不整体缓冲。实际语音帧超过预算时按明确配置调整，不悄悄截断。

## 7. 连接策略：数据和媒体分别显示

底层支持两项正交策略：dataPolicy=auto/direct-only；mediaPolicy=direct-only/allow-turn。用户界面提供清楚的组合，不用一个“RTC 开关”掩盖差异。

| 模式 | GeneHub 数据 | 应用音视频 |
| --- | --- | --- |
| 严格业务直连 | 已认证 loopback 或 RTC；基础连接仅认证/信令/必要控制 | STUN，禁止 TURN |
| 数据自动、媒体直连 | RTC 或现有 Fabric | STUN，失败则媒体不可用 |
| 允许中继 | RTC 或现有 Fabric | 原生直连或 TURN |

本项目试点默认“数据自动、媒体直连”；此前用户明确要求不经官方业务转发的机器，应保持“严格业务直连”，不能因加入 Preview 改变已保存偏好。

严格模式必须覆盖 HTTP、WS、历史、订阅、后台推送和语音输入；RTC 未就绪或断开时不得先从 Fabric 发业务。新模式不是只改 requestEndpoint()；现存基础通道业务流需要关闭，服务端也校验所允许的载体。仅控制消息例外应有白名单，媒体 SDP 属于信令元数据。

direct-only 两端不配置 TURN、不接受 relay 候选参与媒体连接，并验证实际选中候选对。浏览器没有标准 iceTransportPolicy="direct" 枚举；不能发明该值。allow-turn 的 all 策略允许 ICE 选择可用路径，不保证绝不提前使用 TURN；因此显示真实路径，若要求先纯直连再提示中继，就分两次协商，不把 all 宣传为严格串行兜底。[WebRTC 标准](https://www.w3.org/TR/webrtc/)

严格策略仅约束 GeneHub 管理的通道；既有沙箱允许外部 HTTPS/WSS，不能据此声称阻断应用一切外网请求。若将来提供应用网络隔离，应单独设计并测试。

## 8. STUN/TURN 和 Channel 配置

### 8.1 部署模型

独立 coturn 实例/配置/日志/凭证密钥，不把 STUN 写进 Node Relay。不通过 Caddy HTTP 路径转发 STUN/TURN。

| Channel | 可复用域名（需实际解析到 UDP 入口） | 建议 listener | TURN UDP relay 范围示例 |
| --- | --- | --- | --- |
| stable | relay.genethub.com | 3478 | 49160–49259 |
| beta | relay-beta.genethub.com | 3479 | 49260–49359 |
| dev | 实际部署域名；仓库 relay-dev 名称只是占位 | 3480 | 49360–49459 |

端口只是待占用检查的规划。STUN-only 不需开启 TURN relay 范围。TURN 启用后必须检查 listener 与分配端口的完整公网可达性、NAT 映射与路由，不能只测试 3478。容量按实际 allocation 需求计算，端口范围不是承诺的会话数。

同 IP 同端口上的 STUN 不按请求域名区分 Channel，分域名不构成运行隔离。即使独立进程，三线仍可能共享机器、带宽和故障域；规模增长后分实例/IP。

普通网站域名仅在直达服务器且 UDP 可达时复用；接入 HTTP CDN 后，显式使用独立 STUN 主机名。不要发布不可达的 AAAA。开发入口与 STUN 可以在不同主机，只要配置明确且安全边界不变。

### 8.2 配置分发

Cloud 延续 HUB_ / HUB_BETA_ / HUB_DEV_ 前缀，新增建议字段 ICE_SERVERS、MEDIA_TURN_ENABLED、TURN_AUTH_SECRET_REF、TURN_CREDENTIAL_TTL。凭证 secret 从受限部署配置读取，不放入仓库或公开配置接口。

新增版本化 ICE 公共配置契约（只含可公开 URL/能力/版本），和已认证短期 TURN 凭证接口。Workbench 从当前 Control 获取，daemon/后端适配器从所属 Control 获取；不允许 silent fallback 到另一个 Channel 的凭证。自托管可配置自己的 STUN/TURN，不依赖闭源 Control。

GeneHub DataChannel 首期只消费 STUN URL，不给它增加重复 TURN 兜底。应用媒体 PeerConnection 由可信 Workbench 接收标准 iceServers 结构；后端适配器同步用户名、凭证和更新策略。现有 WIT URL 列表不冒充可承载认证 TURN 配置。

### 8.3 TURN 可选增强

STUN-only 先部署；开放 TURN 必须同时启用认证、短期凭证、allocation/用户配额和带宽限制。凭证只给已授权媒体会话和受信后端适配器，不进入 HTML、URL、localStorage 或普通日志。共享签发密钥不发端侧。

使用版本固定、经过安全更新评估的 coturn；管理接口不对公网开放，拒绝不必要的 loopback、私网、链路本地和多播 peer 目标，防止被用来探测基础设施。可达性测试若需要私网目标，使用隔离测试配置，不能放宽生产实例。

凭证过期不等于立即终止已有 allocation，也不保证即时撤销。停止时同时关闭 Workbench PC、后端会话和停止续发；硬撤销需要服务器端会话清理能力与有界租约验收。不能宣传短期密码即零延迟撤销。相关 coturn 配置应以所固定版本为准。[coturn 配置参考](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

TURN/TLS 作为后续企业网增强。优先独立 IP 的 TCP 443；开发验证可先用独立 TLS 端口，但不声称它覆盖仅开放 443 的网络。同 IP 上已有 Caddy TCP 443 时，必须独立入口或经过评审的 L4 分流，不能假装增加一个 Caddy handle 即可。TLS 证书只为 TURN/TLS listener 服务，不需要每应用证书。

## 9. 当前开发服务器的落地步骤

以下是实施清单，不是已执行命令；本次不安装、不启端口、不重启进程。

1. **只读盘点**：固定服务器用途、现有监听和 owner、dev gateway 入口及 HTTPS、安全组/防火墙、公网 IP/DNS/NAT、带宽限制；秘密只保留引用，不导出完整 env。
2. **确认公网角色**：开发机若没有公网 UDP 入站，STUN/TURN 放到可达的腾讯云实例，开发机继续作为后端源端。SSH/网页可达不证明 UDP 可达。
3. **准备 dev 基础设施候选**：版本固定的 coturn、独立 unit/config、仅 STUN、端口无冲突、资源上限、外部 Binding 探针。由基础设施 owner 应用网络规则并保存回滚记录。
4. **准备应用候选**：服务桥、可信媒体面板、一个数字人适配器；复用已有 dev 环境构建与 supervisor，不临时手工起一个网页冒充 dev 交付。
5. **基线验证**：先真实后端原生页面验证媒体，再验证经过 GeneHub 服务桥和媒体面板；分别记录 GeneHub DataChannel 与应用媒体状态。
6. **受控开启 TURN**：STUN 验证后，在独立 dev 实例启用短期凭证和限额；禁止 UDP 直连的环境验证媒体经 TURN，确认已选 relay 候选及收发统计。
7. **四网络与手机**：执行第 11 节矩阵，按结果决定是否需要第二 STUN 或 TURN/TLS 443，不先建设全国网络。
8. **交付 dev 体验**：由 Cloud 的 pipespaces/genethub-dev 所属开发交付流程构建、发布、确认脱离启动会话后的存活与探针；本 dev-net Space 形成实现候选后移交，不自行发布公网 beta/stable。

应用包发布与 coturn 变更解耦；更改 STUN/TURN 配置必须独立记录配置版本。不得借普通 Web 更新重启全部 Channel 的 coturn 或 Caddy。

## 10. 工程拆分和兼容发布

| 工作包 | 主要代码位置 | 交付边界 |
| --- | --- | --- |
| ICE 配置与诊断 | Cloud server、Workbench dataplane、daemon RTC | 配置一致、旧配置有界回退、版本可识别 |
| 已有 RTC 修复复核 | browser rtc、daemon rtc_host/rtc_guest、host rtc | 原生/WASM 行为、超时和真实数据传输 |
| 服务契约与授权 | packages/proto、daemon dataplane/authz | 登记、路由、流控、撤销、run fencing |
| Preview 服务桥 | Workbench preview/client | 标准 HTTP/WS 子集、消息来源校验 |
| 媒体面板与适配器 | Workbench 新媒体组件、后端适配接入 | 原生 PC、可信采集、目标绑定、停止 |
| STUN/TURN 运维 | Cloud deploy 与配套配置资产 | 独立实例、凭证签发、限额、探针和回滚 |
| 验证工程 | 现有 testctl 工程 | 真浏览器/真实后端及多网络证据 |

协议以能力协商启用，不假设新网页必有新 daemon。旧端不支持服务/媒体契约时明确显示未支持，文件 Preview 继续工作。先发布可兼容的配置和服务端，再启用客户端功能开关；按仓库版本规则判断 WIT/宿主变化是否需要安装包，不把宿主修改当成 guest 热更。

beta 先获得 dev 证据再独立启用，stable 再获得 beta 回归证据。关闭 feature flag 停止新会话，已运行会话按明确期限结束；回滚保留用户数据，不把旧版本指向新协议请求。coturn 配置回滚不得恢复已撤销凭证签发能力。

## 11. 验证矩阵与通过标准

所有测试实施接入现有 testctl；不得用 rtcSupported=true、mock PC 或 SDP 返回 200 代替实网媒体。本文未新增或执行任何测试 run。

### 三类验证必须分开

| 类别 | 验证对象 | 不能替代的事情 |
| --- | --- | --- |
| STUN/TURN 探针 | Binding、认证 allocation、实际 relay 包、端口和证书 | 不证明浏览器可播放 |
| GeneHub DataChannel | ICE、认证、双向带校验数据、流切换和门禁 | 不证明应用媒体连通 |
| 数字人媒体 | SDP、ICE、音视频轨道、解码、麦克风、同步和播放 | 不以设置页 RTC 绿灯替代 |

### 功能和故障场景

- 真浏览器 + 真 daemon/host + 真实媒体源；先使用确定性音视频源定位传输，再用实际数字人验收完整业务。
- 一路画面与声音至少持续 30 分钟；检查视频帧、音频输出和时间戳，不只看 packetsReceived。
- 麦克风允许/拒绝/系统占用；静音/停止/关闭页面立即停止本地采集，后端释放有界。
- 四网络设备轮流作为查看端与源端；最多 12 个有方向组合，另加入真实 Android Chrome 与 iPhone Safari，同 Wi-Fi 与蜂窝分别记录。
- 每个代表性组合建议 20 次冷连接；报告分母与失败阶段，不以小样本推算全国成功率。
- 禁用 STUN 但允许 LAN；禁用直连但允许 TURN；TURN 凭证错误/过期/配额耗尽；两类路径均不可达。
- Wi-Fi/蜂窝切换、锁屏恢复、daemon 重启、后端退出、端口复用、权限撤销与旧页面消息重放。
- Channel 凭证串用失败；新旧协议组合有可理解的能力降级。
- 严格直连模式没有 Fabric 业务流和 TURN allocation；按业务 stream 分类计数，不要求登录/信令零字节。
- 媒体允许 TURN 时强制 relay 的诊断用例能完成播放，再测试 all 策略；强制 relay 仅是测试选项。
- 媒体转发负载下，聊天/终端的延迟与错误率无明显退化，报告共享机器带宽饱和点。

### 试点指标（目标，不是现状或 SLA）

受控 LAN 20/20 连接并播放是基础门槛；跨网允许失败，但未定位问题标记 unknown，不统一归因 NAT。每次同时记录配置版本、Web/daemon/host/适配器构建身份、策略与两条连接路径。

分别测量媒体协商至首帧、媒体端到端延迟、声音/嘴型时间差、卡顿、重连耗时和手机功耗。使用可对齐的测试时间标记，不能直接相减未同步机器的墙钟。目标是在相同原生媒体路径下，面板与服务桥带来的额外稳定态播放延迟不超过 100 ms；音画差争取 ±80 ms。模型思考/语音合成时间单独测，不归因网络。

默认诊断仅保留候选类型、地址族、选中路径、阶段耗时、RTT、丢包/字节计数和错误分类；SDP/IP/凭证不进公共日志。细粒度诊断经用户主动导出并脱敏，不记录声音或视频正文。

## 12. 安全、隐私和资源边界

- STUN 看到网络映射元数据，不承载媒体正文。
- TURN 转发原生加密媒体，不做媒体 TLS/DTLS 终止或转码；TURN/TLS listener 的 TLS 与内层 WebRTC 媒体加密是不同层。
- 当前托管前端与 Control 仍在既有信任边界内。配置 STUN/TURN 不等于平台技术上不可冒充端点；端侧信任升级单独推进，参见[可信链接提案](trusted-link-pairing.md)。
- 应用访问本地服务是新增权限，不从文件读取权限自动推导；后端进程能访问宿主资源，需要自己的权限和隔离管理。
- 未认证请求不能触发昂贵的模型或 GPU 会话；服务访问授权、TURN 凭证和后端媒体 session 绑定，关闭应释放计算资源。
- 2 Mbps 单向媒体约 0.9 GB/小时，双向、多流与云计费方向另算；既有 Fabric 带宽预算不能默认为包含不限量媒体。
- 自建 STUN 不保证所有企业网络可达；TURN/TLS 也不能绕过只允许指定网站的网络策略。

## 13. 里程碑、成本和退出条件

| 里程碑 | 交付 | 初始工程量估计 |
| --- | --- | --- |
| M0：冻结真实场景 | 读取数字人源码、原生媒体基线、语音格式、开发机网络/版本盘点 | 2–4 人日 |
| M1：ICE 基础 | dev STUN、Channel 配置、两端诊断与已有 RTC 修改复核 | 1–2 人周 |
| M2：最小数字人 Preview | 服务登记、必要 HTTP/WS、可信媒体面板、文字及音视频播放 | 2–4 人周 |
| M3：语音与策略 | 宿主麦克风、后端适配、严格直连门禁、恢复/撤销 | 1–3 人周 |
| M4：可选中继与试点 | dev TURN 短期凭证、限额、四网络与手机证据、beta 交接 | 1–2 人周 |

合计约 5–11 人周加 M0，按交付能力拆分可部分并行；不是日历排期承诺。首个固定应用能播放的原型会更早，但不能当作整个生产基础设施完成。M4 可在用户坚持只直连时不启用运行，仅保留设计。

估算不包括任意应用兼容、完整 origin 网关、转码、全球 TURN、GPU 环境自动安装、端到端信任升级或大范围底层库缺陷。M0 若发现必须重写媒体后端、浏览器无法满足原生编码要求或需独立公网资源，应先给差额估算。

退出/调整条件：原生数字人链路本身不通，先修应用；STUN 已可达但目标网无法直连，按策略失败或测试 TURN，不无限换 STUN；媒体面板满足需求则不建设完整 PeerConnection Hook；用户要求任意网页原样运行，再单独评估独立 origin 服务预览。

## 14. 实施前需固定的事实与当前交付

M0 必须固定：数字人仓库/入口、启动与 readiness、SDP/ICE 能力、麦克风协议和编码；开发服务器公网角色、实际 dev HTTPS 入口、可用端口及网络规则；四网络设备与手机浏览器版本；试点允许的媒体中继和流量预算。这些信息缺失不阻碍本提案成立，但不能跳过就宣称已部署。

本轮交付仅为此文档。未修改现有 RTC 代码、发布脚本或线上配置，未安装 coturn、未打开防火墙、未承诺新 URL、未运行媒体或网络测试。后续实现从 M0 开始，使用已有任务与审查/测试/开发交付工作流形成可验证候选。

## 参考资料

- [GeneHub 架构](architecture.md)、[安全模型](security-model.md)、[Relay](relay.md)。
- [既有 HTML 服务代理讨论](html-preview-on-demand.md)、[真实 origin/SNI 方案](assets-daemon-https-sni-tunnel.md)：属于另一条兼容范围更广的路线，本提案不依赖其实施。
- [Cloud 部署说明](../../genethub-cloud/docs/deployment.md)：Channel 与现有服务生命周期。
- [WebRTC TURN 说明](https://webrtc.org/getting-started/turn-server/)：原生中继能力。
- [coturn 官方运行说明](https://github.com/coturn/coturn/blob/master/README.turnserver)：STUN-only 与部署选项，部署时固定具体版本。
