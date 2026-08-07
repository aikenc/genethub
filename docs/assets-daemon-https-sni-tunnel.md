# 提案 A：daemon 终止 HTTPS + SNI 字节隧道

> 状态：后续 WebRoot 设计，MVP 不实施；备选方案：[云端 Assets Gateway](./assets-cloud-gateway.md)；MVP 只交付 [轻量 Asset Preview](./assets-quick-preview.md)，通用连接与 Duplex 语义见 [轻量 E2EE Data Plane](./e2ee-data-plane.md)；相关边界：[relay](./relay.md)、[安全模型](./security-model.md)、[架构](./architecture.md)。

## 1. 结论先行

这个方案让普通浏览器直接与资源所在机器的 daemon 建立 HTTPS：公网入口只读取 TLS ClientHello 中的 SNI，随后把整条 TCP 字节流送到目标 daemon；TLS 私钥只在 daemon，HTTP 路径和文件内容不在云端解密。

它同时满足：

- 查看端可以是未安装 daemon 的电脑或手机，只需要现代浏览器；
- 不依赖 Service Worker，也不重写 HTML；
- 多文件 HTML 使用真实 URL 层级，相对路径、根相对路径、图片、CSS、JS 和视频 Range 都按浏览器原生语义工作；
- Relay 不看到 SNI、HTTP 路径或资源内容，只看到不透明 route、流量大小和时序；
- 同一个稳定链接可在任意已配对浏览器中打开，每个浏览器独立完成授权并取得短期视图。

代价也很明确：它需要新的四层 SNI Edge、每台源机器独占的公网可信通配符证书、daemon 内的 TLS/HTTP 服务器，以及一套可运营的 ACME/DNS 生命周期。证书规模和浏览器信任链是最大风险。因此，只有“云端任何内容服务都不能被动看到明文”是硬要求时，才建议把它作为主路线；否则优先实现 [云端 Assets Gateway](./assets-cloud-gateway.md)。

这里的“端到端”是**浏览器 TLS 到 daemon 的数据路径端到端**。它不能自动升级为“对恶意平台零知识”：平台仍控制登录页面、DNS、SNI Edge 和证书域名验证，理论上可通过恶意前端或重新签发证书发动主动攻击。若要抵抗平台主动攻击，还需要独立可信客户端、daemon 非对称身份、密钥固定/透明日志与可验证前端，超出本提案范围。

## 2. 产品语义：稳定 Locator 与短期 View 分开

### 2.1 不把设备名和本机绝对路径放进 URL

建议的稳定链接是：

```text
https://app.genethub.com/assets/v1/w_6M4Q#/site/index.html
https://app.genethub.com/assets/v1/w_6M4Q#/dist/index.html?root=dist&mode=static
```

域名只表达 origin 形状，最终资产域名另行决定。

其中：

- `w_6M4Q` 是 Hub 级、不透明的全局 workspace handle；
- fragment 中的路径始终相对已注册 workspace，浏览器不会在首次 HTTP 请求中把它交给 App Frontdoor；
- fragment path 是 workspace 相对 entry，`root` 是可选的 workspace 相对 WebRoot；Viewer 必须先证明 entry 位于 root，再派生 daemon 使用的 `entryWithinRoot`；
- 未指定 `root` 时，单文件视图只授权该文件，HTML 站点视图默认以入口文件的父目录为最小 WebRoot；
- `source=p_...` 可作为可选 fragment 参数，固定某个不透明 placement；正常链接不固定机器，只有唯一 eligible placement 或已有显式 preferred placement 时才自动选择，歧义时必须让用户选择，不能随机路由；
- `mode=static|interactive` 默认 `static`。

不采用 `/assets/<device>/<absolute-workdir>/...`，原因是设备名会变化、绝对路径会泄露用户名和磁盘布局、Windows 与 Unix 路径不兼容，而且它把逻辑 workspace 错误地绑定到一台物理机器。Hub workspace 与本地 placement 应保持分离；daemon 自己负责把全局 workspace 映射到本机注册目录。

fragment 不是保密容器：它仍会进入浏览器历史、截图和复制内容。它的作用只是避免路径自然进入 Frontdoor、反向代理和访问日志。若产品更重视 URL 直观性而不在意路径元数据，可以额外提供路径形式的兼容别名，但规范形式应保留 fragment。

