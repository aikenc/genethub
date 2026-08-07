# 轻量 Asset Preview v2

> 状态：v2 已实现。它保持 v1 的单文件/E2EE 边界，在已验证 MVP 上补齐目录浏览、刷新、文档渲染和 Agent 产物链接。底层连接见 [E2EE Data Plane v3](./e2ee-data-plane.md)。多文件 WebRoot、大文件和公开 Assets Gateway 仍不在本版本内。

## 1. 产品结论

Asset Preview 是给人和 Agent 快速打开 workspace 文件的轻量查看器：

- 唯一入口是 daemon 已注册 workspace 中的**相对文件路径**。
- URL 明文包含稳定 device handle、workspace handle 和相对路径；路径不是秘密，也不是授权凭证。
- 同一个 URL 可在另一台已配对电脑或手机浏览器打开。查看设备不需要安装 daemon；它只需能够加载工作台并持有本地配对凭证，或已登录有权访问该设备的托管账号。
- 文件由资源所在设备的 daemon 读取，经已有 E2EE Data Plane 返回；Relay 不看到 workspace、path、MIME 或文件 bytes。
- 只返回完整原文件。源文件 `<= 4 MiB` 才成功，超过直接提示无法预览。
- 支持图片、Markdown、普通文本、单文件 HTML、MP4/WebM 小视频。
- HTML 可运行 inline/HTTPS script 并访问 HTTPS/WSS 网络，但位于无同源权限的 sandbox iframe 中，不能取得工作台权限。
- 点击文件在独立页面打开。浮窗 iframe、WebRoot 和多文件 HTML 留到后续。
- `file.read` 已删除，文件查看器统一使用 Preview；写文件仍是独立业务能力。

v2 明确不做缩略图、摘要、截断、转码、poster、probe、Range、缓存、上传 bytes、HTTP URL、Git object、多文件目录映射、Service Worker 或 daemon HTTPS。Agent artifact 仍是 workspace 普通文件；本版本只让 Agent 按统一 locator 输出链接，没有新增 artifact 存储。

## 2. 规范 URL

```text
https://<workbench-origin>/<deployment-base>/assets/preview/v1/
  <deviceHandle>/<workspaceHandle>/<workspace-relative-path>
```

例子：

```text
https://app.example/assets/preview/v1/dev_7k2/ws_docs/docs/architecture.png
https://app.example/console/assets/preview/v1/dev_7k2/ws_docs/reports/result.md
```

真实 URL 不换行。`deployment-base` 来自前端构建的 base path，因此根部署和 `/console/` 等子路径部署都能 deep-link。

URL 中的 `/v1/` 是 locator contract 版本，不跟随 Viewer UI 迭代。v2 没有改变 locator 或读取语义，所以不能为了版本名称制造一套等价 URL。

这三个 locator 都是可见的：

- `deviceHandle`：daemon 拥有的稳定设备句柄；不是用户输入的展示名。
- `workspaceHandle`：该连接可解析的 workspace locator。普通本地/整机连接使用 daemon workspace id；workspace-scoped hosted route 可使用 Control 分配的外部 handle。
- `path`：从 workspace 根开始的规范相对路径，例如 `docs/readme.md`。

URL **不是 capability**。仅知道或转发 URL 不会获得文件：Viewer 必须重新取得目标 endpoint/route，并以当前浏览器已有的配对 credential 或账号 session 完成 peer authentication。daemon 最终再次校验 workspace scope 和 path。

前端统一使用：

```ts
assetPreviewUrl(deviceHandle, workspaceHandle, relativePath)
parseAssetPreviewPath(location.pathname)
```

FilesPanel、Agent 输出和聊天链接应共享这个 builder，不能手拼 URL。解析器要求 percent-encoding canonical round-trip，拒绝 encoded slash、空 segment、`.`、`..`、反斜杠、NUL、drive/ADS 冒号和平台尾随点/空格。相对 path 最多 4096 UTF-8 bytes；device/workspace segment 最多 256 字符。

## 3. 打开流程

