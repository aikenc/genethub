# 登记服务与原生媒体 Preview

这份实现保留静态 Asset Preview，在用户授权后将 `/api/.../` 的有限 HTTP、流式 fetch 和 WebSocket 请求转给登记后端。音视频由可信 Workbench 面板建立原生 RTCPeerConnection，直接连接应用媒体后端；允许媒体中继时使用所属 Channel 的短期 TURN 凭证。官方 Fabric Relay 继续承载原有业务数据，不承担音视频转码。

## Agent 引导

内置 [genehub-service-preview](../apps/daemon/builtin-skills/genehub-service-preview/SKILL.md) 提供随产品分发的任务入口，按需读取创作过程接入、启动与分享、媒体契约、数字人和 UE 参考。静态页面仍由 `genehub-html-preview` 引导。安装包中的 Skill 不包含 Node runner、Python 环境或模型权重；源码与启动前提见其 [启动参考](../apps/daemon/builtin-skills/genehub-service-preview/references/getting-started.md)。

UE 接入需要版本匹配的信令适配；当前可信媒体面板没有 Pixel Streaming 的键鼠/触摸/手柄输入协议，也没有内置 UE 适配器。远程观看、交互云游玩及特定 Editor/PIE 模式必须分别验证，详见 [UE 参考](../apps/daemon/builtin-skills/genehub-service-preview/references/unreal-engine.md)。

## 服务基础能力与前端现状

当前实现足以接入受控的一次应用预览，但还不是完整的创作服务管理层。

| 层次 | 已有实现 | 尚缺的通用能力 |
|---|---|---|
| 登记与访问 | 按规范化 HTML 入口定位运行，运行身份校验，独立 services 授权，有限 loopback 路由 | 授权范围内统一枚举服务、稳定服务身份与多次运行的关联 |
| 数据与媒体 | HTTP/流式响应/WS 的有限桥接，可信面板原生音视频，Channel ICE 与可选 TURN | 各影视/DCC/引擎的实际采集与操作适配、通用远程输入协议 |
| 运行生命周期 | 外置 runner 启动 1–8 个后端、初始就绪检查、任一退出撤销整次运行、正常停止回收 | daemon 统一启动/停止/重启、持续健康状态、持久托管、自动恢复及依赖编排 |
| 观察与管理 | 单入口服务名称/数据策略/授权按钮、媒体状态与 RTT；后端输出留在启动终端 | 服务日志和退出原因的统一查询、进度/产物/工程关联、服务状态事件和列表 UI |

代码依据：daemon 的 [service_preview.rs](../apps/daemon/src/dataplane/service_preview.rs) 当前只接受 `describe`、`connect`、`ice`，均要求已知工作区及入口；它不是全局服务管理 API。进程启动和登记写入由 [runner](../packages/service-preview/run.mjs) 完成。注册记录中的秘密也不能直接扫描后发给前端作为“服务列表”。

前端可见的入口有两种：

1. 打开已登记 HTML，在 [AssetPreviewPage](../packages/workbench/src/preview/AssetPreviewPage.tsx) 的可信工具栏看到服务名称、数据策略、“允许本次预览访问登记服务/暂停服务访问”；授权后显示音视频面板。“暂停”只暂停页面访问，媒体“停止”只停止该媒体会话，均不终止 runner。
2. “工具 → 全局 → 此电脑的后台进程”，以及会话菜单的“后台进程”和有进程时的会话数量标记。入口位于 [ToolsMenu](../packages/workbench/src/shell/ToolsMenu.tsx)，[ProcessesPanel](../packages/workbench/src/processes/ProcessesPanel.tsx) 展示所属会话、命令、PID/父 PID、运行时间及结束操作。它面向可归属于 Agent 会话的进程，不是已登记服务目录，也不是 OS 全部进程列表。

进程列表还有实际平台缺口：[processes.rs](../apps/daemon/src/processes.rs) 的枚举仅在 `cfg(unix)` 下执行 `ps`，`cfg(not(unix))` 返回 `None`，查询再转为空列表。当前 `wasm32-wasip2` 的 `target_family` 是 `wasm`，不具备 `unix` 配置，因此当前 WASM daemon 使用空枚举分支；原生 Windows 同样没有该枚举实现。界面显示“没有留下运行中的进程”不能作为这两种环境已无后台服务的证据。这是进程观察能力的缺口，不能靠新增 Skill 文字补齐。