### 2.2 相同链接在另一台已配对电脑上如何工作

稳定链接只是 Locator，不携带长期权限：

1. 浏览器打开稳定链接；未登录或未配对时先完成设备会话授权。
2. Control 根据 `workspaceHandle` 解析当前 placement，并检查该浏览器设备是否有 `assets:read` 权限。
3. Control 为这一次打开签发短期 `ViewLease`，而不是复用创建链接那台浏览器的凭证。
4. Viewer 用 fragment 中的 `root`、`entry` 和 `mode` 初始化视图。
5. daemon 对 workspace、WebRoot 和每个请求再次做边界检查。

所以用户复制的是同一个稳定链接；每台已配对电脑或手机得到的是不同的临时 raw origin 和不同的撤销单元。撤销某个浏览器会话不会改变链接，也不会影响其他仍获授权的设备。

### 2.3 两类 URL 不应混用

| URL | 用途 | 是否可分享/收藏 | 是否承载权限 |
| --- | --- | --- | --- |
| `app.genethub.com/assets/v1/...` | 稳定 Viewer Locator | 是 | 否；每次重新鉴权 |
| `v-<random>.m-<machine>.assets...` | 原生资源 origin | 否；短期内部地址 | 是；随机 hostname 是 ViewLease 的一部分 |

raw origin 至少使用 128 bit 随机 view handle，默认短 TTL、空闲到期、总时长上限和传输预算。它必须在 Referrer 中被抑制、不得写入应用日志，也不能被当作永久分享链接。

建议初始策略是 bootstrap secret 不超过 60 秒且只能核销一次，ViewLease 以 10 分钟为一个可续租窗口、1 小时为单次打开的本地硬上限。只有仍持有已认证 App 设备会话的 Viewer 可以续租；raw 页面自身不能续租。Control 明确撤销时立即终止，Control 暂时不可达也只能活到 daemon 保存的硬截止时间，不能降级为匿名访问。

## 3. WebRoot 是 daemon 上的目录能力

WebRoot 不是上传到服务器的目录，也不是一份云端副本。它是 daemon 在某个已注册 workspace 内打开的目录能力：

```text
SiteOpen {
  globalWorkspaceId,
  placementRevision,
  webRoot: "dist",          // workspace-relative
  entry: "index.html",      // WebRoot-relative
  mode: "static",
  policy: { allowExternalNetwork: false, spaFallback: false }
}
        ↓
SiteCapability {
  id: random opaque id,
  expiresAt,
  policyDigest,
  requestBudget,
  byteBudget
}
```

daemon 必须先以 capability-safe 的目录 API 打开 workspace，再相对它打开 WebRoot；后续所有路径解析都相对这个已打开的目录句柄完成，不能先 `canonicalize()` 检查、再用环境路径 `open()`。轻量 `asset.preview` 的 workspace confinement 原则可以复用，但 WebRoot 不能复用其“单个完整文件、2 MiB、无相对资源”的响应契约。

WebRoot 规则：

- `webRoot` 是 workspace 相对路径，`entry` 是 WebRoot 相对路径；稳定 URL 中的 workspace-relative entry 必须先验证位于 WebRoot，再转换为这个 `entry`；
- URL `/` 映射到 WebRoot，不映射到磁盘根目录或 workspace 的父目录；
- URL 解码恰好一次，拒绝 NUL、反斜杠、编码分隔符、`.`/`..`、Windows drive/UNC/ADS 前缀和任何越界结果；
- v1 不跟随无法证明仍位于 WebRoot 内的 symlink，也不跟随 magic link；不能因为平台差异退化为 ambient filesystem open；
- 不提供目录列表；目录 URL 先 308 到带 `/` 的形式，再按策略查找 `index.html`；
- `.git`、`.genethub`、凭证目录和 dot-secret 模式默认拒绝。真正的安全边界仍是选择足够窄的 WebRoot，denylist 不能代替能力边界；
- 普通“预览文件”只开放所选文件。只有“作为站点打开”才开放 WebRoot 下的文件集合，并明确提示这个范围内的文件可被该 HTML 的脚本读取；
- placement 或 workspace registration generation 变化时，旧 capability 立即失效，不能静默指向一个新目录。

### 3.1 多文件 HTML

假设 workspace 为：

```text
demo/
  public/
    index.html
    css/app.css
    media/intro.mp4
```