```text
用户点击规范 URL
  │
  ├─ Viewer 解析 device/workspace/path
  ├─ Host.targets() 按 deviceHandle 找目标
  ├─ Host.openTarget() 获取新 endpoint + one-use route admission
  ├─ Client 完成 v3 peer authentication
  ├─ 校验 daemon 返回的 machineId == URL deviceHandle
  └─ 发起 asset.preview Exchange
         └─ daemon 校验 workspace/path、完整读取、返回 bytes
```

Cloud console 在入口就识别 Preview deep link，并使用账号机器列表或浏览器本地 pairing roster 解析设备；不要求先进入 workbench 选择机器。连接重建会重新签发 one-use Fabric endpoint/route ticket，不复用已消费票据。

独立 Viewer 为本次预览创建自己的 `Client`。页面卸载会关闭该 client、所有在途 stream 和 RTC/Fabric carrier，并释放 Blob URL。它不依赖另一个 tab 中已存在的 JS connection，因此链接可以复制到已授权的其他设备。

## 4. Exchange 契约

Preview 只是通用 v3 Exchange method，不定义新的 transport：

```text
RequestHead {
  version: 3,
  method: "asset.preview",
  metadata: {
    source: {
      kind: "workspaceFile",
      workspaceHandle,
      path
    }
  },
  bodyLength: 0,
  timeoutMs: 15000
}
FIN

ResponseHead {
  status,
  metadata: {
    kind?, mediaType?, sourceBytes?, version?,
    error?: notFound | forbidden | unsupported | tooLarge | sourceChanged,
    limitBytes?: 4194304
  },
  bodyLength
}
DATA*
FIN
```

method、metadata、status 和 body 都在 E2EE record 内。body 是 streaming bytes，不经过 JSON/base64；DataEndpoint 自动切成最多 16 KiB record 并与其他 logical streams 公平轮转。

请求没有 body。成功 response 的 `bodyLength`、`sourceBytes` 和实际收到的 bytes 必须完全相等且不超过 4 MiB，否则 Viewer fail-close 当前 stream。失败 response body 必须为空。

`source.kind` 在 MVP 只有 `workspaceFile`。未来若支持 artifact、Git revision 或生成文档，应新增明确 contract，而不是让 `path` 指向 workspace 外资源。

## 5. daemon 文件边界

```text
MAX_PREVIEW_SOURCE_BYTES = 4 * 1024 * 1024
PREVIEW_WORKERS = 2
PREVIEW_TIMEOUT = 15 seconds
```

daemon 的顺序是：

1. 校验 canonical workspace-relative path。
2. 校验 route 限定的 workspace handle；解析为 daemon-local workspace id。
3. 从已注册 workspace 获取 root，以 capability directory API 打开相对路径。
4. 要求目标是普通文件；不把目录、FIFO、设备或 socket 当文件流。
5. 先读 metadata。大于 4 MiB 直接返回 `tooLarge`，不开始传输。
6. 最多读取 `4 MiB + 1`；增长越界返回 `tooLarge`，长度变化返回 `sourceChanged`。
7. 按扩展名和有限 magic/UTF-8 规则确定 allowlist 类型。
8. 对完整 bytes 计算截短 SHA-256 version，发送精确 response head 和 body。

文件读取在 `spawn_blocking` 中执行，最多两个并发 Preview worker；它不占 carrier reader 或 DataEndpoint writer task。handler 等待 worker 时只占自己的 logical stream。

路径边界使用 `cap-std::fs::Dir` 相对于已验证 workspace root 打开，并有 symlink escape 测试。绝对路径、`..`、编码分隔符和平台歧义 spelling 在 URL 层与 daemon 层分别拒绝，不能依赖前端校验作为安全边界。

## 6. 类型 allowlist

成功响应只产生以下组合：

| kind | mediaType | 识别规则 |
|---|---|---|
| `image` | `image/png` | `.png` + PNG signature |
| `image` | `image/jpeg` | `.jpg/.jpeg` + JPEG signature |
| `image` | `image/gif` | `.gif` + GIF87a/GIF89a |
| `image` | `image/webp` | `.webp` + RIFF/WEBP |
| `video` | `video/mp4` | `.mp4` + `ftyp` box marker |
| `video` | `video/webm` | `.webm` + EBML marker |
| `markdown` | `text/markdown` | `.md/.markdown/.mdown` + valid UTF-8 |
| `html` | `text/html` | `.html/.htm` + valid UTF-8 |
| `text` | `text/plain` | 明确的源码/配置/日志扩展名 + valid UTF-8 |

