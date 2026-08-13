# 安全模型

> 上位文档：[architecture.md](./architecture.md)  
> 本文回答三个问题：**谁能看到什么、什么东西泄露了怎么办、哪些事绝对不做。**

---

## 1. 信任边界

```
┌───────────┐    TLS     ┌────────────┐    TLS     ┌────────┐
│ 浏览器/手机 │◄══════════►│   relay    │◄══════════►│ daemon │
└───────────┘            │ 只搬字节    │            └───┬────┘
      │                  └────────────┘                 │ 准入在这里判：
      │ 账号（仅托管部署时）                              │ 本地已授权设备列表
      ▼                                                  │
┌────────────────────────────────────────────────────────┐
│ 控制面 ── 托管形态的账号准入、通道 secret 与可续租授权        │
└────────────────────────────────────────────────────────┘
```

| 组件 | 信任级别 | 能看到 | 看不到 |
|------|----------|--------|--------|
| relay | **按不可信设计** | IP、时序、包大小、opaque endpoint/route/outer-stream id、初始 peer hello | 没有 peer secret；Exchange method/metadata/body 是密文且不落库 |
| 控制面 | **托管形态需信任** | 账号、连接元数据、它生成的临时 channel secret | 业务帧不经过它，但它技术上可持密钥仿冒客户端；不是零知识 |
| daemon | 可信（你自己的机器） | 全部 | — |
| 托管 Web 前端/桌面壳 | 可信 | 浏览器或本机持有的凭证与明文 | — |

**自建部署里根本没有控制面**：relay + 静态工作台两个东西就够，授权全靠配对（[self-hosting.md](./self-hosting.md)）。托管部署为了账号设备、撤销和租约引入 Control，并明确把它和托管前端列入信任边界，不能把 Relay 的无内容密钥性质扩大到整个平台。

relay 与控制面是两个进程、两个仓库，这不是部署细节而是安全边界：合并部署就等于合并权限。依赖方向由 CI 检查守着（[architecture.md](./architecture.md) §6.4），靠的是构建失败而不是自觉。

### 1.1 现在的加密到什么程度，说清楚

**转发业务帧现在对 Relay 加密。** 客户端与 daemon 先基于配对 PSK 或 hosted peer secret 做双向 HMAC proof；随后派生本次 peer link 的 AES-256-GCM key，用严格方向序号和绑定 version/context/direction/sequence 的 AAD 封装每个 protocol-v3 record。AES-GCM 已同时提供机密性与完整性；HMAC 用于握手与 key derivation，不再给每个 record 叠加第二个 MAC。Relay 能看元数据、丢包、延迟或重放密文，但没有 secret 就不能读取或伪造；重放与串 peer 注入会因序号、方向、context 或 AEAD tag 不匹配而 fail-close。

**这不是整个平台零知识，也没有前向保密。** Hosted peer secret 由 Control 生成：一份随短期 Fabric connection admission 交给浏览器，一份由目标 daemon 通过 HTTPS 兑换。Control/平台运营方技术上知道该 peer secret，并可主动仿冒客户端；托管 Web 前端也能接触浏览器侧凭证。当前对称 PSK 不提供独立公钥握手、密钥妥协后的前向保密或可验证客户端代码。

因此对外表述统一为：

> Relay 不持有 peer secret，Exchange 和业务 frame 对它是带认证的密文；它仍能看到连接元数据、初始有界 peer hello 并拒绝服务。托管 Control 生成临时 peer secret，平台不是零知识。公钥握手与前向保密尚未实现。

可以写“Relay 单独无法解密或伪造业务内容”；不要写“Hub/平台技术上无法查看或控制”。
不增加用户操作、同时移除这项 Control 权力的目标设计见
[可信链接配对与端到端信任升级提案](./trusted-link-pairing.md)；它是待实现方案，不能提前当成当前能力宣传。

### 1.2 当前显示指纹还不是公钥信任锚

当前界面里的 fingerprint 是由 machine id 与共享 secret 导出的展示摘要，不是 daemon 非对称公钥；Control 数据库里名为 `public_key` 的字段目前也存放这个展示值。它可以帮助人区分记录，但协议没有用它验证签名，前端也没有第二条可信来源，因此目前不能宣称已具备公钥核验或中间人自动告警。

未来的 canonical machine identity 需要一起落地：daemon 持有不可导出的非对称身份私钥；协议实际验证对应签名；桌面壳从本机 daemon 获得独立公钥；用户确认后 pin 公钥；后续变化必须阻断并明确提示轮换或攻击。只有这些闭环完成后，界面才应把它称为“公钥指纹”或“安全锚”。

在此之前，托管 Control 能替换机器目录和展示摘要，仍属于必须信任的组件。

---

## 2. 凭证清单

