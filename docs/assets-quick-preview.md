# Asset Preview：机器文件与站点导航

Asset Preview 读取源机器上的普通文件。新版文件定位使用稳定机器 ID 和绝对路径；项目仍负责 Agent cwd、Git、会话与项目管理。目录名单不是凭证，所有读取仍经过已认证的 E2EE peer。

## 定位与授权

新版 locator：`/assets/preview/v3/<machineId>?path=<encoded-absolute-path>`，部署子路径由前端 builder 处理。`docQuery`、`docFragment` 单独携带文档参数和锚点，URL hash 留给分享和 popout 的连接材料。不要手拼这些 URL；Agent 分享普通入口链接，Workbench 在渲染时绑定。

旧 `/assets/preview/v2/<device>/<workspace>/<rootHandle>/<relative-path>` 链接与 `workspaceFile` source 继续读取。旧映射缺失直接失败，不按文件名搜索磁盘。新 client 仅在源设备声明 `asset.preview.machine-file.v1` 后发送机器文件请求；旧设备显示明确的不兼容提示。

当前真实运行验证为 Linux Host/WASI 与 Chromium。Windows 保留 v2，不宣告或接受 machine-file v3，待真实 Windows Host 的盘符、reparse 与撤权验收后开放；macOS 和 iPhone 尚无本轮实机验收证据。

有效可访问目录实时派生自：

- 所有未移除项目的 `folders[].root`；同目录的多个项目登记各自保留来源。
- 机器配置 `fileAccess.additionalDirectories`。

设置页“可访问目录”展示两类来源，补充目录按行配置。自动目录不复制进手动配置；移除最后一个来源后，后续读取失去授权。父目录与近似前缀目录按路径组件区分。配置使用目录列表 revision 做 CAS，冲突时先重新加载。

连接的 `files` 权限、workspace-scoped admission 和分享 manifest 与目录名单取交集。旧项目连接只能读其项目目录；分享只能读该分享明确覆盖的文件，不获得其他项目或补充目录的访问权。源机器取自已认证 peer，请求不能替换目标机器。

公开 RPC：

```json
{"type":"fileAccess.list"}
{"type":"fileAccess.configure","payload":{"expectedRevision":"<revision>","additionalDirectories":["/srv/reports"]}}
```

公开 CLI（使用当前会话绑定的 `$GENEHUB_CLI`）：

```sh
"$GENEHUB_CLI" file-access list
"$GENEHUB_CLI" file-access configure --expected-revision <revision> --directory /srv/reports
"$GENEHUB_CLI" workspace open /srv/project/project.code-workspace
"$GENEHUB_CLI" workspace add-root <workspace-id> /srv/another-root
"$GENEHUB_CLI" preview feedback show <machine-feedback-id>
```

配置和登记需 `settings` 权限。权限拒绝不能通过改配置文件、切换 CLI 身份或伪造 proof 绕过。先用 `capabilities`、`schema <command>` 和 `context` 查明真实能力。只新增一个根时使用 add-root，保留项目 ID、历史及其他根。

## 数据平面

旧请求不变，新请求增加一种 source：

```json
{"version":4,"method":"asset.preview","metadata":{"source":{"kind":"machineFile","absolutePath":"/srv/site/index.html"}},"bodyLength":0}
```

`version` 应始终取生成协议的 `DATA_PLANE_VERSION`，上例仅展示 source 形状。Windows wire 路径使用 `C:/dir/file`，由源 daemon 按实际宿主转换为 guest mount；不按浏览器平台猜测。drive-relative、device、未挂载 UNC、NUL、点段路径被拒绝。

返回完整文件，单文件上限 64 MiB。metadata 包含种类、MIME、sourceBytes、内容版本，以及非分享读取可用的 `absolutePath`。metadata、hash、流式传输来自同一打开句柄；不在扫描后重新打开 ambient 路径。native 使用目录 capability，WASI 逐组件持有目录 descriptor 并禁止跟随符号链接，防止目录替换时越界。目录、分享和 files 权限在传输期间重新检查；图片缓存同样不绕过授权。

Relay 保持不透明转发。目录名单、路径、MIME 与文件字节只在 E2EE 端点处理；明文 locator 本身可能出现在浏览器历史和 HTTPS 请求日志中，不能当作秘密。

## 资源与导航

