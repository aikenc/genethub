# 可信链接配对与端到端信任升级提案

> 状态：**待实现的跨仓提案**，不是当前能力说明<br>
> 日期：2026-08-11<br>
> 影响范围：`genethub` 与 `genethub-cloud`<br>
> 当前事实仍以 [security-model.md](./security-model.md) 为准

## 0. 结论先行

这次升级的产品规则只有一句：

> **生成链接即批准；打开或扫码即完成配对。**

正常流程不增加“在旧设备上再点批准”、比对验证码、输入口令或返回来源设备等步骤。现有的桌面端、
已授权浏览器、App 和 Linux CLI 仍然生成一条短期一次性链接；新设备打开后自动完成账号接力、
设备密钥生成和授权登记，直接进入工作台。

变化全部放在链接和握手内部：

1. 配对 secret 由用户的可信 daemon 生成并只进入 URL fragment，不再由 Control 生成或兑换。
2. 新设备生成自己的非对称身份密钥；daemon 签发可验证、可撤销的设备证书。
3. Control 只提供账号、目录、路由、在线状态和签名对象分发，不能签出一个有效设备，也不能导出内容密钥。
4. protocol-v4 在现有两条握手消息中加入临时 X25519 Diffie-Hellman，提供前向保密，不增加用户操作或网络往返。
5. 官方托管 Web 仍是客户端信任边界；通过签名发布、可复现构建、独立审计和自建入口给出可验证证据，
   不用一句含糊的“整个平台零知识”代替边界说明。

## 1. 不可回退的用户体验契约

### 1.1 正常旅程必须保持一致

| 来源 | 用户现在做什么 | 升级后仍然做什么 | 新增操作 |
| --- | --- | --- | --- |
| 桌面端 | 点“在另一台设备打开”，复制链接或展示二维码 | 完全相同 | **0** |
| 已授权浏览器 / App | 生成链接，发给或展示给新设备 | 完全相同 | **0** |
| Linux / 无头服务器 | 运行 `genet hub link`，在另一台设备打开输出 URL | 完全相同 | **0** |
| 新浏览器 / 手机 | 点击链接或扫码，等待后进入工作台 | 完全相同 | **0** |
| 已配对设备重连 | 自动连接 | 自动连接，同时换成具备前向保密的会话密钥 | **0** |

官方 Hub 链接保持当前的账号范围：新设备一次登记进用户的 trust domain，不要求为账号下每台机器重复配对。
纯自建、不使用账号控制面的链接保持当前机器范围。

### 1.2 明确禁止的体验回归

- 不在链接打开后要求来源设备“再批准一次”。
- 不显示要求两端人工比对的数字验证码。
- 不要求 Linux 服务器弹窗、扫码或等待键盘确认。
- 不把“登录 Control 账号”当成“已获得机器数据权限”。
- 不在 v4 失败时静默回退到 Control 可签发 secret 的 v3 hosted 通道。
- 不为了展示安全感增加无实际密码学作用的确认页。

**生成链接这个动作本身就是授权动作。** 链接是有效期不超过 15 分钟、只能成功核销一次的 bearer
capability；谁先拿到并打开，谁就获得这次设备登记机会。这是无二次确认体验必须接受并清楚告知的风险，
由短时、单次、来源端可信、设备列表可见和立即撤销共同约束。

### 1.3 唯一前置条件

生成数据授权链接时，至少要有一个已授权 daemon 在线。已授权浏览器和 App 通过现有 E2EE 连接让该 daemon
签发链接；Linux CLI 直接调用本机 daemon。没有可信 endpoint 在线时，Control 可以继续完成普通账号登录，
但不能单独授予机器数据权限。此时应提示“没有在线的可信机器可生成连接链接”，不能降级为 Control 代签。

## 2. 当前代码事实与问题

现有开源配对旅程已经具备正确的交互骨架：

