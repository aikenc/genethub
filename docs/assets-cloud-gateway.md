# 提案 B：云端 Assets Gateway

> 状态：后续 WebRoot 设计，MVP 不实施；备选方案：[daemon 终止 HTTPS + SNI 字节隧道](./assets-daemon-https-sni-tunnel.md)；MVP 只交付 [轻量 Asset Preview](./assets-quick-preview.md)，通用连接与请求语义见 [轻量 E2EE Data Plane](./e2ee-data-plane.md)；相关边界：[relay](./relay.md)、[安全模型](./security-model.md)、[架构](./architecture.md)。

## 1. 结论先行

这个方案新增一个独立的 Cloud Asset Gateway：浏览器与 Gateway 建立普通 HTTPS，Gateway 把 HTTP GET/HEAD/Range 转为通用 `Exchange`，经 Gateway 与 daemon 的 `TransportEndpoint` 转发；逐 stream E2EE 使 Relay 仍只看到不透明 route、密文长度和时序。

它满足：

- 查看端可以是没有安装 daemon 的电脑或手机；源文件所在机器仍需运行 daemon；
- 不依赖 Service Worker，不把 HTML 改写成 Blob 或 `srcdoc`；
- 多文件 HTML、根相对路径、ES module、图片、字体和视频 Range 使用浏览器原生 HTTP 语义；
- 同一个稳定链接可在任意已配对浏览器打开，每次产生独立短期 ViewLease；
- Relay 不解析资源协议，也看不到 HTTP path、header 或文件内容；
- 不把工作区同步或缓存到云端，源 daemon 离线时资源不可用。

它的信任边界也必须直说：**Asset Gateway 会看到资源路径和明文内容。** 浏览器 TLS 在 Gateway 终止；Gateway 必须读取 HTTP 才能提供原生多文件网站。Gateway 到 daemon 的加密只保护 Relay，不构成浏览器到 daemon 的端到端加密。

在“普通浏览器 + 原生 iframe + 任意相对子资源 + 不用 Service Worker”这组约束下，无法让一个终止 HTTPS 的云端 Gateway 同时对内容零知识：浏览器不会把每个 CSS、图片、模块和 Range 响应交给页面 JavaScript 解密。若这项云端明文边界不可接受，应选择 [SNI 字节隧道方案](./assets-daemon-https-sni-tunnel.md)，让 daemon 成为浏览器 TLS 端点。

如果硬要求只是“Relay 保密，平台有一个最小、明确、可审计的内容处理边界可以被信任”，本方案是建议的第一阶段实现。

## 2. URL：可复制的是 Locator，不是 Bearer Token

### 2.1 稳定 Viewer URL

规范链接与另一个提案保持一致：

```text
https://app.genethub.com/assets/v1/w_6M4Q#/site/index.html
https://app.genethub.com/assets/v1/w_6M4Q#/dist/index.html?root=dist&mode=static
```

域名只表达 origin 形状，最终资产域名另行决定。

语义：

- `w_6M4Q` 是 Hub 级全局 workspace handle，不是 daemon 本地 workspace id；
- fragment path 是 workspace 相对 entry，`root` 是可选的 workspace 相对 WebRoot；Viewer 必须先证明 entry 位于 root，再派生 daemon 使用的 `entryWithinRoot`；
- fragment 不随初始 HTTP 请求进入 Frontdoor access log，但仍存在于浏览器历史和复制内容，不应放 secret；
- 可选 `source=p_...` 固定某个 opaque placement；只有唯一 eligible placement 或已有显式 preferred placement 时才自动选择，歧义时必须让用户选择，不能随机路由；
- 可选 `mode=static|interactive`，默认 `static`。

不在 URL 暴露真实设备名或 `/Users/alice/project`、`D:\\work\\project` 之类本机路径。设备名会变，绝对路径泄露本机信息并阻碍 workspace 跨 placement；daemon 的 workspace registry 才是全局 workspace 到本机目录的唯一映射。

### 2.2 短期 raw origin

通过授权后，Viewer 为本次打开取得：