以 `public` 为 WebRoot、`index.html` 为 entry 后，daemon 提供的 raw URL 是：

```text
https://v-<view>.m-<machine>.assets.genethubusercontent.com/index.html
https://v-<view>.m-<machine>.assets.genethubusercontent.com/css/app.css
https://v-<view>.m-<machine>.assets.genethubusercontent.com/media/intro.mp4
```

浏览器因此可以原生解析 `css/app.css` 和 `/media/intro.mp4`。不使用 Blob URL、`srcdoc`、HTML 字符串替换或 Service Worker；这些做法要么破坏根相对路径和模块加载，要么无法透明处理后续请求。

若页面引用 `../shared/logo.png`，用户必须把 WebRoot 显式扩大到同时包含 `public` 与 `shared` 的目录。越过 WebRoot 的 `..` 不能为了“让页面能跑”而放行。

SPA fallback 只能是显式站点策略，并且只对 `Sec-Fetch-Mode: navigate` 的无扩展名导航回退到入口 HTML；脚本、样式、图片和 Range 请求的 404 绝不能回退为 HTML，否则错误会变成难以诊断的 MIME 问题。

## 4. 组件与数据路径

```text
稳定链接 / 登录 / ViewLease
┌────────────┐        HTTPS        ┌──────────────┐
│ 任意浏览器   │ ◄─────────────────► │   Control    │
└──────┬─────┘                     └──────┬───────┘
       │  TLS(ClientHello: SNI)           │ route/view admission
       ▼                                  ▼
┌────────────┐  E2EE DuplexStream   ┌──────────────┐  opaque records   ┌────────────┐
│ SNI Edge   │ ════════════════════► │ Fabric Relay │ ═════════════════► │   daemon   │
│ 只选路由    │                      │ 只搬不透明字节 │                   │ TLS + HTTP │
└────────────┘                      └──────────────┘                   └──────┬─────┘
       ╰──────── 浏览器 TLS 会话在 daemon 终止；HTTP 只在虚线内部可见 ───────────╯
                                                                            │
                                                                            ▼
                                                                      WebRoot dir fd
```

SNI Edge 是新服务，不是 Relay 的新模式：

- SNI Edge 接受公网 TCP/443，做有上限的 ClientHello 解析和 route admission；
- Relay 继续只有 endpoint-neutral Fabric 字节搬运，不解析 TLS、HTTP、路径、MIME 或用户；
- Control 负责账号、设备、workspace/placement 与短期 ViewLease；
- daemon 持有证书私钥，终止 TLS，执行资源授权和文件读取。

把 SNI Edge 合并进 Relay 会让 Relay 理解域名、view 生命周期和目标机器，扩大当前可审计边界，因此禁止合并进程、服务账号或日志管道。

## 5. 一次打开的完整时序

1. 浏览器请求稳定 Viewer URL。App Frontdoor 只收到 workspace handle；entry/WebRoot 留在 fragment。
2. Viewer 调用 Control 创建 `ViewLease`，携带 workspace、可选 placement、请求模式；Control 检查设备会话和 workspace 权限。
3. Control 生成一次性 bootstrap secret、随机 view handle 和短期 route lease，将对应的机器范围/过期时间分别交给浏览器、SNI Edge 与 daemon。Edge 只获得选路需要的不透明 handle。
4. daemon 确认 workspace placement generation 后激活 hostname：

   ```text
   v-<view-handle>.m-<machine-handle>.assets.genethubusercontent.com
   ```

5. Viewer 用一个目标为 iframe 的小型 POST 请求 `/_genethub/bootstrap`。POST body 带一次性 bootstrap secret、fragment 中的 WebRoot、派生后的 `entryWithinRoot` 和 mode；这些字段位于浏览器到 daemon 的 TLS 内，不进入 URL、Edge 或 Relay 日志。
6. daemon 原子核销 secret，打开目录能力，绑定 `view handle -> SiteCapability`，返回 `303 Location: /<entry-within-root>`。后续相对资源直接使用同一 raw origin。
7. daemon 对每个 GET/HEAD 再检查 view 是否存活、Host/SNI 是否一致、路径是否位于 WebRoot、预算是否充足，然后流式返回。
8. Viewer 关闭、设备会话撤销、workspace placement generation 改变、空闲超时或硬期限到达时，Control/daemon/Edge 删除 ViewLease；已打开流被取消，raw hostname 不可复用。