- `packages/workbench/src/devices/machines.ts` 把 `claim` 和 `endpoint` 放在 URL fragment，fragment 不进入 HTTP access log。
- `packages/workbench/src/App.tsx` 发现待配对链接后自动核销，不等待第二次确认。
- `packages/workbench/src/devices/claim.ts` 通过邀请凭证建立加密通道，只发送一次 `device.claim`，成功后保存长期设备凭证。
- `apps/daemon/src/devices.rs` 在 daemon 内存生成 15 分钟一次性 invite，并在加密 claim 中原子消费。

需要替换的是托管通道和 v3 密钥派生：

- `genethub-cloud/server/src/store.ts` 的 `createFabricPeerCapability` 由 Control 生成明文 peer secret；
  `redeemFabricPeerCapability` 再把同一 secret 交给 daemon。
- `workspaces.ts`、`workspace-catalog.ts`、`enrollment.ts` 和 `app-api.ts` 将 `peerSecret` 或
  `channelSecret` 返回给浏览器/控制台。
- `apps/daemon/src/channel_auth.rs` 与 `packages/workbench/src/devices/proof.ts` 只把 PSK 和两个公开 nonce
  输入 KDF，没有临时 DH；日后拿到 PSK 的人可以解开过去记录的会话。
- 当前 machine fingerprint 不是协议实际验证的公钥信任锚；如果 Control 同时替换目录和展示值，
  客户端没有独立证据拒绝假机器。

所以当前 Control 虽然不转发业务明文，却同时具备“知道 hosted peer secret”和“给双方指定机器身份”的能力。
这正是可信度缺口，不应通过换一句营销文案掩盖。

## 3. 目标信任模型

~~~text
已授权桌面 / 浏览器 / App / CLI
              │ 请求生成链接（这一步就是批准）
              ▼
      用户机器上的可信 daemon
      ├─ 本地生成一次性 invite secret
      ├─ 持有 machine identity / enrollment signer 私钥
      └─ 核销后签发新 device certificate
              │
              │ E2EE + PFS
              ▼
          新浏览器 / App
      本地生成 device identity 私钥

Control：账号会话、机器目录、路由票据、在线状态、签名对象分发
Relay：  opaque endpoint / route / frame 转发
二者：   没有 invite secret、设备私钥、daemon 私钥或内容会话密钥
~~~

| 组件 | 升级后的权力 | 明确没有的权力 |
| --- | --- | --- |
| daemon | 保存工作区与 provider 凭证；签发/撤销设备；解密业务内容 | 不能替用户隐藏其本机已被入侵的事实 |
| 已授权客户端 | 持有自己的设备私钥；访问证书 scope 内的机器；请求 daemon 生成新链接 | 不能仅凭 Control session 伪造另一设备 |
| Control | 校验账号与计费/租约；签路由票据；分发公开证书和签名日志；拒绝服务 | 不能生成有效设备证书、替换已 pin 的机器身份或计算内容密钥 |
| Relay | 转发 opaque Fabric 数据并执行容量/路由限制 | 不能读取或伪造加密后的业务 record |
| 托管 Web | 作为运行中的客户端接触本设备密钥和展示明文 | 开源源码本身不能证明某次加载的 JS 未被托管方替换 |
| 模型提供商 | 接收用户明确发送给模型的上下文 | 不因传输 E2EE 而变成“看不到提示和代码” |

恶意 Control 仍然可以看到账号、机器/设备公钥、IP、时间、路由和流量形态，也可以丢包、断连、隐藏更新或返回假路由；
但假路由上的 daemon 无法证明被 pin 的 machine identity，Control 也不能给自己签出可被真 daemon 接受的设备证书。

## 4. Trust domain 与身份对象

托管账号建立一个用户拥有的 `TrustDomain`，用来维持“一条链接后仍能看到当前账号机器”的体验，
同时避免 Control 成为密码学授权者。

### 4.1 密钥和证书

1. **Domain root**：第一台可信 daemon 本地生成 Ed25519 root 和 genesis manifest；Control 只保存公钥与签名对象。
   root 私钥不上传，初始化后封存在本机安全存储，并可导出为用户加密的离线恢复包。
