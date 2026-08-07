# 提案 C：轻量 Asset Preview（Exchange streaming + 2 MiB 直接拒绝）

> 状态：MVP 设计，尚未实现。通用连接、WebSocket/WebRTC providers、framing、调度、请求响应和无 fallback 迁移规则见 [轻量 E2EE Data Plane](./e2ee-data-plane.md)；完整 WebRoot、大视频和任意文件流是后续能力，见 [云端 Assets Gateway](./assets-cloud-gateway.md) 与 [daemon HTTPS + SNI 字节隧道](./assets-daemon-https-sni-tunnel.md)；信任边界见 [安全模型](./security-model.md)。

## 1. 决策摘要

- Preview 是普通的 streaming `Exchange` handler，不定义 transport、DataFrame 或专用物理连接。
- Viewer 发出一次 `asset.preview` request；它独占一条短生命周期 logical stream。daemon 先返回 bounded response head，再把文件写入 response body；`TransportEndpoint` 自动切为不超过 16 KiB 的 frame 并公平调度。
- daemon 只返回完整原文件：`sourceBytes <= 2 MiB` 才能预览，超过即 `tooLarge`；不做 thumbnail、摘要、截断、转码、poster、probe 或 Range。
- 图片、Markdown、普通 UTF-8 文本、单文件 HTML 和小视频由浏览器基于完整 bytes 展示。
- HTML 完整运行 inline CSS/script，并允许绝对 HTTPS/WSS 网络访问；但不能读取 workspace 相对文件。UI 明示“活动 HTML · 网络已开启”。
- `asset.preview` 成为用户可见文件读取入口；同一次协议 cutover 中删除 `file.read` 及所有旧调用，不保留兼容周期或 fallback。
- 点击文件默认打开独立 Viewer；规范 URL 直接包含 workspace handle 与 workspace-relative path，便于 FilesPanel、Agent 和聊天生成可点击文档链接。同一 URL 可由另一台已配对电脑或手机重新授权打开。
- MVP 唯一 source 是已注册 workspace 中的普通文件。它不接受上传 bytes、Blob、HTTP(S) URL、Git object、内存文档、Agent artifact id 或任意绝对文件系统路径。
- 不增加 Service Worker、daemon TLS、HTTP Range、媒体处理依赖或云端内容缓存。

这份文档只回答 Preview 的业务契约。WebSocket/WebRTC provider selection、frame size、flow control 与 handler 隔离全部由通用 Data Plane 决定。Preview 使用当前 ready provider，既不强制 RTC，也不感知 RTC 是否连通。

## 2. Preview 的 Exchange 契约

Preview 使用通用 HTTP-like Exchange：

```text
RequestHead {
  method: "asset.preview",
  metadata: {
    source: {
      kind: "workspaceFile",
      workspaceHandle,
      path
    }
  },
  bodyLength: 0,
  timeoutMs
}
RequestEnd

ResponseHead {
  status,
  metadata: {
    kind?,
    mediaType?,
    sourceBytes?,
    version?,
    error?: notFound | forbidden | unsupported | tooLarge | sourceChanged
  },
  bodyLength?
}
ResponseBody(bytes...)
ResponseEnd
```

它没有 `preview/1` transport，也不在 Fabric OPEN 中放 service metadata：

- method、workspace、path、MIME、错误和 body 都位于端到端加密的 Exchange stream 内；
- WebSocket provider 上 Relay 只见 opaque endpoint/route、stream/frame 长度和时序，不见 Preview 语义或内容；RTC direct 时 Preview bytes 不经过 Relay；
- request/response 由 logical stream identity 关联，不占用全连接 request id 或业务 sequence；
- response body 是 streaming bytes，不经过 JSON/base64，也不使用只适合小对象的 unary wrapper；
- Viewer 取消、超时或关闭时 RESET 这一条 stream，不关闭 endpoint、PeerConnection 或其他业务；
- Preview 是只读且幂等，但断线后也不自动跨 placement 重放；Viewer 重新取得 route/capability 后发起新 Exchange。