```text
https://v-<128-bit-random>.assets.genethubusercontent.com/
```

raw origin 是短期内部地址：随机 hostname 对应一份 ViewLease，不能收藏或分享。使用独立 registrable domain，避免预览内容接触 `app.genethub.com` 的账号 cookie；每个 view 使用新 origin，避免两个不可信 HTML 共享 cookie、storage、cache 或 Service Worker scope。

稳定 URL 不带访问权限。另一台已配对电脑打开同一稳定链接时，先用自己的设备会话通过 Control 授权，再取得不同的 raw origin。这样“相同链接跨设备可打开”与“链接泄露不等于永久授权”可以同时成立。

## 3. 为什么不能在本方案里宣称端到端加密

浏览器加载：

```html
<link rel="stylesheet" href="./app.css">
<script type="module" src="./app.js"></script>
<video src="./movie.mp4"></video>
```

时，后续请求由浏览器网络栈直接发给这些 URL 的 HTTPS 端点。若端点是 Asset Gateway，则 Gateway 必须返回浏览器可直接解释的明文 CSS、JavaScript 和视频字节。

以下办法都不能满足本提案的产品目标：

- 返回加密文件、在顶层页面 JavaScript 解密：iframe 的后续相对请求不会自动经过这段 JavaScript；
- 全量重写 HTML/CSS/JS URL：运行时拼接 URL、ES module graph、CSS `url()`、fetch、WASM 和 Range 很难完整覆盖，而且会改变页面语义；
- Blob URL/`srcdoc`：没有稳定的 HTTP origin 和目录层级，根相对路径、模块与媒体 seek 会坏；
- Service Worker 虚拟文件系统：用户已经明确不希望依赖它，而且注册、更新、scope 与清理会引入新的持久安全状态。

所以这里准确的加密描述是：

```text
浏览器 --HTTPS--> Asset Gateway --Exchange over E2EE TransportEndpoint--> daemon
                         ▲                       ▲
                    可见 HTTP 明文           可见文件明文

Fabric Relay 只见 route、密文长度与时序。
```

若将来提供“加密发布包”，它应是另一个明确的产品模式，不应被拿来证明任意 WebRoot 已经端到端。

## 4. 组件边界

```text
┌────────────┐   login / create view   ┌──────────────┐
│ 任意浏览器   │ ◄─────────────────────► │   Control    │
└─────┬──────┘                         └──────┬───────┘
      │ HTTPS GET/HEAD/Range                  │ grant / route admission
      ▼                                       ▼
┌────────────────┐  Exchange / E2EE    ┌──────────────┐  opaque records   ┌────────────┐
│ Asset Gateway  │ ═══════════════════► │ Fabric Relay │ ═════════════════► │   daemon   │
│ TLS + HTTP     │                     │ 只搬不透明字节 │                   │ WebRoot fd │
└────────────────┘                     └──────────────┘                   └────────────┘
```

四条不可破坏的边界：

1. Asset Gateway 是独立服务，不是 Relay 的 HTTP 插件，也不与 Relay 共用进程、权限或 payload 日志。
2. Relay 不解析 Exchange；path 和 response head 都必须在 Gateway-daemon Secure Stream E2EE 内。
3. Gateway 不拥有数据库管理员权限，不接收用户邮箱、昵称、设备凭证或 daemon enrollment secret；它只消费 Control 签发/查询得到的最小 view route。
4. daemon 是最终文件授权点。Gateway 的通过不能让一个越界 path、过期 SiteCapability 或旧 placement generation 被读取。

如果公网负载均衡器/CDN 在 Gateway 前终止 TLS，它也会看到全部 HTTP 明文，必须被列入同一受信任内容边界。建议 assets 域的 TLS 直接终止在专用 Gateway ingress，禁用通用 CDN body logging、缓存和 WAF request capture。

## 5. 一次打开的完整时序