2. **Machine identity**：每台 daemon 本地生成静态 X25519 Noise key 和 Ed25519 signing key；
   加入 trust domain 时由现有管理 signer 签发 machine certificate。
3. **Enrollment signer**：受信 daemon 获得带 `devices:enroll` scope、可单独轮换的 signer certificate。
   桌面、浏览器和 App 不需要复制 root 私钥；它们通过已认证连接请求任一在线 daemon 签发链接。
4. **Device identity**：新客户端在本地生成 X25519 与 Ed25519 key；打开链接后由 daemon 签发
   domain-scoped device certificate。私钥不进入 URL、Control 或 Relay。
5. **Trust log**：新增 signer、root 轮换和撤销使用带前序 hash、单调版本与签名的对象。
   daemon pin 已接受的最高版本，拒绝 Control 提供的回滚版本；移除已失陷 signer 需要旧 root、
   离线恢复 key 或既定数量的其余 recovery signer 共同签名，不能由 Control 单方面完成。

普通设备撤销是 append-only 的签名事件并立即断开当前连接；在线 daemon 直接同步，Control 只作为分发通道。
device certificate 短期化并自动续期，用来限制恶意 Control 故意压住撤销事件时的最长陈旧窗口。
产品应在首次配对完成后建议准备第二个 recovery signer 或离线恢复包，但这不是配对前置步骤。
root/signer 轮换属于恢复操作，可以有明确的安全向导，但不进入日常配对 happy path。

### 4.2 为什么不使用一个账号共享 PSK

把同一个账号主 secret 复制到所有浏览器和机器虽然实现简单，但一台设备泄露后无法单独撤销，
也会让所有机器和历史会话共享同一爆炸半径。每个 endpoint 自己持有私钥、由签名证书表达 scope，
才能做到单设备撤销、机器身份 pinning 和 Control 无法伪造。

### 4.3 账号会话与数据授权必须分层

Control session 继续回答“这个账号可以看到哪些机器、是否有有效订阅、应该走哪条 route”；
daemon certificate 回答“这个密码学设备能否读取或控制这台机器”。必须两者同时成立：

~~~text
Control account/route allow  AND  daemon verifies signed device identity
                         =  access
~~~

Control 被绕过时不能拿到 route；Control 被攻破时也不能仅凭 session 进入 daemon。

## 5. 一条链接的完整内部流程

### 5.1 来源端生成

外部 API 和 UI 可以继续叫 `hub.claimLink` / “在另一台设备打开”。内部改为：

1. daemon 验证请求来自 loopback 或已有设备凭证，并检查 `devices:invite` scope。
2. daemon 本地生成 `inviteId + 256-bit secret`，只在内存保存，TTL 保持 15 分钟，最多成功消费一次。
3. 托管形态下，daemon 向 Control 申请**账号 transfer ticket 和 opaque route**；它们不含数据面 secret。
4. daemon 或当前工作台在可信端本地组合最终链接。invite secret 只放在 fragment，例如：

   ~~~text
   https://app.genethub.com/#/pair?v=4
     &route=<opaque>
     &invite=<invite-id>.<secret>
     &login=<optional-control-transfer-ticket>
   ~~~

5. 来源端立即显示链接/二维码。至此授权已经完成，后续没有等待批准的状态。

### 5.2 目标端打开

1. 工作台先从 fragment 读入参数，在加载任何第三方资源前用 `history.replaceState` 清掉地址栏 secret；
   配对入口禁用 analytics，设置 `Referrer-Policy: no-referrer` 和严格 CSP。
2. 浏览器本地生成不可导出的 device keys；不支持不可导出 `CryptoKey` 的环境使用受保护存储并明确标注能力差异。
3. 若包含 Control transfer ticket，自动换取账号 session。这个 session 只用于目录和 route。
4. 目标端用 invite PSK + 双方临时 X25519 建立 protocol-v4 bootstrap channel。
5. 在加密通道内发送一次 `device.claimV4 { devicePublicKeys, deviceName }`。
6. daemon 在同一原子操作中消费 invite、签发 device certificate、写入授权记录并返回证书与真实 machine identity。
7. 浏览器验证证书链和 machine identity，保存自己的私钥/证书，进入工作台。