文本前 8000 个字符含 NUL 或 UTF-8 非法时拒绝。daemon 不相信浏览器传来的 MIME，也不做通用 MIME sniffing。未知扩展名、扩展名与 magic 不符或其他二进制返回 `unsupported`。

## 7. 浏览器渲染

### 图片与视频

Viewer 用完整 bytes 创建带 daemon allowlist MIME 的 Blob URL。图片使用 `<img>`，MP4/WebM 使用带 controls 的 `<video>`。没有 Range 和转码，因此 4 MiB 上限同时控制内存和首屏等待。

### Markdown 与文本

Markdown 使用 `react-markdown` + GFM，不启用 raw HTML。document 变体有完整标题层级、列表/任务列表、引用、表格、inline code、代码块复制与常用语言语法着色；未知语言由 highlighter 自动识别，单块超过 256 KiB 时回到已转义纯文本，避免高亮器独占主线程。普通文本按 UTF-8 解码到 `<pre>`。

````markdown
```mermaid
flowchart LR
  Agent --> File --> Preview
```
````

`mermaid` fence 按需加载独立 bundle，普通 Markdown 不加载它。输入最多 128 KiB，`securityLevel=strict` 且禁用 HTML label；输出再次移除 script、foreignObject、image、link 与事件属性，最后作为 Blob SVG `<img>` 显示，而不是把活动 SVG 注入工作台 DOM。Markdown 作者声明图片不会自动联网；普通链接只在用户点击后以独立 tab 和 `noopener/noreferrer` 打开。

Preview 页根容器显式占满固定的 `body/#root`，只有正文 pane 使用 `overflow-y:auto`，因此长文档在手机和桌面都可滚动，工作台 chrome 不参与滚动。

### 活动单文件 HTML

HTML 在 `iframe srcdoc` 中运行：

```html
<iframe
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  srcdoc="..."
/>
```

关键边界：

- 没有 `allow-same-origin`，document 是 opaque origin，不能读父页面 DOM、cookie、localStorage、IndexedDB 或 GeneHub credential。
- 没有表单、弹窗、top navigation、下载、摄像头、麦克风、定位、剪贴板、USB、串口或 worker 权限。
- Viewer 删除源文件自带 `<base>` 和 CSP，插入固定 `https://preview.invalid/` base 与自己的 CSP。
- 允许 inline script/style，以及绝对 HTTPS script/style/image/media/font 和 HTTPS/WSS connect。
- 禁止 object、嵌套 frame、worker、form action；相对资源会指向不可用的固定 base，不会隐式读取 workspace 邻接文件。
- UI 明示“活动 HTML · 网络已开启”。

`srcdoc` 会继承承载 Preview 页面的 HTTP CSP；iframe 内的 `<meta>` 只能继续收紧，不能放宽它。因此生产 edge 必须只对 `/assets/preview/v1/*` 页面提供上述 active-HTML CSP，并让普通工作台继续使用不含 `unsafe-inline` 的严格策略。Cloud 的 Caddy 配置已按路径分开；自托管若统一下发 `script-src 'self'`，HTML 文档能显示，但其中脚本会被浏览器阻止。这是部署契约，不能靠在 iframe 内插入另一条 CSP 绕过。

“允许网络”是产品取舍：HTML 本身可向互联网发送它已经拥有的文件内容，所以用户不应把不可信 HTML 当成静态文档；但 sandbox 隔离保证它不能因此取得 GeneHub 页面或其他本地文件的权限。未来若提供无网络模式，应是显式渲染模式，不与当前契约混淆。

## 8. 多文件 HTML 为什么不在 MVP

相对 URL 需要一个可解析的目录命名空间；单次 E2EE Exchange 只返回一个文件，浏览器不会自动把 iframe 的后续 HTTP 请求映射回 daemon。正确方案需要 WebRoot session、受限资源路由、生命周期、缓存/Range 和更细的 path policy，或 daemon HTTPS + 字节隧道。

MVP 的固定 base 会让相对 CSS、JS、图片和模块 import 明确失败，而不是悄悄发起新的未授权 workspace read。多文件站点应使用 [云端 Assets Gateway](./assets-cloud-gateway.md) 或 [daemon HTTPS + SNI 字节隧道](./assets-daemon-https-sni-tunnel.md) 的后续提案；不引入 Service Worker。