业务 handler 不选择 provider、物理连接或 priority。大 response 出现 backlog 后，`TransportEndpoint` 的等权 round-robin 会自动把它与其他 runnable streams 轮转。

`source.kind` 在 MVP 不是可扩展 union：唯一合法值就是 `workspaceFile`。显式字段只是把安全边界固定在协议里，避免未来 Agent 为了预览临时内容而绕过 workspace/path 授权。未来若增加 artifact、Git revision 或 generated document，应新增独立 source contract 和生命周期，而不是把内容塞进 `path`。

## 3. daemon handler：完整文件或明确失败

```text
MAX_PREVIEW_SOURCE_BYTES = 2 * 1024 * 1024
```

规则只有一条：**完整原文件不超过 2 MiB 才返回；否则不预览。**

handler 的最小实现：

1. 在独立 handler task 中校验 workspace capability 与 path；通过已有 directory-safe API 打开普通文件，拒绝目录、设备、FIFO/socket、绝对路径、`..`、Windows prefix/ADS 与越界 symlink。
2. 从已经打开的 handle 读取 metadata；`size > 2 MiB` 立即返回 `tooLarge` response head，不读取 body。
3. 对合格文件最多读取 `2 MiB + 1 byte`；如果文件增长、版本变化或多出一个 byte，返回 `sourceChanged/tooLarge`，不发送 partial body。
4. 检查 allowlisted 类型。文本必须是有效 UTF-8；不支持的类型返回 `unsupported`。
5. 发送成功 ResponseHead 后，把完整 bytes 写入 Exchange body；TransportEndpoint 负责 16 KiB frame、credit 和调度。

文件读取在 Data Plane 提供的有界 blocking/IO pool 中进行。carrier reader/writer 不调用这个 handler；磁盘慢、FIFO 欺骗、handler timeout 或 response backpressure 只能停住当前 stream。

可以为不超过 2 MiB 的合格文件使用单个有界 buffer，以便在发送 ResponseHead 前确认“完整或失败”。这不是通用 Data Plane 聚合 body 的许可；它是 Preview 业务上限内的原子展示选择。

## 4. 支持类型

| 类型 | daemon 工作 | Browser 工作 | 超过 2 MiB |
| --- | --- | --- | --- |
| PNG/JPEG/WebP/GIF | magic/扩展名校验，原 bytes | Blob + `<img>` | 无法预览 |
| Markdown | UTF-8 校验，原 bytes | 安全 Markdown renderer | 无法预览 |
| 普通文本/代码 | UTF-8 校验，原 bytes | `<pre>` 或编辑器 | 无法预览 |
| 单文件 HTML | UTF-8 校验，原 bytes | network-enabled sandbox iframe | 无法预览 |
| MP4/WebM 等小视频 | magic/扩展名校验，原 bytes | Blob + `<video>` | 无法预览 |

MVP 明确没有：图片解码或 thumbnail、Markdown outline/摘要、HTML prefix/修复、视频 probe/poster/转码、Range、offset read 或 arbitrary download。Exchange streaming 只是通用传输方式，不能被 Preview handler 扩展成无上限文件下载器。

2 MiB 只限制源 bytes，不限制图片解码像素、HTML/script CPU 或第三方网络响应。独立页面能隔离普通 UI 生命周期，但不是进程级资源沙箱；目标浏览器无法可靠承受的格式应直接不支持。

## 5. 单文件 HTML：完整渲染，明确允许网络

“单文件”只限制 workspace 输入：daemon 只发送一个 HTML 文件，不解析或打包相邻文件。它不表示浏览器离线。