1. 浏览器打开稳定 Viewer URL。Control 验证账号设备会话、workspace 访问权和目标 placement；entry/WebRoot 仍只在浏览器 fragment 中。
2. Viewer 请求创建 ViewLease。Control 生成高熵 view handle、一次性 bootstrap secret、短期 route admission、过期时间、并发/字节预算和策略上限。
3. Control 向 daemon 建立或确认对应 workspace placement lease；Gateway 只拿到 opaque view handle、Fabric route handle、期限和策略，不需要用户 PII。
4. Viewer 先验证 workspace-relative entry 位于 WebRoot，并派生 `entryWithinRoot`；随后以目标 iframe 的表单 POST 到：

   ```text
   https://v-<view>.assets.genethubusercontent.com/_genethub/bootstrap
   ```

   body 包含一次性 bootstrap secret、workspace-relative WebRoot、`entryWithinRoot` 和请求 mode。这样 secret 不进入 URL/Referer；Gateway 因终止 TLS 仍会看到这些字段，这是本方案已声明的边界。
5. Gateway 原子核销 bootstrap，通过既有 `TransportEndpoint` 发起 `asset.web.open` Exchange，把 `SiteOpen` 加密发给 daemon。
6. daemon 核对 workspace id、placement generation、权限上限和路径，打开 WebRoot 目录能力，返回 opaque `SiteCapability` 与策略摘要。
7. Gateway 将 `view handle -> route + SiteCapability + policy` 放入有界、短期内存状态，返回 `303 Location: /<entry-within-root>`。
8. 浏览器后续加载相对资源。Gateway 为每个 GET/HEAD 发起独立 `asset.web.get` Exchange；daemon 返回受控 response metadata 与文件 chunks，Gateway 流式写给浏览器。
9. 浏览器取消、ViewLease 撤销或过期时，Gateway RESET 在途 stream 并删除 view；daemon 同时释放 SiteCapability。raw hostname 此后统一返回无信息的失效结果。

Control 可以把 ViewLease 元数据持久化到短期授权表以支持多 Gateway 实例，但不持久化文件内容。Gateway 的本地映射是可丢弃 cache，重启后从 Control 重新校验或要求重新 bootstrap。

## 6. 授权模型

### 6.1 三层能力

| 能力 | 约束 | 谁执行 |
| --- | --- | --- |
| `ViewGrant` | 浏览器设备、全局 workspace、可选 placement、mode 上限、TTL | Control |
| `SiteCapability` | 本机 workspace generation、WebRoot dir fd、策略、预算 | daemon |
| `ViewLease` | 随机 raw hostname 到 route + SiteCapability 的短期绑定 | Gateway + daemon |

ViewGrant 不能直接作为 URL query bearer。bootstrap secret 只用一次；之后 raw hostname 是短期 bearer，因此至少 128 bit 随机、不可复用、默认无外部 Referer、具备 idle/hard expiry、并发/字节预算和即时撤销。

建议初始策略是 bootstrap secret 不超过 60 秒且只能核销一次，ViewLease 以 10 分钟为一个可续租窗口、1 小时为单次打开的本地硬上限。只有仍持有已认证 App 设备会话的 Viewer 可以续租；raw 页面自身不能续租。Control 明确撤销时立即终止，Control 暂时不可达也只能活到 Gateway/daemon 保存的硬截止时间，不能降级为匿名访问。

Gateway 只执行“这个 view 是否仍有效、应该连哪条 route”；daemon 每次都执行“这个 path 是否在 SiteCapability 内”。两边任一失败都 fail-close。权限收窄可以立即生效；权限扩大必须重新创建 capability，不能原地修改旧 grant。

### 6.2 跨设备与多 placement

- 查看设备只需浏览器设备会话，不需要本机 daemon；
- 源设备必须在线运行 daemon；链接中的 global workspace 决定逻辑资源，placement 决定本次从哪台源机器读；
- 只有唯一 eligible placement 或 Hub 已有显式 preferred placement 时才默认路由，并把 placement generation 固定在 SiteCapability；歧义时返回选择界面；
- 用户明确选择 `source=p_...` 时，Control 可见这个 opaque placement hint，但 URL 不出现机器名；
- 同一 workspace 的多个 placement 若内容不同，不能在一个 view 生命周期内自动切换，否则 ETag、Range 和页面资源可能来自不同版本。故障转移必须重新创建 ViewLease，并由 Viewer提示源已变化。