bootstrap secret 不应出现在 query、fragment、Referer、分析事件或错误文本中。raw hostname 在激活后本身是短期 bearer；因此必须高熵、短时、不可复用，并由默认 CSP 阻止内容把它通过外部请求泄露出去。

## 6. TLS、SNI 与证书模型

### 6.1 每台机器一把私钥

每台 daemon 生成并保管自己的密钥，申请只覆盖该机器 opaque hostname 的通配符证书：

```text
*.m-<machine-handle>.assets.genethubusercontent.com
```

它刚好覆盖一层随机 view subdomain。禁止把 `*.assets...` 的共享私钥分发给所有 daemon：攻破一台机器就能伪装全部资源 origin，是不可接受的横向爆炸半径。

对应的 wildcard DNS 只把这一层 hostname 指向 SNI Edge，不为每个 view 创建 DNS record；Edge 再从合法后缀中提取 opaque machine handle，并要求随机 view route 已激活。

建议流程：

1. daemon 在本机生成不可导出的密钥和 CSR；
2. Control 将 CSR 及 proof-of-possession 绑定到已认证的 machine enrollment，只协助 DNS-01 challenge 和申请状态编排；
3. 公共 CA 签发证书链，私钥始终不离开 daemon；
4. daemon 在线时提前续期，证书不足安全余量时不激活新 view；
5. 删除机器时先撤销 Edge route，再处理证书撤销/自然短期过期。

机器离线超过证书有效期后，重新上线必须先续证再服务。浏览器不接受自签名证书，所以“临时退回自签”不是容错方案。

当前界面 fingerprint 不是 daemon 非对称公钥，不能直接作为证书信任锚。TLS transport key 可以先作为独立密钥落地；若要把它升级成用户可 pin 的 machine identity，必须同时实现签名握手、独立可信展示来源和显式轮换流程，不能只改字段名称。

### 6.2 这是主要可行性门槛

公共 CA 通常按注册域名限制签发速率；“每台机器一张通配符证书”可能很快触及容量、失败重试和滥用风控。进入实现前必须用目标 CA 完成书面容量确认和至少万级机器的签发/续期压测。没有可扩展的 CA 合作或域名委派设计，本方案应判定为不可上线，而不是退化为共享私钥。

Certificate Transparency 会公开机器通配符 hostname。machine handle 必须随机且不含账号、设备名或 workspace 信息；view hostname 由通配符覆盖，不应逐个进入 CT。

### 6.3 协议约束

- v1 只支持 TCP 上的 HTTP/1.1 与 HTTP/2；不发布 `Alt-Svc`，不支持 QUIC/HTTP/3；
- SNI 是选路条件，v1 不能同时依赖会隐藏内层 SNI 的 ECH；这是明确的元数据取舍；
- Edge 最多缓冲一个受限大小的 ClientHello，设置首字节/完整握手超时，拒绝未知后缀、非法 IDNA、重复/矛盾 SNI；
- daemon 校验 TLS SNI 与 HTTP `Host`/HTTP2 `:authority` 完全匹配，域名前置返回 421；
- ALPN 由浏览器与 daemon 直接协商，Edge 不参与 TLS 协商。

## 7. SNI 隧道：TransportEndpoint 上的 Duplex 业务

浏览器 TLS 已经保护 HTTP 和内容，但原始 ClientHello 中的 SNI 若作为明文 routing metadata 交给 Relay，Relay 仍可读取。为保持边界，SNI Edge 以受限 service identity 接入通用 `TransportEndpoint`，再以短期 admission 打开到 daemon 的 E2EE stream；每条浏览器 TCP 连接占一条短生命周期 `DuplexStream`：

```text
TransportEndpoint.OPEN(streamId)                // 无业务字段
Edge -> daemon: encrypted TunnelOpen{version: 1}
Edge -> daemon: raw TCP bytes including ClientHello
daemon -> Edge: raw TCP bytes including ServerHello/HTTP ciphertext
```

要求：