用户看到的仍然只是“打开链接 → 正在连接 → 工作台”。步骤 2–7 全部自动执行。

### 5.3 后续重连

Control 返回 route 和目标的签名 machine record；客户端先检查它与本地 pin/trust manifest 一致，
再用 device certificate 建立具备 PFS 的会话。Control 不再返回 `peerSecret`，daemon 也不再兑换
`channelSecret`。证书续期和会话换钥都在后台完成。

### 5.4 Linux / 无头服务器

~~~bash
genet hub link
# Open this URL on another device:
# https://app.genethub.com/#/pair?...
~~~

命令通过本机受保护 IPC 调 daemon；daemon 完成 §5.1，CLI 只打印 URL。服务器不需要 GUI、摄像头、
人工输入验证码或随后按 Enter。若 daemon 不在线，CLI 先按现有监督机制启动/连接它；若机器未建立 trust domain，
返回一条具体的初始化错误，不让 Control 代签。

### 5.5 失败反馈

| 情况 | 目标端行为 |
| --- | --- |
| 链接过期或已经被使用 | “链接已失效，请从已授权设备重新生成。” |
| 两个设备同时抢同一链接 | 只有 daemon 原子核销成功的一方完成；另一方显示已失效 |
| 来源 daemon 离线 | 保留账号登录结果，但不授予数据权限；提示可信机器离线 |
| machine identity 变化 | 阻断，不自动接受 Control 返回的新指纹；提示恢复/轮换或潜在攻击 |
| v4 不受支持 | 明确提示升级来源端或目标端；不回退 v3 hosted secret |
| 本地密钥存储被浏览器清除 | 视为新设备，重新打开一条链接；不从 Control 恢复私钥 |

## 6. Protocol-v4：不增加往返的前向保密

### 6.1 默认协议选择

协议 ADR 的默认基线采用经过公开分析的 Noise patterns：

- invite bootstrap：`Noise_NNpsk0_25519_AESGCM_SHA256`；
- 已登记设备：`Noise_IK_25519_AESGCM_SHA256`，静态 key 必须由 `DeviceCertificate` /
  `MachineCertificate` 验证；
- Noise `Split` 产生独立的 client→daemon 与 daemon→client key，沿用严格单调序号和 transcript-bound AAD。

如果浏览器实现评审最终选择 TLS 1.3 PSK+(EC)DHE 或另一种标准 AKE，必须满足本提案全部验收条件，
并通过单独 ADR 和密码学评审；不能继续自创“PSK + 公开 nonce”KDF。

### 6.2 消息与延迟

现有 `PeerHello` 携带 v4 initiator handshake message，现有 `PeerWelcome` 携带 responder message；
因此仍是一个 request/response，不增加网络 RTT。invite 的 `device.claimV4` 对应当前已有的
`device.claim` 加密 RPC，也不增加用户动作。

每次连接使用新的 ephemeral X25519 key，完成握手后立刻擦除。即使日后设备长期私钥、invite PSK
或 Control 数据库泄露，攻击者也不能仅靠录下的旧流量恢复已经结束的会话 key。正在运行的 endpoint
被攻破、密钥使用前被窃取或恶意客户端主动导出明文，不在 PFS 能解决的范围内。

### 6.3 降级、重放与绑定

- `DATA_PLANE_VERSION` 升到 4；v3/v4 transcript、record key 和证书域完全分离。
- v4 account 激活后，hosted `PeerAuth::Hosted` 必须 fail-close，不保留 secret fallback。
- 握手绑定 protocol version、trust domain、route handle、双方身份 key、证书 hash、scope 和方向。
- invite ID 在 daemon 本地原子消费；Noise transcript 和 record sequence 防止跨连接/跨方向重放。
- target machine key 不匹配本地 pin 或签名目录时，在任何业务 RPC 前断开。