## 7. WebRoot 与路径解析

WebRoot 是 daemon 本地目录能力，不是 Gateway 上的目录：

```text
workspace registry
  global workspace w_6M4Q
       ↓ placement revision 17
  /local/private/path/project
       ↓ capability-relative open("dist")
  SiteCapability(root fd, mode, expiry, budgets)
```

必须满足：

- `webRoot` 相对已注册 workspace，`entry` 相对 WebRoot；稳定 URL 中的 workspace-relative entry 必须先验证位于 WebRoot，再转换为这个 `entry`；
- URL origin `/` 映射 WebRoot。HTML 的 `/app.css` 因此读取 `<webRoot>/app.css`；
- URL path 只解码一次，拒绝 NUL、反斜杠、编码 `/`/`\\`、`.`/`..`、Windows drive/UNC/ADS 与任何越界；
- 后续 open 相对已打开的目录句柄进行，防止 check/open 间 symlink swap；无法证明留在 root 内的 symlink fail-close；
- 不提供目录 listing；目录先重定向补 `/`，再读取 `index.html`；
- `.git`、`.genethub` 和常见 dot-secret 默认不可通过站点能力读取。denylist 只做纵深防御，最小 WebRoot 才是主要隔离；
- 单文件预览默认只授权所选文件；“作为站点打开”才授权目录树，并让用户看到 WebRoot 范围；
- local workspace 重注册、root 替换或 placement generation 改变会使旧 SiteCapability 失效。

现有 `file.read` 会随 Data Plane cutover 删除。WebRoot 读取使用独立的 `asset.web.*` Exchange handlers 和 streaming body，不能把图片/视频 base64 塞进 unary payload，也不能复活 legacy RPC。

### 7.1 多文件 HTML 示例

```text
workspace/
  demo/
    index.html        <!-- <script src="/js/app.js"> -->
    js/app.js
    img/logo.png
```

选择 `webRoot=demo`、`entry=index.html` 后，Gateway 映射为：

```text
GET /index.html  -> <workspace>/demo/index.html
GET /js/app.js   -> <workspace>/demo/js/app.js
GET /img/logo.png -> <workspace>/demo/img/logo.png
```

相对与根相对引用都无需改写。若一个引用需要越过 `demo`，用户必须重新选择更宽的 WebRoot；Gateway 或 daemon 不能偷偷放宽。

SPA fallback 默认关闭。显式开启时，只允许 document navigation 的 404 回退到入口，不允许脚本、样式、图片或 Range 请求回退。

## 8. WebRoot Exchange：Gateway 到 daemon 的业务契约

Gateway 以受限 service identity 接入通用 `TransportEndpoint`，再以短期 route admission 打开到 daemon 的 Secure Stream。每个浏览器 HTTP 请求对应一条短生命周期 Exchange stream；`OPEN` 不携带业务字段，method、capability、path、Range 和 response 都从首个加密 DATA 中的 Exchange head 开始。

概念契约：

```text
RequestHead {
  method: "asset.web.get",
  metadata: {
    siteCapability,
    httpMethod: GET | HEAD,
    urlPath,
    range?, ifNoneMatch?, ifRange?
  },
  bodyLength: 0
}
RequestEnd

ResponseHead {
  status,
  metadata: {
    mediaType, contentRange?, etag?, lastModified?, disposition?
  },
  bodyLength?
}

ResponseBody(bytes...)
ResponseEnd
```

### 8.1 Relay 保密

- RequestHead、ResponseHead 和 body 全部由 Gateway-daemon Secure Stream E2EE 保护；
- key/nonce domain、sequence、replay 与 frame authentication 完全复用通用 Data Plane，不为 WebRoot 再建一套 crypto framing；
- Relay 只见 route handle、stream id、record 长度和时序，不见 path、Range、MIME、status 或 bytes；
- Gateway service identity、daemon identity 与短期 admission 必须在 session establishment 中校验；Relay ticket 本身不能冒充任一端点；
- 由于当前 Control 生成 hosted secret，准确表述仍是“Relay 单独不能解密”，不是“平台零知识”；
- daemon canonical 非对称身份落地后，可由通用 Secure Stream handshake 使 Control 不持有 stream key。Gateway 仍是明文端点。