- `OPEN` 不放 tunnel version、hostname、workspace、path 或用户字段；首个加密 DATA 是有小上限的 `TunnelOpen`，随后全部是 raw bytes；
- E2EE key/nonce domain、sequence、replay 和 frame authentication 复用通用 Secure Stream，不再为 SNI 隧道实现第二套 outer AEAD；
- 即使第一阶段由 Control 编排 session admission，浏览器到 daemon 的内层 TLS 仍阻止 Control 被动读取 HTTP；
- payload 是二进制，不做 JSON/base64；16 KiB frame、逐流 credit、session 内存与 task 上限自动把 TCP backpressure 传到两端；
- 浏览器 FIN、daemon EOF、取消、超时和错误必须映射为明确的 half-close/reset，不能把整个 daemon uplink 一并断开；
- Edge 只验证 ViewLease 是否可路由，真正的 workspace/WebRoot 授权仍由 daemon 执行。

未来若通用 Secure Stream handshake 使用 daemon canonical identity，可让 Control 也不知道 stream key；这只减少 SNI 在内部链路上的暴露，不改变内层 TLS 的主要内容边界。

## 8. daemon 的静态 HTTP 契约

资源服务器是只读、能力受限的静态服务器，不是“把 localhost 任意端口代理到公网”。

### 8.1 方法与状态

- 只允许 `GET`、`HEAD` 和内部 bootstrap `POST`；其他方法返回 405；
- 支持单段 byte Range：`206`、`Content-Range`、`Accept-Ranges: bytes`，无效范围返回 416；v1 可拒绝 multipart ranges；
- 支持 `If-None-Match`/`If-Range` 和 304；ETag 来自 daemon 观察到的文件版本，不包含本机路径；
- 打开文件句柄并取得 metadata 后再发送 response head，同一响应始终从该句柄流式读取；
- 客户端取消必须停止磁盘读取并释放 Fabric/TCP window；慢客户端不能导致无界内存；
- 未授权、越界和不存在默认统一为 404，避免把 raw endpoint 变成路径探测器；源机器暂时离线由稳定 Viewer 展示状态，raw 隧道只会连接失败。

### 8.2 MIME 与缓存

- MIME 使用固定 allowlisted 映射加安全兜底，响应加 `X-Content-Type-Options: nosniff`；
- HTML、SVG、Markdown、图片、字体、音频和视频可 inline；未知二进制使用 `application/octet-stream` 和 attachment；
- 用户文件不能注入响应头，尤其不能控制 CSP、CORS、Set-Cookie、Location 或 Content-Disposition filename；
- 默认 `Cache-Control: private, no-store`。将来允许浏览器私有缓存时也不得使用共享 CDN/cache；
- `Content-Disposition` 文件名必须去掉控制字符和路径分隔符。

### 8.3 Markdown

`.md` 原始响应为 `text/markdown; charset=utf-8`。默认 Viewer 由受信任的 App 页面跨 origin 拉取文本、用固定版本的 Markdown renderer 和 HTML sanitizer 渲染，并把相对图片/链接重定位到同一 raw WebRoot；CORS 只允许明确的 Viewer origin、只允许 GET/HEAD、不带账号 cookie。`raw=1` 才展示原始文本。

## 9. HTML 执行模式与 iframe 隔离

raw 内容必须使用与账号应用不同的 registrable domain，例如 `genethubusercontent.com`。账号 cookie 只使用 app host-only cookie，绝不下发到 assets 域。

### 9.1 Static（默认）

- iframe 使用无 `allow-scripts`、无 `allow-forms`、无 `allow-top-navigation` 的 sandbox；
- 响应 CSP 禁止 script、object、frame、form 和外部 connect，图片/媒体/字体/样式默认只允许 `self`、必要的 `data:`/`blob:`；
- `Referrer-Policy: no-referrer`，防止 view hostname 和路径泄给外站；
- `Permissions-Policy` 关闭摄像头、麦克风、位置、USB、串口、剪贴板读取等能力。

### 9.2 Interactive（显式选择）

- 每个 ViewLease 使用新的随机 origin；绝不在机器级共享 origin 上运行脚本；
- iframe 可增加 `allow-scripts`、`allow-same-origin`，仍不允许 top navigation、popups、downloads 或设备权限，除非用户逐项开启；
- 默认网络仍限制为 `self`。允许外网意味着页面脚本可读取 WebRoot 内可猜到的文件并外传，必须作为独立高风险开关；
- daemon 对带 `Service-Worker: script` 的请求返回拒绝，CSP 默认 `worker-src 'none'`。本方案不依赖 Service Worker，也不允许预览内容持久注册 Service Worker；
- view handle 永不复用，使浏览器 origin storage、缓存和潜在残留不能跨视图串联。