- 聊天相对路径基于实际 Session cwd；文档相对路径基于当前文档目录。
- CSS url 和模块 import 基于各自文件目录；`..` 在解析前不先丢掉。
- HTML `/assets/x` 基于最初入口的站点目录，继续浏览二级页面时保持该目录。它不是源机器的文件系统根。
- 虚拟 `https://preview.invalid/@file/...` URL 编码完整目标文件身份；不从当前目录反向猜测模块和媒体来源。
- HTML、Markdown、图片、视频和文本共用预览内导航。浮窗、独立页、popout 的本地链接都可打开，错误显示在当前预览。工具栏提供前进、后退，锚点定位到目标元素。
- 路径与 query/fragment 分离。srcdoc 无法提供真正站点的 `location.search` 或同源 History API。参数显示在预览中，页面可读取 `window.genehubPreviewLocation.search/hash`；不能把它描述成原生站点路由。依赖原生 origin/路由的应用需要正式 Service Preview 或独立站点。

运行时本地 `fetch` 与异步 XHR 共用文件桥，GET/HEAD 返回实际状态和 Content-Type，支持取消及超时。XHR 支持文本、JSON、ArrayBuffer、Blob 和 document；同步本地 XHR 明确拒绝。已登记的 `/api/` 继续通过服务桥，保留独立 `services` 授权及可信工具栏确认；失败不得悄悄落到 Cloud 站点路径。

字面量 module import 会重写；动态构造 import、相对 Worker、Service Worker、cookie、IndexedDB、Cache API 不在静态预览契约内。HTML 继续使用 opaque `sandbox="allow-scripts"`，嵌套 iframe、object 与表单受限，不增加 allow-same-origin。

## CSP 与诊断

srcdoc 同时受父页响应头和自身 meta CSP 约束。Workbench 与独立预览响应都必须允许 `base-uri 'self' https://preview.invalid`；仅修改 srcdoc 的 meta 无法放宽父页 CSP。保留精确 preview.invalid 来源，不设置通配 base-uri。

加载器在应用启动前检查实际 document.baseURI。基址被拦截时显示平台策略错误，不让应用继续把相对请求发到 Cloud。点击二级链接出现 base-uri 或 frame-src 报错时先检查平台响应头、版本和原始 href；不要把站点改成嵌套 iframe 规避。

iframe 原始诊断只由持有该 frame 的 AssetPreviewPage 校验 `event.source` 后接收一次，再发给工作台收集器。Cloud 不重复监听未经 frame 校验的相同原始消息。运行信息展示源文件传输、资源缺失、控制台和策略错误；函数测试不等于用户点击链路通过。

## 反馈、分享与存储

新反馈存储在 daemon 数据目录 `preview-feedback/machine-files`，按绝对路径和内容版本索引。旧 workspace-file 反馈放在机器数据目录的独立 workspace namespace；按已登记项目的精确旧 `.genethub/preview-feedback` 路径幂等导入，保留原文件，不扫描整盘。导入锚定项目 capability，禁止链接逃逸，并限制单文件 64 MiB、总量 2 GiB、最多 100000 个条目与 64 层目录。新增回执、快照与运行证据引用实际机器数据路径，旧回执保留原引用。

分享仍是有期限、可撤销的精确资源 manifest。同一页面仅更换 hash 中的分享/连接凭证时，入口会重新启动认证并销毁原连接与渲染状态，避免旧角色状态沿用到新链接。服务权限不随文件分享继承。浏览器 localStorage shim 按机器、部署 origin、调用者 scope 与最初入口目录隔离；跨分享不复用 owner 状态。旧 daemon 的 v2 owner namespace 保持读取兼容；新版 daemon 返回当前认证主体的 opaque storageScope，新版 viewer 按该 scope 隔离 owner 与不同账号/分享。不能证明相同主体的旧状态不自动迁入新 namespace。

## 验收边界

编译和类型检查不能替代真实 daemon、真实浏览器和权限验收。至少覆盖 v2/v3 读取、补充目录与 CAS、多个项目同根及移除、近似路径与符号链接、受限连接与分享、二级 HTML/Markdown/跨类型导航、query/fragment、相对 fetch/XHR/媒体、父页 CSP、错误可见和分享撤销。跨平台编译不能冒充在目标 Windows/macOS 上运行通过。