Relay 不得根据 media type、HTTP status 或 path 做路由/限流。frame、stream 和内存上限由 TransportEndpoint 执行，Relay 只执行 opaque route/record 级预算。

### 8.2 流控与取消

- Gateway 不整文件缓冲；只有固定大小 chunk 和总 in-flight budget；
- 浏览器 socket backpressure 传递到 Exchange stream credit，进一步限制 daemon 读取；
- 浏览器断开、Range 被替换或 iframe 卸载时，Gateway RESET 对应 Exchange，daemon 立即停止读盘；
- 单 view 慢读或超限只取消相关 stream，不断开 daemon endpoint，也不影响聊天/终端 route；
- daemon response head 到达前 Gateway 不承诺浏览器 200，避免中途才发现路径/权限失败；
- retry 只允许尚未向浏览器提交 body 的幂等 GET/HEAD。流式 body 已开始后不跨 placement 自动重试。

### 8.3 Gateway 不信任任意响应头

daemon 返回结构化字段，Gateway 自己生成 HTTP header。只允许 Content-Type、Length、Range、ETag、Last-Modified、受净化的 Content-Disposition 等固定集合；拒绝 daemon 注入 Set-Cookie、CSP、CORS、Location、Connection、Transfer-Encoding 或 hop-by-hop headers。

## 9. 对浏览器提供的 HTTP 契约

- 方法：普通资源只允许 GET/HEAD，其他返回 405；bootstrap 是唯一受限 POST，body 有很小硬上限；
- Range：v1 支持单段 byte range、206/416 和 `Accept-Ranges: bytes`，可拒绝 multipart ranges；
- validators：支持 ETag、If-None-Match、If-Range、304；ETag 不编码本机路径；
- directory：无 listing，规范 trailing slash 后按策略读取 index；
- MIME：固定映射 + `nosniff`；未知二进制 attachment；用户文件不能决定 header；
- cache：默认 `Cache-Control: private, no-store`，Gateway、CDN 和对象存储不缓存 body；
- errors：raw origin 对过期、越界、不存在统一给出无路径细节的响应。离线/重新授权等可操作信息由稳定 Viewer 从 Control 状态展示；
- limits：每 view 的并发请求、打开文件、单请求/累计 bytes、空闲时间、硬期限和 Gateway 内存都有上限。

视频必须直通单 Range，而不是先把整个文件经 daemon RPC 读入内存。HEAD 与 Range 需要在 Chrome、Safari/iOS 与 Firefox 的原生 `<video>` 行为中验证。

## 10. HTML、Markdown 与 iframe

### 10.1 Static（默认）

- iframe sandbox 不给 `allow-scripts`、`allow-forms`、`allow-popups`、`allow-top-navigation`；
- CSP 默认只允许同 raw origin 的图片、媒体、字体和样式，禁止 script、object、frame、form、connect 与外部资源；
- `Referrer-Policy: no-referrer`，避免 raw view hostname 和 path 泄漏；
- `Permissions-Policy` 关闭摄像头、麦克风、位置、USB、串口、剪贴板读取等；
- 默认不允许 HTML 通过根相对猜测读取 WebRoot 之外的内容，daemon 的 SiteCapability 是最后边界。

### 10.2 Interactive（显式选择）

- 每个 ViewLease 必须是独立随机 origin，才可给予 `allow-scripts allow-same-origin`；
- 默认仍只允许向 `self` 发网络请求。开启外网即允许页面把 WebRoot 中可读内容外传，必须单独警告和授权；
- top navigation、设备权限、popup 和 download 分项控制，不提供一个含糊的“完全信任”开关；
- Gateway 对 `Service-Worker: script` 请求拒绝，默认 CSP `worker-src 'none'`，view origin 永不复用。本方案既不依赖也不允许预览站点持久注册 Service Worker。