- 完整 HTML bytes 不截断；inline HTML、CSS、classic/module script 和 event handler 可以运行；
- 绝对 `https:` 图片、字体、样式、脚本、媒体以及 fetch/XHR 可以由浏览器访问，`wss:` 也可用；
- `./app.js`、`/style.css` 等 workspace 相对引用不解析。需要相邻文件时使用完整 WebRoot；
- `http:` mixed content、外部 iframe、object/embed、worker、form submit、popup/download、top navigation 和敏感浏览器权限仍阻断。

### 5.1 产品承诺

允许 script 联网后，准确边界是：

> GeneHub 保护 Browser↔daemon 传输、Relay 保密性、应用 session 和未选择的 workspace 资源；GeneHub 不保证被打开的 HTML 本身仍然保密。

HTML 可以读取自己的 DOM/source 并发往允许的 HTTPS/WSS endpoint；第三方会看到 viewer IP、User-Agent 和时间等元数据，浏览器也可能按自身策略携带目标站点的 ambient credential。这不是 E2EE 失效，而是明文到达授权浏览器后，用户运行了一个可联网的 active document。

这是可接受的产品取舍，但 Viewer 必须始终显示 `活动 HTML · 网络已开启`。第一版不提供容易产生错误安全感的“严格离线”开关。将来如需审查不受信任 HTML，应另做默认禁脚本的 inert/sanitized mode。

### 5.2 Renderer 隔离

HTML iframe 必须：

- 只在用户显式打开后创建，使用 `sandbox="allow-scripts"`，不加入 `allow-same-origin`、forms、popups、downloads、modals 或 top-navigation；
- 不注入 access token、route ticket、workspace handle、设备密钥或 parent API；不接受文档的 `postMessage`，不提供 host bridge；
- 在任何用户节点之前插入可信 CSP 与固定首个 `<base href="https://preview.invalid/">`，移除用户 `<base>`/CSP meta，使相对 URL 失败而不是落到 GeneHub origin；
- CSP 只开放 inline/HTTPS script/style、data/blob/HTTPS 图片媒体与 HTTPS/WSS connect，并阻断 object、frame、worker 和 form；
- 设置 `referrerpolicy="no-referrer"`；Permissions Policy 关闭 camera、microphone、geolocation、clipboard、USB、serial、display capture、fullscreen 和 presentation；
- 不依赖实验性的 `credentialless` 作为安全边界。若 GeneHub 使用 ambient cookie 授权，发布前必须证明 opaque-origin iframe 不能凭 cookie 改变 GeneHub 状态，或使用无 GeneHub cookie 的隔离 renderer origin。

网络开放后，验收重点不是“零请求”，而是 iframe 无法访问 parent/session、无法读取其他 workspace 文件、相对 URL 不命中 GeneHub，且敏感权限和导航能力被阻断。

## 6. 独立 Viewer 与跨设备 URL

稳定 Locator：

```text
https://app.genethub.com/assets/preview/v1/w_6M4Q/docs/readme.md
https://app.genethub.com/assets/preview/v1/w_6M4Q/reports/实验%20结果.md
```

- URL 是 locator，不是 capability。`w_6M4Q` 标识已注册 workspace，余下 pathname 是 workspace-relative file path；不包含 daemon 的 workspace root，也不接受 `/Users/...`、盘符或 UNC 绝对路径；
- path 不再放 fragment，也不作为秘密处理。它会出现在地址栏、浏览器历史、复制内容和普通 Frontdoor URL 处理中；文件名敏感的 workspace 不应把链接贴到不可信位置；
- URL builder 必须逐 segment UTF-8 percent-encode。Viewer 恰好解码一次，拒绝空目标、`.`、`..`、NUL、反斜杠、编码 `/`/`\\`、Windows drive/UNC/ADS 和非规范等价形式；daemon 在已授权 workspace root 下重新执行同样的 path 边界检查；
- Agent/Chat 只通过共享的 `assetPreviewUrl(workspaceHandle, relativePath)` builder 生成链接，不能拼接 URL，也不能把当前机器绝对路径转换成链接；Agent 必须先把文档写入当前 workspace，再引用它；
- 另一台已配对电脑或手机打开同一链接时，以自己的 session 重新取得 daemon route 与业务 capability，再发起新的 Preview Exchange；查看端不需要 daemon，源 daemon 必须在线；
- FilesPanel 使用 `window.open(viewerUrl, "_blank", "noopener,noreferrer")`；Viewer 不依赖 opener；
- 页面拥有自己的 Exchange、loading/error、Blob 与 iframe 生命周期。关闭页面即 RESET stream 并 revoke Blob URL；
- 页面只允许同源 workbench 将来 iframe；第三方站点不能嵌入。浮窗以后复用同一 Viewer URL，不复制 renderer。