| 凭证 | 存放 | 生命周期 | 泄露后果 | 可否单独撤销 |
|------|------|----------|----------|--------------|
| **设备凭证**（daemon 签发） | 客户端本地；daemon 本地（明文，权限 600） | 长期 | 该设备身份被冒用，可远程连这台机器 | ✓（机器上删一行） |
| **配对邀请码** | 只在一次性链接/二维码里 | ≤ 15 分钟，一次性 | 一台设备被加进授权列表 | ✓（过期或用掉即失效） |
| 设备会话 token | 客户端安全存储；控制面存哈希 | 长期，可「信任 30 天」 | 该设备身份被冒用 | ✓ |
| 设备转移链接 | 一次性 URL | ≤ 15 分钟，一次性 | 一个新设备会话 | ✓ |
| 恢复密钥 | 桌面本地；控制面存哈希 | 长期 | 临时身份被接管 | ✓ |
| 设备码 / enrollmentToken | Control 可能短期明文存储，消费或过期后清除 | ≤ 10 分钟 | 可把机器登记到攻击者账号 | ✓（过期即失效） |
| daemon enrollment secret | daemon 本地；控制面存 verifier | 长期 | 可冒充该机器申请 Fabric endpoint/admission | ✓ |
| Fabric endpoint ticket | URL 查询串或 bearer | 短期、单次 | 一次 endpoint 接入机会 | ✓（用即作废/撤销） |
| Fabric route ticket | E2EE client 取得，Fabric OPEN 携带 | 短期、单次 | 一次到指定 opaque target 的 outer stream 机会 | ✓（用即作废/撤销） |
| hosted peer secret | 浏览器短期持有；daemon 兑换；Control 在待兑换窗口内存明文 | 短期，兑换、撤销或过期后清除 | 在窗口内可认证或仿冒对应 peer | ✓（撤销/到期） |
| RTC 临时 secret | 只在已认证 E2EE signaling stream 与 daemon 内存中 | ≤ 30 秒完成认证 | 在窗口内可尝试接入该 RTC PeerConnection，但不扩大继承权限 | 过期/连接关闭 |
| 本机密钥 | daemon 启动时生成，仅写入当前用户可读的 `endpoint.json` | 进程生命周期 | 可签发本机 daemon 的准入与控制 proof | 重启即换 |
| 本机 WebSocket 准入 | stdout / CLI / Tauri IPC 中的一次性 URL | ≤ 15 秒且单次核销 | 一次本机连接机会 | 用即失效 |

Fabric endpoint ticket 走查询串是不得已：浏览器发起 WebSocket 握手时无法设置请求头。代价用两条约束抵消——一次性、短期，并且核销与校验在同一事务中完成，两个并发接入不可能都成功。route ticket 与 peer capability 分域，拿到 endpoint admission 不等于获得 daemon 业务权限。

---

## 3. 分享与扫码

账号名下挂的是**能执行任意代码的电脑**，所以"分享链接 = 登录同一账号"这种做法在这里等于交出机器。规则：

| 规则 | 要求 |
|------|------|
| 授予对象 | 一个**设备会话**，不是账号本身 |
| 有效期 | ≤ 15 分钟 |
| 使用次数 | 1 次，核销即废 |
| 可见性 | 原设备能看到「已在某 IP / 某浏览器被使用」，可一键撤销 |
| 二次确认 | 删除机器、升级账号、把机器设为可被他人访问 —— 必须在已信任设备上确认 |
| 异常处置（未来） | 同一链接短时间内多 IP 尝试时自动作废并告警；当前不能把它当作已部署防线 |

**扫码只是打开同一条链接的另一种方式。** 链接必须由已授权 daemon、浏览器或 App 主动生成；
“生成链接”这个动作本身就是批准。目标设备点击或扫码后应自动核销并完成配对，不再回到来源设备做第二次确认或比码。
代价也必须说清楚：链接是短期一次性 bearer capability，截图或转发给别人意味着允许最先核销的人加入；
所以它必须短时、单次、用后可见并能立即撤销。由未授权新设备先发请求、再等待旧设备批准是另一种产品流程，
不应混进 GeneHub 当前的一条链接直达体验。

---

## 4. 转发准入：Relay 只判 opaque admission，daemon 执行 peer 认证

**Relay 永远不做业务准入决策。** 它只向 authority 核验 opaque endpoint/route ticket。自建形态由 daemon 的本地设备表判断；托管形态由 Control 先核验账号、来源 session 和目标机器，签发短期 Fabric route 与独立 peer capability，daemon 只接受能证明持有兑换所得 secret 的 peer。Control/Relay revocation 或 presence lease 失效会关闭 outer stream；不会降级为匿名访问。

daemon 本地维护一份已授权设备列表，形态就是 `authorized_keys`——设备名、首次接入时间、最后活跃时间。撤销就是删一行并断开那条连接，立即生效，不依赖任何推送到达。