### 10.3 Markdown

daemon 返回原始 `text/markdown`。受信任的 Viewer 使用固定 renderer 和 sanitizer 渲染，默认去除 raw HTML 和危险 URL scheme，并将相对图片/链接绑定到同一 raw WebRoot。Gateway 只为明确的 App Viewer origin 开最小 CORS：GET/HEAD、无账号 cookie、无 wildcard credentials。

assets host 不能继承全站 `X-Frame-Options: DENY`。只在独立 assets vhost 上省略 XFO，使用 CSP `frame-ancestors` 精确放行 App Viewer；应用主站的防嵌入策略保持不变。

## 11. 用户信息与内容分别经过哪里

| 组件 | 必须看到 | 不需要/禁止接收 | 信任结论 |
| --- | --- | --- | --- |
| App/Control | 账号设备会话、workspace/placement、授权结果、ViewLease 生命周期 | 文件 bytes；默认不记 raw path | 托管账号与路由控制面，属于可信平台边界 |
| DNS resolver | 随机 view hostname、客户端查询 IP 与时间 | HTTP path、文件内容 | 可关联一次 raw view 的 DNS 查询元数据 |
| Asset Gateway | 随机 view、目标 route、WebRoot/HTTP path、MIME/status、文件明文、流量元数据 | 邮箱、昵称、长期设备凭证、daemon enrollment secret | **受信任内容处理器**；不是零知识 |
| Fabric Relay | endpoint/route/stream id、E2EE record 长度与时序 | 用户、workspace、path、status、MIME、文件明文和 stream key | 按不可信搬运层设计 |
| daemon | 本机 workspace 映射、SiteCapability、path、文件明文 | 不需要账号 PII | 最终文件授权点 |

因此，“用户信息是否经过服务器”需要拆成两件事回答：

- 登录、配对状态和 workspace 路由必须经过 Control，否则一台没有本地 daemon 的手机无法在公网入口完成授权；
- Gateway 不需要知道用户是谁，只需一个已授权的 opaque ViewLease，但它不可避免地知道所请求的路径和内容；
- Relay 两者都不需要知道，并通过通用 Secure Stream E2EE 保持不可见。

如果目标是连 Gateway/平台也不能看到内容，本方案不满足，不应靠改文案模糊它。

## 12. Gateway 的最小化与审计要求

Gateway 虽在信任边界内，也应按“可看到但尽量不留下”设计：

- 无磁盘 body cache、无对象存储、无离线副本；进程重启不保留资源；
- bounded streaming buffer，不为扫描、缩略图或索引读取额外副本；
- access log 不记录完整 Host、path、query、Referer、bootstrap secret 或 SiteCapability；只记录随机 request id、结果类别、字节数、延迟和区域；
- 若排障必须关联 path，使用每日轮换审计 key 的 HMAC，且访问权限与保留期独立受控；
- APM、错误上报、heap/core dump、反向代理 debug log 禁止采集 body/header；
- Gateway 使用独立服务账号，只能调用 Control 的 view introspection 和 Relay/Fabric endpoint，不能直接查询账号表；
- TLS key、asset route key 与日志读取权限分离，运行用户无 shell/持久卷；
- 所有成功/拒绝/超限都使用低基数原因码，避免错误消息把本机路径带回日志或浏览器。

将 Gateway 与 Relay 部署在同一台宿主机不会改变协议边界，但会扩大“宿主机 root 被攻破”的共同故障域。生产建议至少独立容器/身份/网络策略，高敏感部署独立节点池。

## 13. 威胁与硬性控制