若要成为内容工作者可依赖的通用服务层，建议先补“可发现、可找回、可停止”：在现有工作区和设备授权边界内提供脱敏列表与状态，再加运行控制/诊断、前端服务面板和实际应用适配。服务入口、运行状态、所属工程/会话、查看入口和停止对象必须明确；实现前不要把此建议当成已上线功能。常驻托管、自动恢复和远程输入则需要各自的生命周期及权限契约。

## 开始使用

需要 Node.js 22+，目标 daemon、host 与 Workbench 均更新到本功能对应版本。运行源码中的适配器：

```sh
npm --prefix packages/service-preview ci
node packages/service-preview/run.mjs --config examples/service-preview/application.json --daemon-root <目标Channel的实际数据目录>
```

然后在 GeneHub 打开 [示例入口](../examples/service-preview/index.html)，点击可信工具栏的“允许本次预览访问登记服务”，再操作页面中的 HTTP、流式进度和 WebSocket 按钮。不要为这个静态入口另起服务器。

媒体参考后端依赖 Python 3.10+：在独立虚拟环境安装 [requirements](../examples/service-preview/requirements.txt)，将 [媒体配置](../examples/service-preview/media-application.json) 中的 Python 命令改成该环境的解释器，再用相同 runner 启动。参考后端输出移动画面与测试音，不是数字人模型。可信面板提供连接、麦克风授权、实际直连/中继路径、RTT 和停止操作。

runner 运行在源机器，前台托管多个后端，逐一检查 readiness；任何后端退出都撤销整个运行。端口已被占用时拒绝启动。后端必须前台运行且遵守配置，runner 不是限制后端读写宿主文件的 OS 沙箱。停止 runner 会关闭连接并回收所启动进程；强制杀死 runner 后的陈旧登记需要源机器所有者确认进程已退出后清理。当前不提供自动恢复和永久托管。

## 访问边界与生命周期

- `services` 是独立能力；只有 `files` 的设备不能调用服务。已有显式窄授权不自动扩大。UI 授权只启用当前入口，页面拿不到 daemon Client 或私有登记凭证。
- 登记保存在目标 daemon 私有数据目录，以规范化入口路径关联。每次运行有新 runId 和私钥材料，daemon 与 runner 双向校验；端口被复用不构成旧运行身份。私有记录不得放进工作区或日志。
- 服务只能访问声明的 loopback 路由，禁止路径逃逸和自动跳转到另一地址。请求不转发 cookie、Authorization 或任意自定义头，不自动重试写操作。
- HTTP 请求体最多 8 MiB；桥帧最多 256 KiB；响应按消费进度传送。请求取消、暂停服务、切换页面会释放操作。单个桥连接最长一小时，慢消费者会被限时关闭。
- WebSocket 支持文本和 ArrayBuffer、有界发送缓冲、正常关闭；不承诺 Blob send、子协议、完整浏览器 WebSocket API 兼容。后端 WS 不等于媒体轨道。
- `dataPolicy: "direct-only"` 在 daemon 拒绝本服务的 Fabric 数据路径；`auto` 使用现有数据选路。该字段只约束此服务，不改变聊天、终端等其他功能的连接策略。
- 媒体默认只给 STUN，不使用 TURN；勾选“允许媒体中继”才申请短期凭证。数据与媒体是独立路径，DataChannel 失败不会自动把媒体塞进 Fabric。
- 麦克风只能由用户点击可信面板启用。iframe 继续是 opaque sandbox，不增加 `allow-same-origin`，也不向它开放设备权限。停止、卸载、建连失败及持续断连会释放采集轨道。

## 接入影视、DCC、引擎等创作软件的实时媒体

内容工作者的过程预览包括阶段产物、任务状态、实时画面和操作回传。影视剪辑/合成、DCC 建模/材质/动画/仿真、游戏引擎是主要场景，数字人制作与实时驱动包含在这些流程中。已有产物优先使用静态预览，应用状态使用登记 HTTP/WS，实时媒体才接入以下契约。软件连接器、状态采集、画面采集和控制回传仍由实际应用适配，不能把这些软件类别宣传为内置兼容清单。通用工作流见 [创作过程接入](../apps/daemon/builtin-skills/genehub-service-preview/references/creative-workflows.md)。

