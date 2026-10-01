---
name: genehub-preview
description: 编写、分享和诊断 GeneHub Asset Preview 里的预览。静态：H5/HTML5 游戏、站点、相册、看板、内容创作阶段产物，涉及 index.html、相对资源、localStorage、fetch、图片、WASM，以及预览空白、缓慢、SecurityError。实时：影视剪辑与合成、DCC 建模/动画/仿真、游戏引擎、数字人的创作过程预览，需要本地 HTTP/WS 服务、原生 WebRTC、可信媒体面板或操作回传；用户说“搭建预览”“可预览”时先落地一条能点开的入口 HTML 链接，不要只写架构。
---

# GeneHub 预览

预览打开用户点击的**工作区里的普通文件**。交付物就是聊天里一条可点的链接，不是架构说明。

## 先判断是静态还是实时

| 需求 | 读 |
|---|---|
| 阶段文件、相册、静态页、H5 游戏、看板；资源都是文件，不需要后端 | [static.md](references/static.md) |
| 需要本机后端、实时任务状态、麦克风、原生 WebRTC、引擎/数字人画面、操作回传 | [live-service.md](references/live-service.md) |

拿不准时先做静态入口，保证有东西能点开；只有静态确实不够，才按 live-service.md 登记服务。静态入口始终保留，
动态能力通过登记的服务和可信面板提供。

## 两种预览共同的规则

- 分享**入口文件**，不分享目录：`[阶段预览](review/index.html)` 或 `review/index.html`。路径相对工作区、
  使用正斜杠。
- 不写 `E:\…`、`file://`、`http://127.0.0.1`，不编造 `/assets/preview/…` 或部署域名；Workbench 在显示时
  解析入口。
- 页面用相对路径引用资源；不嵌入 GeneHub 专用加载器，不为静态资源启动 HTTP 服务器。
- 每个预览文件不超过 64 MiB。大体积内容先生成代理片、缩略图或分段产物。
- 可预览的文件类型：HTML/HTM 入口、Markdown、png/jpg/gif/webp、mp4/webm，以及不含 NUL 的有效 UTF-8 文本。
  专有工程和仿真缓存不是可直接预览的格式，先输出实际可查看的阶段产物。
- 区分阶段产物与实时画面、参考图案与实际内容、观看与操作、本机与跨网结果。静态截图不能冒充实时结果。

## 引用资料

按需读取，不必一次读完。实时服务相关的其余资料都在 [live-service.md](references/live-service.md) 的
“按需阅读”里列出。预览页面本身出了问题（空白、加载失败）而页面已接入联调时，可用 `genehub` 的客户端联调
参考现场诊断。