## 7. 跨仓接口改造

### 7.1 `genethub-cloud`：Control 退回路由与公开信任对象

删除：

- `fabric_peer_capabilities.secret` 及其明文生命周期；
- 所有 `peerSecret` / `channelSecret` HTTP 和 Console 字段；
- daemon 的 `/api/fabric/v2/peer-admissions/redeem` secret 兑换语义；
- 把 Control 下发的 `targetFingerprint` 当作唯一机器身份依据。

保留：

- 账号 session、transfer ticket、机器/工作区目录；
- Fabric endpoint / route ticket、presence lease、撤销和限额；
- 审计所需的 actor、target、时间与结果元数据。

新增：

- trust domain 的公开 root、签名 manifest、machine/device certificate 与 revocation blob 存储；
- 只允许带有效账号 session 的 route 申请，但返回值只含 opaque route 与签名公开对象；
- root/manifest 更换必须携带旧 root 认可的 rotation proof；Control 不能自行覆盖；
- 数据库和日志的 secret 扫描门禁。

主要落点：

- `server/src/db.ts`、`server/src/store.ts`；
- `server/src/http/workspaces.ts`、`workspace-catalog.ts`、`enrollment.ts`、`app-api.ts`；
- `server/src/http/peer-admission.ts`；
- `console/src/api.ts`、`console/src/host.ts` 及相应契约测试。

### 7.2 `genethub`：endpoint 成为最终授权者

主要落点：

- 协议：`packages/proto/src/data.rs`；
- Rust 握手：`apps/daemon/src/channel_auth.rs`、`dataplane/handshake.rs`、`transport/admission.rs`；
- Web 握手：`packages/workbench/src/dataplane/handshake.ts`、`devices/proof.ts`；
- 身份/证书/撤销：`apps/daemon/src/devices.rs` 及新的 trust-domain 模块；
- 自动 claim：`packages/workbench/src/devices/claim.ts`、`devices/machines.ts`、`App.tsx`；
- 链接统一：`apps/daemon/src/link.rs`、`apps/cli/src/hub.rs`、`packages/workbench/src/session/store.ts`。

`hub.claimLink` 可以保持外部 RPC 名称和返回 URL 的形状，daemon 内部将 Control 的账号 transfer ticket
与本地 `device.invite` 合并。这样桌面托盘、Web 设置页和 CLI 不需要出现第二套入口。

## 8. 能承诺什么，不能承诺什么

完成协议、迁移、审计门禁后，可以准确承诺：

> 你的代码和会话在已授权设备与自己的 GeneHub daemon 之间端到端加密。Control 和 Relay 不持有内容密钥，
> 也不能仅凭账号会话签出一台可被 daemon 接受的设备。

还必须同时披露：

- Control/Relay 能看到账号、设备和机器公开身份、IP、在线状态、路由、时间、大小和流量形态。
- Control/Relay 可以拒绝服务；Control 还可以隐藏目录或撤销更新，但伪造对象会被本地 pin 和签名校验拒绝。
- 官方托管 Web 是一个可信 endpoint：运行中的 JS 能接触本浏览器的密钥和明文。
- 用户选择的模型提供商/第三方 agent 会收到完成任务所需的上下文。
- endpoint 在使用期间被攻破时，E2EE 和 PFS 都不能保护已经在该 endpoint 上出现的明文。

因此对外不使用无边界的“整个平台零知识”。更可信的表达是“Control/Relay 无内容密钥”、
“设备持有密钥”和“可验证的端到端加密”，并把证据直接链接出来。

## 9. 可信度不是一句文案：交付证据

### 9.1 产品内可见证据

设置页增加一个不打断配对的“安全”区域：

- 当前连接：`E2EE v4 · Forward Secrecy`；
- 已验证 machine key 的短指纹和首次 pin 时间；
- 已授权设备、签发来源、最近连接和立即撤销；
- “Control/Relay 看得到什么 / 看不到什么”的短说明；
- 当前客户端版本、构建 hash、源码 tag 和审计报告链接。