| 风险 | 控制 |
| --- | --- |
| View URL 泄露 | 稳定 URL 无权限；raw hostname 高熵、短 TTL、no-referrer、禁止外网、可即时撤销 |
| Gateway 被用作任意文件读取器 | Control ViewGrant + daemon SiteCapability 双重检查；目标只能是登记 workspace/placement |
| 路径穿越/symlink race | daemon 目录能力、严格单次解码、beneath/no-magic-link 语义；Gateway 也先做语法拒绝但不代替 daemon |
| 恶意 HTML 外传 secrets | Static 默认、最小 WebRoot、敏感目录默认拒绝、Interactive 默认断外网 |
| Gateway/daemon 响应头注入 | 结构化 response head + Gateway allowlist 生成真实 HTTP header |
| Relay 读 path/content | 整个 Exchange request/response 由 Secure Stream E2EE 保护；OPEN 不放业务字段 |
| Control secret 泄露 | View/bootstrap/route secret 短期、分用途、原子核销；长期 enrollment secret 不交给 Gateway/Relay |
| Gateway 内存/连接耗尽 | view/request/stream/process 多层预算，H2 与 Fabric backpressure，取消立即 RESET |
| 跨 view 同源攻击 | 每 view 独立随机 subdomain、handle 永不复用、账号 cookie 使用另一 registrable domain |
| Service Worker 残留 | 不依赖 SW；拒绝 SW script fetch、worker CSP、短期唯一 origin |
| 源在流中变化 | 固定 placement generation、打开 file handle 后流式读、validator；不静默切换机器 |
| 云端残留内容 | no-store、无 body log/cache/dump、保留策略测试和运行权限审计 |

## 14. 容量与故障语义

Gateway 可以水平扩展；权威短期 ViewLease 存在 Control，实例只做有界 cache。浏览器到 Gateway 可使用 HTTP/2；每个资源映射独立 Exchange stream，并复用两端既有的 `TransportEndpoint` carrier。

推荐故障结果：

| 场景 | raw origin | 稳定 Viewer |
| --- | --- | --- |
| 未授权/越界/不存在 | 统一 404 类响应，不回显 path | 在已认证控制通道显示可操作原因 |
| view 过期/撤销 | 统一失效，停止在途流 | 可重新授权并生成新 view |
| daemon 离线 | 503 或流建立失败，无机器细节 | 显示源机器离线和最后 presence |
| placement generation 改变 | 旧 view fail-close | 提示资源源已变化，确认后新建 view |
| Relay/Control 暂时失败 | 不降级匿名或绕过 SiteCapability | 有界重试，超过期限明确失败 |
| Gateway 超载 | 429/503 + Retry-After，不缓存请求 | Viewer 退避，不切换到不安全路径 |

区域选择会决定哪个 Gateway 能看到明文。应支持明确的数据区域，并把跨区域 failover 当作信任/合规决策，而不是纯延迟优化。

## 15. 代码与部署边界

预期改动面：

- 开源 daemon：SiteCapability、capability-relative binary streaming、Range/validators、`asset.web.*` Exchange handlers、取消和预算；
- 开源协议：`asset.web.open/get/close` 的业务 metadata、response fields 与错误码；framing、E2EE 和 flow control 只复用 Data Plane；
- Cloud Control：稳定 Locator、workspace/placement 授权、ViewLease、introspection/revocation；
- 新的 Cloud `assets-gateway`：专用 TLS/HTTP、raw host 路由、TransportEndpoint client、header policy 和流控；
- Web Viewer：fragment 解析、bootstrap、iframe sandbox、Markdown renderer 和离线/撤销 UX；
- Relay：只搬运 endpoint-neutral opaque records，不增加 Asset HTTP 路由、MIME、path、缓存或业务日志。

独立 assets 域的 DNS、TLS、CSP 与日志配置必须和 App/Control vhost 分开。现有应用站点的 XFO/CSP 不能通过一个全局例外被放宽。

## 16. 分期

### Phase 1：daemon 资源能力与 loopback 验证

- SiteCapability、严格路径解析、GET/HEAD/single Range、取消和大文件流；
- 多文件 HTML、png、Markdown 和 mp4 的本机集成测试；
- 固化最小 WebRoot、Static/Interactive 与敏感文件 UX。

### Phase 2：WebRoot Exchange 与 Relay 保密

- Gateway-daemon Secure Stream E2EE、每请求 Exchange、response header allowlist、backpressure/reset；
- 抓包与恶意 Relay 测试证明 OPEN/DATA 中无 path、MIME、status 和内容；
- 不更改 Relay 的业务边界，只补必要的通用流控能力。

