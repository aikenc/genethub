# 登记服务与原生媒体 Preview

这份实现保留静态 Asset Preview，在用户授权后将 `/api/.../` 的有限 HTTP、流式 fetch 和 WebSocket 请求转给登记后端。音视频由可信 Workbench 面板建立原生 RTCPeerConnection，直接连接应用媒体后端；允许媒体中继时使用所属 Channel 的短期 TURN 凭证。官方 Fabric Relay 继续承载原有业务数据，不承担音视频转码。

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

## 接入实际数字人

应用适配为以下契约即可复用媒体基础设施：

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