第一版不做 modal、浮窗状态同步、拖拽、多 pane 或 Service Worker。

## 7. `file.read` 废弃

当前 `file.read` 最多读 2 MiB，文本可能截断，二进制只返回占位字符串；这与“完整文件或明确失败”冲突，也会把大内容塞进 legacy JSON RPC。项目尚在早期，因此直接迁移并删除，不维护 deprecation runtime。

迁移规则：

1. `file.tree` 保留并迁移为小 unary Exchange；`file.write` 迁移为独立 mutation Exchange。
2. Web 的 `openFile(path)` 改为打开 Viewer；Viewer 只使用 streaming `asset.preview` Exchange。
3. 普通 UTF-8 text/code 加入 Preview allowlist，现有 `.rs/.json/.txt` 查看能力不倒退。
4. 若保留编辑，初始化读取使用 Preview exact bytes；保存仍走 `file.write`，不复用 Preview stream。
5. 同一个应用协议 bump 中删除 `Request::FileRead`、`Reply::FileContent`、daemon handler、Web store 字段、旧调用与旧测试。
6. 不提供旧/新协议 adapter、feature flag、解析失败 fallback 或兼容周期。版本不匹配只显示 `upgradeRequired`。

删除的是旧查看协议，不是 directory-safe open、`file.tree` 或 `file.write`。Preview 必须随全量 Data Plane cutover 一起交付，不能成为 legacy Client 旁边的第二条长期路径。

## 8. 失败、资源和日志

| 条件 | 结果 |
| --- | --- |
| 文件 `> 2 MiB` | `tooLarge`，显示实际大小与 2 MiB 上限 |
| 读取期间变化 | `sourceChanged`，不展示 partial |
| 类型不支持/文本非 UTF-8 | `unsupported`，不回退 arbitrary download |
| daemon 离线 | 显示 placement 离线，不从云端取旧副本 |
| placement 歧义 | 要求用户选择，不随机切源 |
| Viewer 关闭/超时 | RESET 当前 Exchange，其他 streams/session 保持可用 |

daemon 建议最多并发 2 个 Preview，单 Preview deadline 15 秒，单文件 buffer 最多 `2 MiB + 1`。读取运行在有界 blocking pool；普通 async timeout 不能假装强杀已经阻塞的 OS read，但 timeout 后不得继续排队发送。

daemon/Relay structured logs 只允许 source size bucket、result bytes、duration、renderer kind 和低基数错误码；不主动记录 path、HTML title、Markdown 内容、精细 MIME 或 body。规范 Viewer URL 已明确暴露 workspace-relative path，因此 Frontdoor access log、浏览器历史和用户复制内容可能含 path；这不是 Preview 的保密承诺。浏览器仍不得把文件 bytes 放进 URL、localStorage、IndexedDB、Service Worker cache 或错误上报。

## 9. 最小实施顺序

### Phase A：通用 Data Plane 基础

- WebSocket 与 WebRTC `TransportEndpoint`、Exchange 与 Duplex 均能完成同一个小 unary 调用；
- 16 KiB frame、逐流 credit、等权 round-robin、RESET、有界队列与 handler 隔离测试通过；
- Preview 不自行访问 WebSocket、RTCDataChannel、provider selector 或 frame encoder。

