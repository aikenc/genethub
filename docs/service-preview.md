# 登记服务与原生媒体 Preview

这份实现保留静态 Asset Preview，在用户授权后将 `/api/.../` 的有限 HTTP、流式 fetch 和 WebSocket 请求转给登记后端。音视频由可信 Workbench 面板建立原生 RTCPeerConnection，直接连接应用媒体后端；允许媒体中继时使用所属 Channel 的短期 TURN 凭证。官方 Fabric Relay 继续承载原有业务数据，不承担音视频转码。

## Agent 引导

内置 [genehub-service-preview](../apps/daemon/builtin-skills/genehub-service-preview/SKILL.md) 提供随产品分发的任务入口，按需读取创作过程接入、启动与分享、媒体契约、数字人和 UE 参考。静态页面仍由 `genehub-html-preview` 引导。安装包中的 Skill 携带可选示例源码，不包含依赖环境或模型权重；启动前提见其 [启动参考](../apps/daemon/builtin-skills/genehub-service-preview/references/getting-started.md)。

UE 接入需要版本匹配的信令适配；当前可信媒体面板没有 Pixel Streaming 的键鼠/触摸/手柄输入协议，也没有内置 UE 适配器。远程观看、交互云游玩及特定 Editor/PIE 模式必须分别验证，详见 [UE 参考](../apps/daemon/builtin-skills/genehub-service-preview/references/unreal-engine.md)。

## 服务基础能力与前端

工作区的后台运行页面复用 process 协议与进程树。显式登记的应用附带名称、runId、入口和可达状态，提供“打开预览”；支持认证 shutdown 的应用可请求停止。列表按权限过滤，不输出私有登记内容。进程归属记录 Session 来源，Workspace 用于组织；无法确认发起会话时显示外部程序登记。

普通进程枚举通过现有 Host 进程接口执行 OS 查询，WASM guest 不再因自身不是 Unix 而返回空；Windows 使用系统进程查询。终止只作用于已验证的受管子树，不对整个 Agent 进程组盲目发信号。认证服务的停止按 runId 请求程序自身清理，不通过登记中的 PID 获得终止权。

该能力不提供永久托管、自动恢复或软件接管。不同平台与真实手机网络需分别验收，不能把源码支持写成已完成实机验收。

## 开始使用

GeneHub 本体不依赖 Node.js/Python。应用可直接实现[语言无关登记与访问协议](../apps/daemon/builtin-skills/genehub-service-preview/references/registration-contract.md)，也可将内置 Skill 携带的 [Python 示例](../apps/daemon/builtin-skills/genehub-service-preview/assets/python-adapter/app.py) 或 [Node 多后端示例](../apps/daemon/builtin-skills/genehub-service-preview/assets/node-adapter/run.mjs) 复制到用户工作区改写。示例依赖只安装在外部项目，不需要 GeneHub 源码环境。

完整步骤见[启动与手机预览](../apps/daemon/builtin-skills/genehub-service-preview/references/getting-started.md)。Workspace 后台运行列表将显式登记关联到进程树，显示服务入口。停止应用通过认证运行身份发出 shutdown；关闭预览只清理访问。重新启动后用“重新检查服务”发现新的 runId。

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
