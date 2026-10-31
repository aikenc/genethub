# GeneHub HTML 与阶段文件预览

预览打开源机器目录名单内、且当前连接有权限访问的文件。编写普通静态站点，入口通常为 `index.html`，也应能在桌面直接打开。不要嵌入 GeneHub 专用加载器，不编造 `/assets/preview/...` 地址，不为静态资源启动 HTTP 服务器。

GeneHub 会注入自己的预览加载器，普通静态页面不应把它作为运行前提。影视/DCC/引擎的阶段图像、代理片和结果索引也适用；需要后端、实时状态、原生音视频或操作回传时使用[实时服务预览](live-service.md)及其创作过程参考，保留静态入口，动态能力通过登记服务和可信面板提供。

## 编写

1. 生成入口 HTML 与相邻资源；影视/DCC 产物标明工程、镜头/场景、版本、帧范围或时间码及生成时间，避免把旧结果当成当前进度。
2. 使用相对路径，例如 `assets/photo.png`、`./app.js`、`../shared/style.css`。站点根路径 `/assets/x` 基于最初入口 HTML 所在目录；为保持本地双击可用，优先使用相对路径，不编造预览地址。
3. 分享入口文件而非目录，例如 `[阶段预览](review/index.html)` 或 `review/index.html`。
4. 每个预览文件不超过 64 MiB。站点可以包含多个文件，各资源分别加载；大体积内容先生成合适的代理片、缩略图或分段产物。
5. ES 模块、fetch、图片和 WASM 加载不要求本地静态服务器。`127.0.0.1` 地址不会指向已登记服务；应用后端按[实时服务预览](live-service.md)接入。

## 支持范围

| 需求 | 写法 |
|---|---|
| CSS / JS / ES 模块 | `<link>`、`<script src>`、import/import() 使用字面量相对路径 |
| 图片、音频、视频 | `<img src>`、img.src、new Image()、srcset、video/audio/source；按需加载 |
| 运行时数据 | 相对 URL 的 fetch 或异步 XHR，支持 GET/HEAD、真实状态、取消/超时；同步 XHR 不支持 |
| 分数、偏好 | `localStorage`，预览提供同接口的持久化实现 |
| 页签临时状态 | `sessionStorage`，仅内存保存，重载清空 |
| HTTPS API / CDN | 绝对 https:/wss: URL，可访问网络 |
| WASM | fetch 相对路径的 .wasm，再用 WebAssembly.instantiate |

本地 `<form>` 可用 JavaScript `submit` handler，先 `preventDefault()` 再更新页面；按钮和回车均应在实际预览中验证。表单向 URL 提交仍被 `form-action 'none'` 禁止。聊天中的相对文件链接以项目首 Root 为基准；HTML/Markdown 内部链接以当前文档目录为基准，不能把会话的 `agentCwd` 当作项目根。

预览不开放原生模态窗口：不要依赖 `alert()`、`confirm()`、`prompt()` 或 `window.print()` 完成业务操作。校验提示和删除确认用页面内的文字、对话框与明确的确认/取消按钮；核对单先在页面内完整展开。用户需要纸质输出时，明确说明预览内不能直接唤起打印，再提供可核验的导出文件或本地打开方式；不能把按钮调用成功或打印样式存在当成已能打印。保留已有浏览器数据，并实际点击验证提示、取消和输出入口。

新版 `localStorage` 按源机器、部署 origin、调用者/分享 scope 和最初入口目录隔离；同一站点的二级页面共享存储，owner 与分享访客不共享。旧 daemon 的 v2 仍使用原 namespace；新版 daemon 对 v2 也提供主体隔离，旧值保留、不跨歧义主体自动搬迁。键最多 1 KB、单值最多 128 KB、总量最多 400 KB，超限抛出 `QuotaExceededError`。预览信息面板可以清空；文件重命名/移动会失去原有存储关联。