这些信息在成功后可查，不变成配对前置弹窗。

### 9.2 发布与工程证据

- 桌面/CLI/daemon 发布物签名、SHA256、SBOM 和 provenance；
- Web 使用独立静态 origin、无第三方脚本的 pairing entry、版本化不可变资源和签名 asset manifest；
- 提供可复现构建说明，让发布 hash 能对应公开源码；
- 对 trust-domain、Noise 实现、密钥存储和 Web 供应链做独立安全审计并公开报告/修复状态；
- 建立安全联系、漏洞披露、密钥轮换与事故通知流程；
- 发布一页可机器核对的安全声明，而不是只在营销页写“zero knowledge”。

浏览器无法只靠由同一服务器下发的 JavaScript 证明“服务器没有临时换掉它”。需要最高保证的用户应使用
签名桌面端、固定版本的自建工作台，或未来由本地可信壳验证签名 asset manifest 后再加载 Web bundle。

## 10. 迁移与发布顺序

### 阶段 0：先冻结体验

先为桌面、浏览器/App、Linux CLI 和链接目标页补齐 journey tests，记录用户动作数、页面数、协议往返和失败文案。
任何后续 PR 让 happy path 多一次点击即失败。

### 阶段 1：在开源路径落地 v4

实现身份 key、Noise 握手、证书与现有 daemon-local invite 的 v4 claim；先覆盖 loopback、自建 Relay 和直接设备凭证。
此时不更改托管安全文案。

### 阶段 2：托管 trust domain 与无 secret Control

完成两仓契约，`hub.claimLink` 返回组合链接，Control API 不再产生或返回内容 secret。按账号原子启用 v4：
同一个账号的 Console、Web、daemon 和 Control 全部就绪后才切换，不做逐连接静默降级。

### 阶段 3：迁移旧设备

- loopback 桌面和已有 daemon-local device credential 可在当前可信通道内自动生成 key 并换取 v4 certificate。
- 仅拥有旧 hosted Control session 的浏览器**不能安全地静默升级**：Control 知道旧 secret，也能模拟同一升级。
  这类设备必须一次性重新打开由可信 daemon 生成的链接。动作仍是当前的“生成链接 → 打开链接”，没有新增批准步骤。
- 若正式用户量允许，优先硬切并清理 v3 hosted session，避免长期维护两套信任模型。

### 阶段 4：删旧字段后再更新承诺

数据库 migration 清除 `fabric_peer_capabilities.secret`，生产日志/备份确认不再出现 channel secret，
安全测试和独立审计通过后，才使用 §8 的新对外表述。任何一个门禁未通过，README 继续保留当前限制。

## 11. 可拆分的实施工作包

| 工作包 | 仓库 | 交付物 | 前置 |
| --- | --- | --- | --- |
| UX-0 | open | 四类 journey 的动作数/页面数基线测试 | 无 |
| CRYPTO-1 | open | v4 Noise handshake、双向 record key、known-answer 与 downgrade 测试 | UX-0 |
| TRUST-2 | open | machine/device keys、证书、pin、签名撤销和安全存储 | CRYPTO-1 |
| LINK-3 | open | `hub.claimLink` + local invite 合并；App/Web/CLI 同一链接 | TRUST-2 |
| CONTROL-4 | cloud | route-only API、公开签名对象存储、删除 secret 字段 | TRUST-2 |
| CONTRACT-5 | both | 两仓 schema fixture、兼容矩阵、恶意 Control 集成测试 | LINK-3, CONTROL-4 |
| MIGRATE-6 | both | account-level cutover、旧 session 重配对、回滚只回版本不回安全模型 | CONTRACT-5 |
| EVIDENCE-7 | both | Trust Center、可复现构建、审计与发布声明 | MIGRATE-6 |

每个工作包可以独立评审和测试，但 production 切换必须在 CONTRACT-5 通过后按账号原子开启。

## 12. 发布门禁与验收场景