应用适配为以下契约可复用媒体基础设施：

```text
POST offerPath  {type:"offer", sdp, iceServers}
             → {type:"answer", sdp, sessionId?}
POST stopPath   {sessionId}
             → 释放这次媒体/模型会话
```

后端必须将接收的 ICE 配置用于它自己的 PeerConnection。通过信令桥拿到 answer 不意味着媒体可达；只有浏览器收到真实媒体、验证选中候选对后才能宣告成功。已有 LiveTalking 等应用若仅支持自己的 `/offer` 格式，可加薄适配层；不依赖替换所有浏览器 API。

本版本麦克风支持 `webrtc` 或 `none`。如果现有数字人把麦克风 PCM 通过独立 WebSocket 送给语音流水线，仍需该应用的音频输入适配，不能直接宣称兼容。嵌套 iframe、cookie/OAuth 导航、任意已有站点无改动接入也不在本版本契约内。

## Channel 与已有腾讯云 Relay

STUN/TURN 与 Fabric Relay 是独立监听服务，可以共用腾讯云机器；普通 Web/Relay 发布不重启 ICE 实例。域名通过显式环境配置选择，不从页面 Host 猜测，不改写 DNS。

| Channel | Control 环境前缀 | 默认 UDP 监听 | 可选 TURN relay UDP 范围 |
|---|---|---:|---:|
| stable | `HUB_` | 3478 | 49160–49259 |
| beta | `HUB_BETA_` | 3479 | 49260–49359 |
| dev | `HUB_DEV_` | 3480 | 49360–49459 |

Cloud 仓 `deploy/rtc/render.mjs` 生成独立 coturn 配置和 systemd unit 候选；README 说明安装、权限、网络规则和回滚步骤。`RTC_HOSTNAME` 必须是运维已经确认的域名；上述端口是候选默认值，不表示公网已经开放。首先部署 STUN-only。TURN 需要显式开启、独立签发 secret、带宽/配额与 UDP 范围，再验证真实 allocation。

Control 提供 `GET /api/rtc/config` 的公开 STUN 配置；经配对机器身份认证的 `POST /api/rtc/credentials` 签发最长 600 秒的标准 TURN REST 密码。凭证不会进入静态页面，秘密不会进入公开配置。现有 allocation 不一定因密码过期立即消失，不能将短期凭证宣传为即时强制撤销。

自托管 daemon 可用私有数据目录中的 `rtc.json` 配置 STUN；否则从配对 Channel 查询。配置不可达时保留 host 候选，不偷偷替换成 Google/Cloudflare。当前候选只提供 UDP STUN/TURN，不包含 TURN/TLS 443，也不保证企业网可达。

加密信令与业务继续使用现有 Data Plane；本功能不新增云端明文媒体处理，但也不修复现有 Control 信任模型中的 hosted secret 问题。不能因此扩大为“整个平台主动作恶时也不可读”的承诺。

## 验收与发布边界

已建立三类真实验证入口（通过 testctl 执行）：

- `specialty.preview.registered-service-http-ws`：真实 runner、WASM daemon、公开 Client，验证二进制 HTTP、SSE、WS 与登记回收。
- `specialty.preview.channel-ice-credentials`：真实 Control HTTP 注册流程、匿名拒绝、标准密码算法与有效期、请求大小限制。
- `specialty.preview.native-browser-media`：Chromium 与真实 aiortc 参考后端收发媒体，并挂载实际 AssetPreviewPage 验证工具栏授权、沙箱 HTTP/WS、媒体播放与停止。

浏览器用例需要 Playwright Chromium；设置 `GENEHUB_PREVIEW_MEDIA_PYTHON` 指向已安装参考依赖的解释器，并让 `PLAYWRIGHT_BROWSERS_PATH` 指向可用浏览器缓存。没有依赖应报告 blocked。

这些验证不等于公网 coturn 已部署，也不等于四个网络、Android/iOS 或实际数字人模型已验收。实网记录至少包括版本、查看端/源端网络、ICE 候选类型、失败阶段、首帧时间、持续播放与重连、CPU/带宽、关闭后的会话回收；禁止收集原始凭证和用户音视频。先在同一局域网通过，再测手机蜂窝与企业网。仅直连模式下跨网失败允许且必须明确呈现。