### Phase 3：Gateway + 稳定 Viewer

- 独立 assets 域、ViewLease/bootstrap、跨设备授权、iframe 与 Markdown renderer；
- 首先开放图片、Markdown、下载，再开放 HTML Static 与视频 Range；
- raw view 默认短 TTL、no-store、no-referrer，完成日志/trace/body capture 审计。

### Phase 4：Interactive 与生产硬化

- 每 view origin、外网开关、Service Worker 拒绝、源文件外传测试；
- 多实例 ViewLease、区域、限流、daemon 离线/重连和撤销压测；
- Gateway compromise、日志误采集、placement 变化和大流量 runbook。

## 17. 验收标准

功能：

- 没有安装 daemon 的手机和电脑可用同一个稳定 URL 分别授权并预览 HTML/png/md/video；
- HTML `./`、不越界的 `../` 和 `/` 引用按 WebRoot 原生工作，不经过内容重写；
- mp4 在 Chrome、Safari/iOS、Firefox 上可 seek，Gateway/daemon 不整文件缓冲；
- 源 daemon 离线时没有云端旧副本被继续返回。

授权与隔离：

- 未配对浏览器、被撤销会话、过期 view、旧 placement generation 全部 fail-close；
- 两个 view 使用不同 origin，脚本不能读取另一个 view 或 App cookie/storage；
- 越界、双重编码、symlink swap、Windows 特殊路径和 Host 混淆测试全部拒绝；
- Static 不能执行脚本/外传/注册 Service Worker，Interactive 外网默认关闭且 WebRoot 范围可见。

Relay 保密：

- Relay 抓包和 debug 日志中没有 HTTP path/header/status/MIME/file bytes；
- Relay 持有 route/stream metadata 但没有 Secure Stream key，重放、篡改和串 stream 会 fail-close；
- Relay 代码仍不依赖 Asset Gateway、HTTP 资源 schema、数据库或内容处理库。

Gateway 最小化：

- 磁盘、对象存储、CDN cache、access log、APM 和 crash dump 均无资源 body、bootstrap secret 或 raw path；
- 取消和慢读有界，单 view 超限不影响其他 view、聊天或终端；
- Gateway API/服务账号不能读取账号 PII 表或 daemon 长期凭证。

## 18. 与 SNI 方案的取舍

| 维度 | Cloud Asset Gateway | daemon HTTPS + SNI tunnel |
| --- | --- | --- |
| 查看端无需安装 daemon | 是 | 是 |
| 无 Service Worker、原生多文件 HTML | 是 | 是 |
| Relay 看不到 path/content | 是，靠 Secure Stream E2EE | 是，靠 Secure Stream E2EE + 内层 TLS |
| 云端内容服务看不到 path/content | **否，Gateway 可见** | 正常路径中是；Edge 只见 SNI |
| 浏览器到 daemon TLS E2E | 否 | 是 |
| 公网 PKI | 普通 Gateway wildcard/托管证书 | 每台机器独立 wildcard、DNS-01、续期 |
| 新网络基础设施 | L7 Gateway | L4 SNI Edge + raw tunnel + daemon TLS |
| 与现有 Fabric 的贴合度 | 高 | 中；需要通用 TCP/half-close 能力 |
| 运维复杂度 | 中 | 很高 |
| 建议定位 | **后续 WebRoot 默认候选** | 云端明文不可接受时的高级路线 |

推荐决策：当前 MVP 先交付 2 MiB 单文件 Preview，不实现 WebRoot、ViewLease 或 `asset.web.*`。后续确认多文件站点需求后，再先实现两种方案共用的 URL、ViewLease、SiteCapability 与 WebRoot 契约，并以 Cloud Asset Gateway 作为默认候选。SNI 方案只有在 Phase 0 证明公共 CA 可规模化、并且产品明确愿意承担这项成本后进入实现。两条路线共享 TransportEndpoint、daemon 文件能力和 Viewer 语义，但不能用 Gateway 的成功测试替代 SNI/PKI 的安全证明。