## 9. 错误与用户提示

| error | HTTP-like status | UI 含义 |
|---|---:|---|
| `notFound` | 404 | 找不到文件 |
| `forbidden` | 403 | workspace/path 不在当前授权内 |
| `unsupported` | 415 | 类型不在 allowlist |
| `tooLarge` | 413 | 超过 4 MiB，不预览 |
| `sourceChanged` | 409/500/408 | 读取期间变化、worker 异常或超时，请重试 |

连接未配对、设备离线、URL 设备与握手身份不一致、版本不兼容和 E2EE 认证失败使用连接层错误，不伪装成文件不存在。协议版本不匹配直接关闭，不尝试旧 `file.read`。

## 10. v2 文件界面与 Agent 链接

FilesPanel 把目录和文件交互彻底分开：文件才打开 Preview，目录只在当前树中展开。每次打开 Files pane 都重新获取 root；窗口重新获得焦点/可见性时自动刷新，并提供明确的“刷新”按钮。root 刷新后，仍处于展开状态的目录会重新获取自己的 subtree，不会把整个工作台导航到目录 URL，也不会永久停在“载入中”。

浏览器在每次 `session.send` 中附带结构化 `artifactPreviewBaseUrl`：

```text
https://<当前域名>/<当前渠道>/assets/preview/v1/<device>/<workspace>/
```

这是上下文，不是 capability。daemon 只接受 canonical HTTP(S)、无 userinfo/query/fragment、精确包含一个 device/workspace 且 workspace 与当前 session 一致的 Preview prefix；它生成产品固定的路径规范提示，客户端不能直接传任意 system prompt。提示要求 Agent 只追加逐 segment percent-encode 的 workspace-relative path，并只链接已存在、类型受支持且不超过 4 MiB 的普通文件。

`SessionConfig.additional_system_prompt` 是唯一 adapter 边界：

| Adapter | 注入方式 |
|---|---|
| Genet Agent | `--add-system-prompt`，进入真实 provider system prompt |
| Claude Code | `--append-system-prompt` |
| Codex app-server | `developerInstructions`（start/resume） |
| OpenCode | `/session/:id/message` 的原生 `system` 字段 |
| ACP（Cursor/自定义） | ACP 没有标准 system 字段；adapter 每回合放一个有界、明确标记且不写入 GeneHub 时间线的前置 context block |

域名、deployment channel、device 和 workspace 全由当前浏览器 builder 动态组装，daemon/Agent 不猜 Cloud 地址，也不把 Relay 内部地址写入提示。链接复制到另一台已授权电脑或手机后，仍按第 3 节重新鉴权并建立 E2EE stream。

## 11. 验收

- URL 可 round-trip Unicode、空格和部署子路径；拒绝 traversal、encoded slash、反斜杠和非 canonical encoding。
- FilesPanel 用当前 daemon identity + workspace id + 相对 path 生成独立 Viewer URL。
- Cloud 根入口可直接渲染 Preview deep link，并按 URL device handle 找账号或本地 pairing target。
- 两台独立已配对客户端能用同一 locator 通过真实 self-hosted Relay/daemon 读取相同 bytes。
- 文件恰好 4 MiB 成功，4 MiB + 1 byte 明确 `tooLarge`；没有截断或 overview。
- 目录只展开不导航；重新打开、回到页面或按刷新均能看到新文件，展开目录在 root refresh 后自行恢复。
- 长 Markdown 可滚动，GFM/inline code/fenced code 高亮和安全 Mermaid 流程图可用。
- `session.send` 的 Preview prefix 包含当前 origin、deployment channel、device 与 workspace；daemon 拒绝 active/ambiguous URL，所有已注册 adapter 都收到同一产品规范。
- allowlist、UTF-8、magic、普通文件和 symlink escape 均有 daemon 测试。
- 成功 response 精确校验三处长度；取消、超时和页面关闭能释放 stream/client/Blob。
- HTML script 可运行，网络策略可见，父页面同源权限不可得，相对 workspace 资源不可解析。
- `file.read`、`FileContent` 和旧查看器没有运行路径或 fallback。