```
客户端与 daemon 各自接入 Relay Fabric endpoint
        │
        ▼
客户端用 opaque route ticket 打开一条到 daemon 的 outer stream
        │
        ▼
daemon 完成 PSK 双向证明并检查设备/workspace scope → 放行或断开
```

### 4.1 配对：生成链接即批准，核销后换长期凭证

机器出示一个一次性、≤15 分钟的配对链接（附二维码）。客户端打开后换到一份**长期设备凭证**存在本地。链接用掉即废，所以它泄露的上限是"一台设备被加进列表"，而不是"永久访问权"——§3 那几条规则在它身上继续成立。

这跟"分享链接 = 登录同一账号"是两回事，后者等于交出机器。

### 4.2 双向证明，凭证不过线

rendezvous 槽位可能被抢占：谁知道那个 id，谁就能抢先挂上去冒充这台机器。所以连接建立后双方必须各证明一次，用配对时的共享秘密，**秘密本身不发送**：

```
客户端 → 机器：context、随机数 clientNonce、HMAC(client proof)
机器  → 客户端：随机数 serverNonce、HMAC(server proof)
双方：由 secret + context + 两个 nonce 派生本次 peer-link AEAD key
```

抢占者两个方向都答不出来。随机数不允许重复使用，所以截获一次也没法重放。

这里不需要 TOFU：客户端在配对时就已经持有这台机器的秘密，之后每次都是拿已知秘密做强认证，不存在"首次信任"这个环节。指纹告警只对"机器目录由服务端下发、客户端从未直接配对过"的场景有意义。

### 4.3 托管部署上叠加的东西

托管浏览器从 Control 取得一次性 Fabric endpoint ticket、route ticket、opaque peer capability 和随机 peer secret。Relay 只核销 endpoint/route ticket 并转发 `PeerHello`；daemon 使用 enrollment credential 直接向 Control 兑换同一 secret，然后双方完成 protocol-v3 proof。业务 identity、Exchange 和 Preview 内容只在 E2EE 建立后发送。

Relay 维护 Control 签发的 endpoint presence lease，并订阅 endpoint/route revocation；失去 revocation 同步时 fail-close 当前 endpoints。这能限制旧 ticket 和被撤销 connection 继续生效，但不能防御已持有 peer secret 的恶意 Control。

### 4.4 其余要点

- 限额是必需品：endpoint/stream 数、pending admission、单连接与进程缓冲、单帧大小（[relay.md](./relay.md) §5）。
- 自建 relay 的 join token 只约束机器挂上行连接。客户端只能连到已存在的槽位，白吃流量得先占一个槽位。
- 初始 `PeerHello` 可能暴露通用 client label、RTC capability、device/invite/capability selector、nonce 与 proof；设备展示名和新签发凭证在 proof 后的加密 Exchange 中返回。Relay 看不到 PSK、peer secret 或新凭证。

---

## 5. 事故响应

| 事故 | 处置 |
|------|------|
| 配对链接泄露 | 它一次性且 ≤15 分钟；若已被用掉，在机器的设备列表里撤销那台设备 |
| 某台设备丢了 | 在机器上撤销那一行，连接立即断开。不需要联系任何服务端 |
| 转移链接泄露 | 撤销链接 + 撤销由它创建的设备会话 |
| 控制面数据库泄露 | 长期 credential verifier/token 主要存哈希，但活跃 channel secret、未消费 enrollment token 等可能在短期窗口内以明文存在。立即撤销活跃通道与待消费登记、强制设备会话下线、轮换 Control↔Relay token，并按暴露时间窗审计；daemon 自签设备凭证不因数据库副本本身自动泄露 |
| 某台机器被入侵 | 机主在那台机器上清空授权列表并轮换身份；无法登录该机器时，在控制面撤销登记以断掉上行 |
| daemon 本机密钥泄露 | 重启 daemon 即更换；同时检查谁能读取当前用户的数据目录。stdout、CLI 输出和 Tauri IPC 都不应出现该密钥 |
| relay 被滥用 | 收紧限额；必要时轮换控制面与 relay 之间的 token |

---

## 6. 部署基线

| 规则 | 原因 |
|------|------|
| **托管工作台静态文件的机器上不跑 daemon** | daemon 会把执行能力开在这台机器上；工作台是纯静态产物 |
| 纯静态托管时，`/api/*`、`/ws` 直接返回 404 | 避免 SPA 兜底把探测请求答成 200。同域部署（工作台与控制面同一个 origin）不适用这条，那里 `/api` 本来就是控制面 |
| 应用服务只监听 `127.0.0.1`，由反向代理终止 TLS | 不暴露明文端口 |
| 任何常驻服务都要有重启策略 | 容器用 `unless-stopped`；非容器进程用 systemd |
| 服务器上如果确实要跑 daemon：独立低权限用户 + 限定 workspace + 不放 provider 凭证 | 限制被攻破后的爆炸半径 |