raw 响应不能继承当前全站的 `X-Frame-Options: DENY`。只在独立 assets host 上移除 XFO，并使用精确的 CSP `frame-ancestors` 放行受信任 Viewer origin；不能全局放宽应用站点的 frame 策略。

## 10. 谁能看到什么

| 组件 | 必须看到 | 不应看到 | 仍需承认的能力 |
| --- | --- | --- | --- |
| App/Control | 账号设备会话、workspace/placement handle、ViewLease 状态 | 默认不接收 WebRoot、entry、HTTP path、文件 bytes | 平台提供前端并控制授权，恶意实现可主动窃取 |
| DNS resolver | machine/view hostname | HTTP path、内容 | 可关联查询 IP 与访问时间 |
| SNI Edge | 客户端 IP、SNI 中的随机 view/machine handle、连接时序和大小 | TLS 私钥、HTTP path/header/body | 可拒绝、延迟或错误选路；不能被动解密内层 TLS |
| Fabric Relay | endpoint/route/stream handle、E2EE record 长度与时序 | SNI、用户、workspace、HTTP、文件内容和 stream key | 可拒绝、重放或丢弃密文；认证与序号令篡改 fail-close |
| 公共 CA / CT | 机器级通配符证书名和生命周期 | view、workspace path、内容 | 域名控制者仍可能申请替代证书 |
| daemon | ViewLease、WebRoot、HTTP path 和文件内容 | 不需要账号邮箱等资料 | 最终资源授权与明文端点 |

这张表描述的是诚实实现和被动观测边界。因为平台控制 Web App 与 DNS，不能据此宣称“平台数学上无法看到内容”。可以准确宣称：**证书私钥不离开 daemon 时，SNI Edge 和 Relay 在正常数据路径中不终止浏览器 TLS，不会被动得到 HTTP 路径或资源明文。**

## 11. 威胁与硬性控制

| 风险 | 控制 |
| --- | --- |
| 路径穿越、symlink race、Windows 特殊路径 | 目录能力 + 单次严格解码 + beneath/no-magic-link 语义；跨平台攻击测试 |
| 恶意 HTML 读取项目秘密 | 默认 Static；最小 WebRoot；敏感目录默认拒绝；Interactive 明示范围且默认断外网 |
| raw hostname 泄露 | 128 bit 以上随机数、短 TTL、no-referrer、禁止外部网络、无访问日志、即时撤销 |
| SNI 扫描在线机器 | opaque machine handle、只激活短期 view route、每 IP/机器握手预算、统一失败表现 |
| Edge 被当作任意 TCP 代理 | 仅接受受控域名和已激活 route；目标只能是已登记 Fabric endpoint，不能接受任意 host/port |
| Relay 读取 ClientHello | Edge-daemon Secure Stream E2EE 覆盖包括 ClientHello 在内的所有 raw bytes |
| daemon 证书私钥泄露 | 每机独立 key、OS 权限/密钥存储、禁止导出和日志；撤销 route 与轮换证书 |
| 一台 daemon 伪装另一台 | 不共享 wildcard key；SNI Host 必须与本机证书和 Control machine handle 一致 |
| 资源耗尽 | ClientHello/连接/并发请求/打开文件/Range/字节/缓冲区多层预算，逐 view 取消 |
| 内容类型混淆 | 固定 MIME 映射、nosniff、未知类型 attachment、用户不可控响应头 |
| Service Worker 持久化 | 每 view 新 origin、worker CSP、拒绝 Service-Worker script fetch、handle 永不复用 |

## 12. 代码与部署边界

预期改动面：

- 开源 daemon：SiteCapability、capability-relative 资源读取、TLS/HTTP server、Range/ETag、证书本机存储、view lifecycle；
- 开源协议：`tls-tcp/1` 的 bounded TunnelOpen、half-close/reset 与错误码；framing、E2EE、credit 只复用 Data Plane；
- Cloud Control：稳定 Locator、授权、ViewLease、placement routing、证书编排；
- 新的 Cloud `assets-sni-edge`：最小 ClientHello parser、TCP/DuplexStream bridge、TransportEndpoint client、路由预算；
- Web Viewer：fragment 解析、设备鉴权、bootstrap form、iframe sandbox、Markdown renderer；
- Relay：只搬运 endpoint-neutral opaque records，不加入 HTTP、MIME、证书或路径逻辑。若 TransportEndpoint 无法表达 half-close，应只补通用能力。