### Phase B：Preview、Viewer 与业务迁移

- 实现 `asset.preview` Exchange、2 MiB exact-or-error、类型 allowlist；
- 实现唯一的 `workspaceFile` source、规范 path URL/parser 与共享 `assetPreviewUrl()` builder；
- 实现独立 Viewer 与图片/Markdown/text/video Blob 生命周期；
- 文件树点击 Viewer，同一 URL 在另一已配对浏览器重新授权可用；
- Agent 写入 workspace 的 Markdown/HTML/图片等文件后，可以只凭 workspace handle + relative path 输出同一 Viewer 链接；
- 相同 Preview contract suite 分别覆盖 WebSocket 与 RTC provider，RTC 建立/断开不改变业务响应；
- 将所有其他 legacy 请求、push 与 PTY 按 Data Plane 迁移表迁完；中间状态不发布。

### Phase C：HTML 与原子 cutover

- 实现 network-enabled sandbox、固定 base、CSP/Permissions Policy 和 host 隔离测试；
- bump 协议版本，同时切换 Web/daemon 入口并删除 `file.read` 及其余 legacy Client/codec/handler；
- 静态搜索、编译和端到端测试证明无旧调用、无 dual stack、无 fallback；
- 浮窗、多文件 HTML、Range 与 WebRoot 都留给后续独立能力。

## 10. 验收标准

业务/连接解耦：

- Preview 模块只依赖 Exchange request/response/body API，不 import WebSocket、RTCDataChannel、DataFrame、provider 或 scheduler；
- 一次 2 MiB response 在 wire 上自动成为不超过 16 KiB 的 frames；Preview handler 没有 chunk size 常量；
- handler 慢读、慢写、磁盘阻塞或 Viewer 取消，不停住 carrier loop 或其他 Exchange；
- WebSocket 路径的 Relay 抓包和日志看不到 method、workspace path、MIME、错误或 body；RTC 路径不经过 Relay 数据面。

文件/产品：

- `size == 2 MiB` 完整展示；`size > 2 MiB` 在 body 前失败；没有任何 overview、截断、转码或 Range 路径；
- traversal、absolute path、Windows prefix/ADS、symlink escape 与未授权 workspace 全部 fail-close；
- pathname 中的 workspace-relative path 可见、可复制且 round-trip；空路径、双重编码、编码分隔符与非 `workspaceFile` source 全部拒绝；
- 点击打开独立 Viewer；同一 URL 可由另一已配对浏览器重新授权；Web、daemon、proto 与测试中无 `file.read`/`FileContent` 运行路径；
- FilesPanel、Agent 与 Chat 使用同一个 URL builder；Agent 不能预览 workspace 外路径或尚未落盘的内容；
- RTC connected 时新 Preview 走 direct provider；RTC 不可用时同一 Preview 契约走 WebSocket，业务层没有 provider 分支；
- 没有 legacy adapter、兼容 feature flag 或 fallback；旧版本只得到 `upgradeRequired`；
- Viewer 关闭后 stream RESET、Blob revoke，正文不进入持久缓存或 telemetry。

HTML：

- inline 与绝对 HTTPS 依赖可运行；workspace 相对 URL 不访问 GeneHub，也不被解释为相邻文件；
- iframe 无 parent/session/host bridge，不能读取未选择文件；敏感权限、frame、form、popup/download 和 top navigation 被阻断；
- UI 明示网络开启，文档和测试不声称 no-egress；cookie-auth 场景通过跨 origin/CSRF 验证。

结论：Preview 只是一项 2 MiB 内“完整文件或明确失败”的业务能力。它恰好是验证 streaming Exchange、背压和 handler 隔离的好用例，但不再反向定义连接模型。
