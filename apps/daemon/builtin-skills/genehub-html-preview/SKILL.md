---
name: genehub-html-preview
description: 编写、预览和诊断 GeneHub Asset Preview 中的静态 H5/HTML5 游戏、站点、相册、看板及内容创作阶段产物索引。用于创建 index.html、分享工作区文件、相对资源、localStorage、fetch、图片和 WASM，或处理预览空白、缓慢、SecurityError。影视/DCC/游戏引擎需要实时过程状态、本地后端、原生 WebRTC 或远程操作时，转向 genehub-service-preview。
---

# GeneHub HTML 与阶段文件预览

预览打开用户点击的工作区文件。编写普通静态站点，入口通常为 `index.html`，也应能在桌面直接打开。不要嵌入 GeneHub 专用加载器，不编造 `/assets/preview/...` 地址，不为静态资源启动 HTTP 服务器。

GeneHub 会注入自己的预览加载器，普通静态页面不应把它作为运行前提。影视/DCC/引擎的阶段图像、代理片和结果索引也适用；需要后端、实时状态、原生音视频或操作回传时使用 `genehub-service-preview` 及其创作过程参考，保留静态入口，动态能力通过登记服务和可信面板提供。

## 编写

1. 生成入口 HTML 与相邻资源；影视/DCC 产物标明工程、镜头/场景、版本、帧范围或时间码及生成时间，避免把旧结果当成当前进度。
2. 使用相对路径，例如 `assets/photo.png`、`./app.js`、`../shared/style.css`。不要依赖站点根路径或编造的预览地址映射工作区。
3. 分享入口文件而非目录，例如 `[阶段预览](review/index.html)` 或 `review/index.html`。
4. 每个预览文件不超过 64 MiB。站点可以包含多个文件，各资源分别加载；大体积内容先生成合适的代理片、缩略图或分段产物。
5. ES 模块、fetch、图片和 WASM 加载不要求本地静态服务器。`127.0.0.1` 地址不会指向已登记服务；应用后端按 Service Preview Skill 接入。

## 支持范围

| 需求 | 写法 |
|---|---|
| CSS / JS / ES 模块 | `<link>`、`<script src>`、import/import() 使用字面量相对路径 |
| 图片、音频、视频 | `<img src>`、img.src、new Image()、srcset、video/audio/source；按需加载 |
| 运行时数据 | 使用相对 URL 的 `fetch("data.json")` 或 XHR |
| 分数、偏好 | `localStorage`，预览提供同接口的持久化实现 |
| 页签临时状态 | `sessionStorage`，仅内存保存，重载清空 |
| HTTPS API / CDN | 绝对 https:/wss: URL，可访问网络 |
| WASM | fetch 相对路径的 .wasm，再用 WebAssembly.instantiate |

`localStorage` 按设备、工作区和入口文件目录隔离；同目录页面共享存储。键最多 1 KB、单值最多 128 KB、总量最多 400 KB，超限抛出 `QuotaExceededError`。预览信息面板可以清空；文件重命名/移动会失去原有存储关联。

## 不支持的用法

- IndexedDB、Cache API、cookie：沙箱中仍会报错。
- 嵌套 iframe、object、form action：被 CSP 阻止。
- 绝对工作区路径、file://、http://127.0.0.1：不能代替工作区资源路径。
- 相对 URL 的 `new Worker("w.js")`：不会重写，只使用内联或 blob worker。
- 非字面量 `import(variable)`：仅重写字面量模块路径。
- 任意本地后端 URL：Express、Flask、WS 应用需登记有限 loopback 路由并通过可信工具栏授权。
- 在沙箱中实现麦克风/屏幕采集或 PeerConnection：实时创作预览使用 Service Preview 的可信媒体路径；通用远程桌面和软件控制不能由静态页面权限绕过实现。

## 分享与排障

只链接预览支持的普通文件：HTML/HTM 入口、Markdown、png/jpg/gif/webp、mp4/webm，以及不含 NUL 的有效 UTF-8 文本。不链接目录，不编造部署域名；Workbench 在显示时解析入口。专有工程和仿真缓存不等于可直接预览格式，应先输出实际可查看的阶段产物。

- 空白或 localStorage 的 `SecurityError`：检查是否旧版本，或错误调用了 IndexedDB/cookie。
- 媒体不出现：检查文件存在及相对路径。
- 大型 JS/CSS 图长时间白屏：首屏前仍有资源内联开销，缩小或拆分模块图，让入口先显示内容。
- 运行时错误：从预览信息/诊断面板查看缺失资源和控制台事件，修复页面，不增加仅为绕过预览限制的脚本。
- 需要持续刷新任务进度、视口或应用状态：这属于过程服务，转读 `genehub-service-preview`，不能用静态截图冒充实时结果。