SNI Edge、Control、Relay 必须是独立进程和服务身份。Edge 日志只记录随机 route、状态、字节数和延迟；禁止记录完整 SNI，必要排障使用短期 HMAC 后的 handle。

## 13. 分期

### Phase 0：可行性门禁

- 与目标公共 CA 验证每机 wildcard 的签发速率、DNS-01、续期和失败恢复；
- 用真实 Safari/Chrome/Firefox、公司代理和移动网络验证跨 SNI 隧道的 TLS/HTTP2 行为；
- 明确资产域、CT 隐私、证书私钥存储和事故轮换；
- 若任何一项只能靠共享 wildcard 私钥解决，停止本方案。

### Phase 1：协议与文件能力

- 实现 SiteCapability、严格 path resolver、GET/HEAD/single Range、取消与预算；
- 先在 daemon loopback 集成测试多文件站点，不开放公网；
- 固化 Static/Interactive header policy 和 WebRoot UX。

### Phase 2：单机 PKI 试点

- daemon 生成 key/CSR，完成少量机器 wildcard 证书签发、续期和丢失恢复；
- 验证密钥从未进入 Control、Edge、Relay、构建日志或 crash dump。

### Phase 3：SNI Edge 与 Viewer

- 上线受限测试域、短期 ViewLease 和 TCP/DuplexStream bridge；
- 先只支持图片/Markdown/下载，再开 HTML Static 和视频 Range；
- Interactive 必须在外传、origin 复用和 Service Worker 测试通过后单独启用。

### Phase 4：容量与故障演练

- 万级证书续期抖动、daemon 离线跨过续期窗口、Edge 多地域路由；
- Relay/Edge 慢读、断流、重放、route 撤销和全局预算压测；
- 完成 key compromise、错误签发、机器删除和域名切换 runbook。

## 14. 验收标准

功能：

- 未安装 daemon 的手机可通过稳定链接预览 png、Markdown、HTML 站点和支持 seek 的 mp4；
- HTML 的 `./`、`../`（不越 WebRoot）和 `/` 资源引用符合标准 URL 语义；
- 同一稳定链接在两台不同的已配对浏览器中分别授权后可打开，raw view URL 不相同；
- daemon 离线、workspace 移动、view 撤销和过期都有确定且不泄漏路径的结果。

安全：

- SNI Edge/Relay 抓包中没有 HTTP method、path、header 或文件明文；Secure Stream E2EE 开启时 Relay 抓包也没有 SNI；
- 证书私钥只存在目标 daemon，另一台 daemon 不能为该 machine hostname 完成 TLS；
- 双重编码、分隔符编码、symlink swap、Windows ADS/UNC、Host/SNI 不一致全部 fail-close；
- Static HTML 不能执行脚本、发外网请求、注册 Service Worker 或导航顶层；
- Interactive origin 不复用，不能访问另一个 view 或 App origin 的 cookie/storage；
- raw handle 泄露后的最大有效期和字节预算符合策略，撤销能中止在途流。

可靠性与性能：

- Range、HEAD、304、取消、慢客户端和大文件流式传输不经过 2 MiB 文本 RPC，也不产生整文件内存缓冲；
- 单 view 超限只终止该 view，不影响 daemon endpoint 上的聊天、终端或其他 streams；
- 证书续期失败不会回退自签名或共享 key，只停止创建新 view 并给稳定 Viewer 明确状态。

## 15. 最终取舍

选择本方案，当且仅当以下命题成立：

> 普通浏览器原生加载多文件站点、无需查看端安装软件、无需 Service Worker，并且云端内容服务在正常数据路径中也不能终止或被动解密资源 HTTPS，这项要求足以承担公网 PKI 与四层边缘网络的长期成本。

否则选择 [云端 Assets Gateway](./assets-cloud-gateway.md)：它仍可让 Relay 保持不透明，URL/WebRoot/iframe 行为相同，但把浏览器 HTTPS 终止放在一个明确受信任、可审计的资源网关，复杂度显著更低。