需要跨版本保留浏览器数据的应用，应从首版起交付固定的用户入口，后续仍从这个入口进入站点；版本归档可另存。直接把聊天入口从 `releases/v1.0/index.html` 换成 `releases/v1.1/index.html` 会改变最初入口目录，即使两版使用相同的 localStorage 键，也不能保证看到旧数据。已经交付不同目录入口时，保留旧版，提供用户明确操作的导出/导入迁移方案，并从用户原来的预览入口验证；只测试本地文件或存储格式不能称为预览升级保留数据通过，不跨目录或分享边界偷偷读取旧存储。

## 不支持的用法

- IndexedDB、Cache API、cookie：沙箱中仍会报错。
- 嵌套 iframe、object、form action：被 CSP 阻止。
- 页面资源中的本机绝对路径、file://、http://127.0.0.1：不能代替站点相对资源路径。聊天文件链接与 HTML 站点 URL 的语义不同。
- 相对 URL 的 `new Worker("w.js")`：不会重写，只使用内联或 blob worker。
- 非字面量 `import(variable)`：仅重写字面量模块路径。
- 任意本地后端 URL：Express、Flask、WS 应用需登记有限 loopback 路由并通过可信工具栏授权。
- 在沙箱中实现麦克风/屏幕采集或 PeerConnection：实时创作预览使用 Service Preview 的可信媒体路径；通用远程桌面和软件控制不能由静态页面权限绕过实现。

## 分享与排障

只链接预览支持的普通文件：HTML/HTM 入口、Markdown、png/jpg/gif/webp、mp4/webm，以及不含 NUL 的有效 UTF-8 文本。不链接目录，不编造部署域名；Workbench 在显示时解析入口。专有工程和仿真缓存不等于可直接预览格式，应先输出实际可查看的阶段产物。

- 空白或 localStorage 的 `SecurityError`：检查是否旧版本，或错误调用了 IndexedDB/cookie。
- 媒体不出现：检查文件存在及相对路径。
- 大型 JS/CSS 图长时间白屏：首屏前仍有资源内联开销，缩小或拆分模块图，让入口先显示内容。
- 二级链接不工作：先记录原始 href、源文件目录和预期目标，检查 `../` 是否保留、query/fragment 是否误入文件名，再验证目标是否在源机器目录名单与当前连接范围内。HTML、Markdown、图片和文本均应由预览导航打开，失败应显示原因。
- 控制台出现 `base-uri` / `frame-src`：检查实际父页响应头是否允许 `base-uri https://preview.invalid`。srcdoc 会继承父页 CSP，页面内 meta 无法放宽它；这是平台问题，不通过改成嵌套 iframe 绕过。
- 点击正常而 fetch/XHR 失败：分别验证运行时 GET/HEAD 与媒体，不只检查静态标签。禁止回退到 Cloud 的同名路径。
- 带参数页面：query/fragment 单独携带，不组成文件名。srcdoc 不是完整 HTTP origin，原生 `location.search`/History API 语义不等价；需要参数时页面可读 `genehubPreviewLocation`，预览会明确显示该限制。
- 运行时错误：从预览信息/诊断面板查看缺失资源和控制台事件，区分平台策略、读取授权与页面脚本错误，不增加绕过预览限制的脚本。
- 需要持续刷新任务进度、视口或应用状态：这属于过程服务，转读[实时服务预览](live-service.md)，不能用静态截图冒充实时结果。

## 已打开页面的实时诊断

若问题发生在已加载客户端联调运行时的 GeneHub 页面，可使用 `genehub` 的客户端联调参考（`genehub/references/client-debug.md`）检查页面状态、
错误、DOM 或重建截图；通过联调 inspect 确认预览 iframe 的同源边界。不向用户静态 HTML 注入联调脚本，
不把 DOM 截图当成跨源媒体或 GPU 画面的原生截图。文件路径/加载器问题仍按本文检查。