### 12.1 用户体验

- 桌面：来源端一次点击生成，目标端一次点击/扫码后直接进入工作台。
- 浏览器/App：同上；来源端不出现待批准队列。
- Linux：`genet hub link` 输出一个 URL；除目标打开外不需要第二个命令。
- hosted 账号一条链接后保持原机器可见范围，不出现逐机器确认。
- protocol-v4 相比 v3 不增加握手 RTT；正常重连无新 UI。

### 12.2 密码学与恶意基础设施

- 记录一条完整 v4 会话，再泄露长期 device key、invite PSK 或 Control 数据库，仍不能解密历史 record。
- Control 任意构造 session、route、fingerprint、certificate 或 peer hello，真 daemon 都拒绝未获用户 signer 认可的设备。
- Control 把客户端引到假 daemon 时，客户端在业务 RPC 前因 machine identity 不匹配而中止。
- Relay 重放、换方向、跨 route 注入或篡改 record 时 fail-close。
- v4 client/server 任一侧收到 v3 hosted fallback 都明确失败。

### 12.3 链接与撤销

- 同一 invite 100 个并发 claim 只有一个成功。
- HTTP access log、Control DB、Relay log、analytics 和 crash report 中都没有 fragment secret。
- 撤销设备立即断开活动连接；新连接失败；Control 重放旧 manifest 不得降低 daemon 已 pin 的版本。
- 浏览器清除存储后不能仅靠 Control session 恢复 device private key。

### 12.4 跨仓契约

- Control 的公开响应和 Console 类型中不存在 `peerSecret` / `channelSecret`。
- daemon 不调用 secret redemption endpoint；数据库 schema 和备份迁移不保留活跃 peer secret。
- open/cloud 固定 fixture 同时验证 route、证书、scope、错误码和版本协商。
- 生产灰度指标只记录版本、结果和延迟，不记录 key、proof、证书私有材料或链接 fragment。

## 13. 参考设计及取舍

| 项目 / 标准 | 借鉴点 | GeneHub 不照搬的部分 |
| --- | --- | --- |
| [Tailscale control/data plane](https://tailscale.com/docs/concepts/control-data-planes) 与 [Tailnet Lock](https://tailscale.com/docs/features/tailnet-lock) | endpoint 持有私钥；Control 分发公开 key；用户控制的签名阻止恶意 Control 插入节点 | 不增加目标端向来源端请求并等待人工批准的流程 |
| [Syncthing security](https://docs.syncthing.net/v1.29.0/users/security.html) 与 [Device IDs](https://docs.syncthing.net/v1.23.1/dev/device-ids.html) | 设备身份来自公钥；relay 不应获得内容密钥；最终设备列表在 endpoint | GeneHub 用一次性链接自动交换授权，不要求人工抄 Device ID |
| [Noise Protocol](https://noiseprotocol.org/noise.html) | 标准化的两消息 PSK/静态 key AKE 和 transcript binding | 不自行发明新的握手 pattern |
| [TLS 1.3 §2.2](https://www.rfc-editor.org/rfc/rfc8446.html#section-2.2) | PSK 与 (EC)DHE 结合才获得前向保密；PSK-only 没有 | GeneHub 的应用层 carrier 需要适合 WebSocket/WebRTC 的实现 |
| [Signal Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) | 把前向保密和密钥妥协后的恢复当作明确协议属性 | 第一阶段先保证每连接 PFS，不把消息级 ratchet 强塞进 request/response 数据面 |
| [Bitwarden security whitepaper](https://bitwarden.com/resources/zero-knowledge-encryption-white-paper/) 与 [Proton Key Transparency](https://proton.me/files/proton_keytransparency_whitepaper.pdf) | 精确威胁模型、公开审计和可验证 key 目录比口号更能建立信任 | 不宣称模型服务、运行中的托管 Web 或 endpoint 本身“零知识” |

本提案的原则是：借鉴成熟项目的**可验证机制和证据链**，同时保留 GeneHub 已经正确的“一条链接直达”体验。
