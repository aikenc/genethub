# GeneHub 控制面（账号 · 设备 · 机器 · 租用）

> 上位文档：[architecture.md](./architecture.md)　安全规则：[security-model.md](./security-model.md)　旅程：[product-ux.md](./product-ux.md)

**一句话定位：Hub 管身份、机器目录与租用；顺带承载一个不看内容的转发层。**

Hub 由两个模块组成，同一部署但严格分层——`control/` 与 `forward/` 的边界规则见 [architecture.md](./architecture.md) §6.4。本文只讲 `control/`。

---

## 1. 职责

| 职责 | 说明 |
|------|------|
| 身份 | 临时用户、正式用户、设备会话 |
| 机器登记 | 设备码授权 + 登记，维护机器归属与在线状态 |
| 连接授权 | 决定谁能连哪台机器，按通道类型下发不同凭证 |
| 租用 | 公开池、租约、强制收回 |
| 审计 | 谁在什么时候对哪台机器做了什么 |

**不负责**：agent 的对话内容存储、代码托管、provider 计费（MVP 阶段）。

---

## 2. 架构分层

```
                     ┌──────────────────────────────┐
   Desktop ─────────►│ /api/device-authorizations/* │  机器面
   （genet-daemon）  │ /api/machines/enroll         │  显式版本化，
                     │ /api/machines/{id}  DELETE   │  只能加字段不能改语义
                     │ WS  执行通道（仅租用）         │
                     └──────────────────────────────┘
                     ┌──────────────────────────────┐
   Web / Mobile ────►│ /app/auth/*  /app/machines/* │  应用面
   （GeneHub 前端）  │ /app/rentals/* /app/audit/*  │  可随前端一起演进
                     └──────────────────────────────┘
```

两面都是自有契约，但**演进速度必须分开**：应用面和前端同版本发布，改了立刻生效；机器面对着的是散落在用户电脑上、可能几个月不升级的 daemon，一旦发出去就要长期兼容。混在一起的后果是应用面的一次小重构，把老版本的机器集体踢下线。

规则：机器面路径带版本号，字段**只加不改**，删除要经过一个完整的弃用周期。

---

## 3. 数据模型（MVP）

```text
users
  id, kind(temp|full), email?, github_id?, display_name,
  created_at, upgraded_from_temp_id?, disabled_at?

device_sessions              -- 浏览器 / 手机 / 桌面壳上的登录态
  id, user_id, name, platform, refresh_hash,
  ip_first_seen, ua_first_seen,
  trusted_until?, last_seen_at, revoked_at?

transfer_links               -- 换设备用的一次性链接 / 二维码
  id, user_id, purpose(device_transfer|upgrade),
  token_hash, expires_at, max_uses(默认 1), used_count,
  approved_by_device_id?,   -- 需要原设备确认时填
  consumed_by_device_id?, revoked_at?

recovery_keys                -- 临时用户的救命稻草（见 §7）
  id, user_id, key_hash, created_at, last_used_at?, revoked_at?

machines                     -- 一台 PC = 一个 daemon 关系
  id, owner_user_id, name, platform,
  daemon_id, server_id, daemon_public_key,
  credential_verifier,       -- base64url(sha256(secret))，只存哈希
  ws_session_id?, state(pending|active|revoked),
  visibility(private|public), last_seen_at, agent_version

device_authorizations        -- 设备码授权临时态
  id, device_code_hash, user_code, display_name,
  claimed_by_user_id?, status(pending|approved|denied|expired|enrolled),
  enrollment_token_hash?, expires_at, interval_seconds, last_polled_at

rentals
  id, machine_id, renter_user_id, status(active|ended|revoked),
  workspace_path, limits_json,     -- 见 §6 隔离约束
  starts_at, ends_at, ended_reason?

relay_invites                -- relay 准入（MVP 后）
  id, code_hash, issued_to_user_id?, max_uses, used_count,
  expires_at, revoked_at?

audit_logs
  id, at, actor_user_id?, actor_device_id?, action,
  target_type, target_id, ip, user_agent, detail_json
```

相对上一版的三处删改，都是被上游事实推翻的：

- **删掉 `offer_vault_ref`**：offer 不由 Hub 保管转发。Hub 存 `server_id` + `daemon_public_key` 是为了展示和校验，不是为了当作可回收的通行证。
- **删掉 `connection_grants` 的"背后换 offer"语义**：改为按通道类型区分授权（§5）。
- **`magic_links` 改名 `transfer_links` 并默认一次性**：它不再等于"账号登录链接"（§4）。

---

## 4. 身份与会话

| 身份 | 获得方式 | 能力 |
|------|----------|------|
| 临时用户 | 桌面端「先体验」 | 绑定并使用自己的机器；不能公开机器、不能租用他人机器 |
| 正式用户 | 邮箱 / GitHub | 全部能力；换设备不丢 |
| 设备会话 | 桌面端首启、扫码、一次性链接 | 具体某个浏览器/App 上的登录态，可单独撤销 |

**关键改动：链接授予的是设备会话，不是账号本身。**
一次性、短 TTL、原设备可见可撤销；敏感操作（公开机器、发起租用、升级账号、删除机器）要求在已信任设备上确认。理由与攻击面见 [security-model.md](./security-model.md) §3。

---

## 5. 连接授权：两条通道，两套凭证

```
用户点「连接」
   │
   ├─ 目标是自己的机器 ──► Hub 校验归属 ──► 下发 offer 给该设备会话
   │                                         （端到端加密，Hub 看不到内容）
   │
   └─ 目标是租来的机器 ──► Hub 校验租约 ──► 走 Hub 执行通道代理
                                             （可撤销、可审计，Hub 可见内容）
```

**自有机器**：Hub 把 offer 交给已认证的设备会话，客户端直连 relay。offer 一旦交出就无法单独回收，所以只发给"本来就拥有整机权限"的机主设备，并在审计里记录每一次下发。

**租来的机器**：不下发 offer。租客的操作作为 `hub.execution.*` 请求经 Hub 转发到 daemon，Hub 负责按租约校验、限流和记录。租期结束只要停止转发即可，无需触碰机器密钥。

这就是为什么租用的能力面比自用窄——这是有意的取舍，不是没做完。

---

## 6. 租用：先把隔离说清楚再谈功能

租一台机器意味着在别人的电脑上跑 agent。默认状态下这等于交出整机，所以**公开机器必须先满足下列约束才允许进入租用池**：

| 约束 | MVP 要求 | 落点 |
|------|----------|------|
| 工作目录白名单 | 必须指定 `workspace_path`，租客只能在此路径下发起执行 | Hub 校验 `cwd` 前缀；daemon 侧后续加二次校验 |
| provider 凭证 | 默认使用**机器内置 Genet Agent + 租客自带 API Key**，不得默认借用机主的 Claude/Codex 登录 | 桌面端「公开设置」显式勾选 |
| 用量上限 | 单租约最大执行数 / 时长；超限自动结束 | `limits_json` |
| 单活跃租约 | 一台机器同时只有一个租客 | DB 唯一约束 |
| 结束清理 | 停止全部执行、断开会话、写审计 | Hub 主动下 `control.request` |
| 机主随时收回 | 托盘和 Web 都要有「立即收回」 | 一次调用即结束租约 |

**MVP 不做**：文件系统沙箱、网络隔离、容器化。因此 MVP 阶段租用**只对组织内部可信成员开放**，产品文案不得暗示"陌生人也能安全出租"。真正对外开放需要容器化隔离，属 M5 之后。

---

## 7. 临时用户的恢复路径（必须有）

临时身份只存在浏览器/桌面本地，一旦丢失，已经 enroll 到该身份下的机器就没人能认领。MVP 必须提供：

1. 桌面端在创建临时用户时生成一份**恢复密钥**，存本地并提示用户可导出；Hub 只存 `sha256`。
2. 托盘菜单常驻「重新生成认领链接」——只要桌面端还在，机器就永远能被重新接管。
3. 后台任务：临时用户 90 天无活动 → 标记待清理，通知桌面端在 UI 上提示绑定。

---

## 8. 权限矩阵

| 动作 | temp | full | admin |
|------|------|------|-------|
| 绑定 / 连接自己的机器 | ✓ | ✓ | ✓ |
| 生成设备转移链接 | ✓ | ✓ | ✓ |
| 公开机器到租用池 | ✗（引导升级） | ✓ | ✓ |
| 租用公开机器 | ✗ | ✓ | ✓ |
| 强制结束他人租约 | ✗ | 仅自己的机器 | ✓ |
| 管理用户 / 撤销设备 / 查审计 | ✗ | 仅自己 | ✓ |
| 签发 relay 邀请码 | ✗ | ✗ | ✓ |

---

## 9. 撤销矩阵（想清楚每种情况能不能收回）

| 泄露对象 | 能否撤销 | 手段 | 副作用 |
|----------|----------|------|--------|
| 设备会话 token | ✓ | 撤销 `device_sessions` 行 | 无 |
| 转移链接 | ✓ | 一次性 + `revoked_at` | 无 |
| 租约 | ✓ | 结束租约，停止转发 | 无 |
| daemon enrollment 凭证 | ✓ | `DELETE /api/daemons/{id}` 或 WS 401 | 该机器需重新授权 |
| **pairing offer** | **✗** | 只能整机轮换密钥 | **机主全部客户端失效** |
| relay 邀请码 | ✓ | 作废码 | 使用该码的连接被断 |

最后两行是这套系统里唯一"不可精细撤销"的地方，所以 offer 的下发面必须压到最小。

---

## 10. 审计（MVP 就要写，UI 可以后做）

必审事件：登录 / 登出 / 临时用户创建 / 升级；设备会话创建、信任、撤销；转移链接创建、核销、撤销；机器授权、登记、改名、公开、撤销；**每一次通道授权**；租约创建、结束、强制收回；管理员改角色、禁用用户。

字段最小集：`at, actor_user_id, actor_device_id, action, target_type, target_id, ip, user_agent, detail_json`。

不记录 agent 对话内容。Hub 执行通道虽然技术上能看到 prompt，但审计只落"谁在何时对哪台机器发起了执行"，不落 prompt 正文。

---

## 11. 与桌面端的衔接

```
Desktop 首启
  ├─「先体验」→ POST /app/auth/temp → 临时 user + device session + 恢复密钥
  └─「登录」  → 浏览器打开 Hub 登录页
        │
        ▼
  daemon 发起设备码授权：显示 userCode，浏览器里确认归属
        │
        ▼
  机器登记 → machines 行 active → 托盘显示「已连接」
```

用设备码流程而不是让用户复制粘贴 token：**要输入的东西越短，走完的人越多**。userCode 是六位，念得出来也打得进去。
