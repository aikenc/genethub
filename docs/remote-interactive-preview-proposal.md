# 重型软件的远程观看、操作与游玩提案

> 历史设计与验收快照：实现已进入 main（`baae72ae`），下文状态和源码基线保留原评审时点，不代表完整平台验收或部署。当前接入合同见[应用协议](interactive-preview-service-protocol.md)，完整连接权限以[产品安全模型](security-model.md)为准；下文早期 services/Capability 分级描述不再作为当前授权要求。

状态：**已有未合入实现，正在复查；尚未通过完整平台验收、未部署。** 日期：2026-10-29。工作槽位：`dev-4`。当前实现与验证限制见 §12，首轮设计背景仍保留。

适用范围：用户自己的 Windows/macOS 机器运行 Blender、UE 编辑器或普通 Demo，从 GeneHub 浏览器/桌面工作台观看并按已启用的源端策略操作。Linux、Pixel Streaming 后置。默认一个源端选定显示器、一个观看者、H.264/Opus、键鼠；不要求用户上传工程到云端。

源码基线：`genethub` **c6ac5610e5874d504fbed40a6df80a747b9e78b0**；`genethub-cloud` **cc0e6f0667a7d4082f352f349054c219e94bdfb5**。本次分别快进 47/3 个提交，HEAD 与本次 fetch 的 origin/main 相同，无冲突；原提案已保留。这是设计同步时的基线；其后的构建和运行证据见 §12，不能据此推断 Beta 已部署。外部原生组件调研仍为 2026-10-28 的固定源码快照，见 §3.4。

## 1. 建议与用户体验

**采用“现有 Service Preview 的小幅扩展 + 内置可编辑 H5 资源包 + 独立 Capture App”。** 复用现有登记、services 权限、HTTP/WS 桥、相对文件预览和 ICE/TURN；不新增 service.session、通用 broker、全局远控权限枚举或独立 npm SDK。具体协议、资源位置与文件改动见[接入设计](interactive-preview-service-protocol.md)。

例如 Agent 在 Windows 做完 Blender 模型，发一个真实 `index.html`。用户用 Mac 工作台打开，启用本次登记服务，H5 里立即查看连续画面；源端已开启控制时，在可信工具栏允许当前页面接管，再操作模型，交还后 Agent 继续。Demo 也走同一显示器串流路径。Agent 想加入进度、改变播放器布局或键位，直接改项目里的 H5；默认资源随产品提供，用户无需编写客户端。

源端首次安装和系统授权由独立 Capture App 处理，用户选择显示器并显式开启共享/控制策略。无人值守使用依赖预先授权与配置过的图形会话；不要求每次在源机器点击，也不绕过首次 OS 权限。关闭观看只释放媒体与输入，不结束 Blender/UE 或 Agent。

| 用户目的 | 可观察结果 |
| --- | --- |
| 看工作进度 | 实例当前画面和声音持续更新；静止场景与故障冻结正确区分 |
| 检查与修改成果 | Blender 旋转/平移/选择、组合键、文本、撤销实际生效；失焦不粘键 |
| 体验 Demo | 指定普通 Demo 中完成移动、转向、交互与声音；实际直连/中继路径可追溯 |
| 自行改进工具 | H5 副本改布局或输入映射后继续使用同一 Capture；可切回默认资源 |

手机首期保证观看；触控、相对鼠标与键盘能力分别验收，不以“手机看见视频”推断完整游戏操作。可信外壳保留源机器、服务状态、交还/停止；H5 不覆盖这些出口。

## 2. 更新后的源码事实与删减依据

| 证据 | 当前已有能力 | 本期增量 |
| --- | --- | --- |
| [serviceClient.ts](../packages/workbench/src/preview/serviceClient.ts) | discover、fetch、websocket、ice、close，runId 与路径检查 | 使用新的可选 media 字段，不另造传输 SDK |
| [serviceBridge.ts](../packages/workbench/src/preview/serviceBridge.ts) | H5 的 fetch('/api/...')、登记 WebSocket、MessagePort 与背压 | 小幅补 describe/ice、当前控制 WS 开关和定向关闭 |
| [AssetPreviewPage.tsx](../packages/workbench/src/preview/AssetPreviewPage.tsx) | 现有服务 enable、opaque HTML、相对资源与连接变化处理 | H5 媒体模式、必要 sandbox 能力、版本变化失效和外壳操作 |
| [ServiceMediaPanel.tsx](../packages/workbench/src/preview/ServiceMediaPanel.tsx) | 可信面板标准 RTC、offer、stop、可选 TURN | 旧服务保持，默认 H5 参考其现有媒体逻辑 |
| [service_preview.rs（daemon）](../apps/daemon/src/dataplane/service_preview.rs) | 私有登记、v1 双向 HMAC、HTTP/WS、ICE、直接策略、取消与连接期限 | 新媒体字段校验及必要的清理修补；不接管采集业务 |
| [service_preview.rs（类型）](../packages/proto/src/service_preview.rs) | 描述符 v1、media.offerPath/stopPath/microphone | 可选 HTML 客户端元数据和应用消息类型 |
| [authz.rs](../apps/daemon/src/authz.rs)、[endpoint.rs](../apps/daemon/src/dataplane/endpoint.rs) | services、PreviewShare 限定、设备本地撤销与 handler 取消 | 不新增全局权限；真实 App 断连回收另验 |
| [Channel RTC](../../genethub-cloud/server/src/http/rtc.ts)、[部署说明](../../genethub-cloud/deploy/rtc/README.md) | 现有 STUN、短期 TURN 和 UDP coturn 配置 | 继续使用，不新增云端桌面、转码或信令服务 |

网络主干 `1717c38a` 已移除 ACK-paced send windows 与 UplinkPace/SendPace；`a3655530` 删除兼容回退；`c6ac5610` 保留本地控制优先并限制 bulk lookahead。业务写完成可只是 journal 接收，背压依靠有界队列/await socket write。**resume ACK/grant、Preview 本地 0x02、iframe 消费 ACK 仍存在**，不能把“移除 ACK pacing”写成“无 ACK”。远控直接使用现有完整 Client/握手，不复制旧拨号实现、不加一套网络恢复。

服务预览的核心 API 在这次同步中没有改动；AssetPreviewPage 只补 `dial().bulk`。因此简化主要来自重新识别现有能力，而非误以为网络重构已经实现桌面采集。WebRTC 数据面已通仍不能替代源端硬编码、实际 OS 输入及释放。

## 3. 源端技术路线

### 3.1 独立 Capture App

Capture 是独立安装/签名/更新的图形会话 App，拥有共享 UI、系统权限、采集/编码/音频、应用媒体 PC、会话和输入 watchdog。它实现现有 Preview 登记与本地桥，服务于真实 workspace 入口；不把原生采集库链接进 genehub-host，不修改 WIT，不新增公网账号/配对系统。

优先固定 Moonlight-Web 的独立原生模块，以窄内部接口接入现成媒体栈；不整套导入其产品，也不从零重写编码器。Sunshine 用作同场景对照。两端实现可以替换，前提是遵守相同 remote-desktop 应用合同；不预建原生插件框架。

### 3.2 UE 和其他软件

第一版捕获选定显示器，Blender、UE 编辑器、普通游戏共享这条路径。专用 UE Pixel Streaming/offerer/输入适配后置；不保证反作弊、DRM、安全桌面、登录屏幕或任意现成网页无改动嵌入。不承诺只采单软件声音或窗口隔离。

### 3.3 平台边界

Windows 的 WGC/DXGI、硬编码和输入，macOS 的 ScreenCaptureKit/VideoToolbox 和系统输入权限分别验收。初始硬件是 Windows 独显工作站和 Apple Silicon Mac；未测 Intel Mac/其他 GPU 不自动继承资格。锁屏、休眠、注销、WSL 与无桌面 GPU 服务器明确报告不可用/需恢复，不绕过图形会话授权。

### 3.4 开源实现的源码结论

这里比较的是接入 GeneHub 的工程成本，不按项目 README 的 FPS 或延迟宣传排名。2026-10-28 从上游固定 SHA 获取文本源码，核对构建入口、采集/编码回调、浏览器播放、输入、反馈和依赖；没有运行上游安装器或执行其代码。固定版本的可分离结构能支持选型判断，实际 Windows/Mac 的流畅度和可用性仍由下一节验证。

| 候选 | 固定源码版本 | 对本产品的判断 |
| --- | --- | --- |
| [Moonlight-Web](https://github.com/linckosz/moonlight-web/tree/ccd2f0566336fa78674fab66d5250725b12a98f5) | `ccd2f0566336fa78674fab66d5250725b12a98f5` | 优先复用其独立原生模块，外层网络/播放器/账号不整套导入 |
| [Sunshine](https://github.com/LizardByte/Sunshine/tree/d7e5fe00701539a5be4a0304239730e1dfec4cf9) | `d7e5fe00701539a5be4a0304239730e1dfec4cf9` | GPU 共载、采集和输入行为的参照；不作为浏览器产品底座 |
| [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream/tree/922c2e155d1d76b84932c42491f7c973509bfe29) | `922c2e155d1d76b84932c42491f7c973509bfe29` | 标准 RTP 与 Rust 桥接的参考；仍依赖另一台/同机 Sunshine，不优先整合 |
| [scap](https://github.com/CapSoftware/scap/tree/c03f15a4631f40cd8d2e36807befb83b314cfeb7) | `c03f15a4631f40cd8d2e36807befb83b314cfeb7` | 能查询窗口等目标，但所查 Windows API 输出 CPU 原始帧，不作为默认高性能视频链路 |
| [enigo](https://github.com/enigo-rs/enigo/tree/a88d9b7e2cec7043ab5f03e754500a091ea928d1) | `a88d9b7e2cec7043ab5f03e754500a091ea928d1` | 普通桌面输入的候选/参考；相对鼠标与多屏不能按默认配置直接用于游戏 |

**Moonlight-Web 最有价值的是库边界，不能把整个仓库当成一个小 SDK。** `backend/native-host/CMakeLists.txt:16` 构建 `mw-native-host STATIC`；公开 `NativeHost::probe/createSession`、编码帧/Opus 回调、`Session::sendInput/requestKeyframe/setTargetBitrate/reportLink`。模块内部不依赖 Qt 或 GameStream，外层 `NativeMediaEngine` 才是 Qt 适配。Windows 有 DXGI/WGC 和多种硬编码路径，Mac 有 ScreenCaptureKit → VideoToolbox 和 CGEvent。可以保留 GPU surface 在原生编码链路中，只把压缩后的帧交给 GeneHub 媒体端，无需自建 GameStream 协议。[原生构建入口](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/backend/native-host/CMakeLists.txt)、[公开 API](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/backend/native-host/include/mw/native/NativeHost.h)

提取仍有实际成本。按 `backend/native-host/src` 下 `.c/.cpp/.h/.hpp/.m/.mm` 文本统计为 274 个文件、89,596 行，含各平台和多种编码实现，不含外部子模块、工具与测试；这不是预计要修改的行数，也不是成熟度指标。其模块版本写为 `0.1.0-dev`，不能假设已有稳定独立 SDK 发布。需固定源码、导入必要子模块版本，提供自己的窄接口与补丁清单，不能运行整仓的自动更新器。

有四个直接影响接入的细节：

1. **只抽原生模块不会自带失联控制。** `backend/src/streaming/NativeMediaEngine.cpp:210` 在 Qt 层创建 `InputWatchdog`；`NativeHost.h:468` 还明确输入门状态回调当前只有 Windows 实现。GeneHub 必须在辅助程序中实现独立的租约与注入状态释放，两平台同验；停止原生 session 时释放输入不等于“继续观看但交还控制”已经实现。
2. **模块的主要目标是显示器。** `SessionConfig.displayId` 和公开创建路径围绕显示器选取，不能把它描述为现成的应用窗口隔离库。首期明确选显示器；独立窗口串流以后增加，不把视频裁剪宣传为输入隔离。
3. **现成产品的默认策略不能照搬。** `SessionConfig` 的 `allowElevatedInput` 默认 true；还包含静音、显示模式匹配、虚拟显示器等能力。GeneHub 的包装层必须显式关闭提权输入/安全注意序列、虚拟显示器和改分辨率；权限探测改成无提示检查，只有用户操作才请求系统权限。启用观看不应无意申请系统控制权限。
4. **模块无 Qt 不表示许可证为宽松许可。** 该模块自己的 `LICENSE.md` 明确当前是 GPL-3.0-or-later；“作者可以重新许可”和“下游已获其他许可”是两回事。GeneHub 工作台自身声明 AGPL-3.0-or-later，不能仅因 GPL 字样就判定不能用，也不能把来源/依赖义务省略。实施时固定所取模块、子模块及 notices，分发审查基于实际制品。[模块许可证](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/backend/native-host/LICENSE.md)、[GeneHub 工作台声明](../packages/workbench/package.json)

**需要修正上一轮对浏览器路径的概括：Moonlight-Web 不只有 WebCodecs。** 它的 `frontend/js/api/WebRtcMedia.js` 与 `MediaTrackRelay.cpp` 已有 H.264/Opus 标准 RTP、浏览器 `ontrack → video/audio`，可以作为我们标准媒体路径的参考。另一模式用视频 DataChannel + WebCodecs，是不同实现，不能混为一谈。但标准 RTP 前端在 `WebRtcMedia.js:478` 显式丢弃 relay ICE candidate，信令也采用后端 offer + WS/trickle；直接换到 GeneHub 的 Channel TURN 和当前浏览器 offer 接口不会天然工作。采用原生模块并保留 GeneHub 自有信令，比连同它的 rendezvous、UPnP、配对、域名及更新链一起搬入更符合现有架构。[标准媒体前端](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/frontend/js/api/WebRtcMedia.js)、[RTP 发送端](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/backend/src/streaming/MediaTrackRelay.cpp)、[Qt 适配与 watchdog](https://github.com/linckosz/moonlight-web/blob/ccd2f0566336fa78674fab66d5250725b12a98f5/backend/src/streaming/NativeMediaEngine.cpp)

**Sunshine + Rust 桥接适合对照样机，不适合作为默认产品形态。** `moonlight-web-stream` 的 `video.rs` 把 GameStream 编码帧重新打包为标准 RTP，所查发送路径不需要视频解码再编码，不能凭空把桥接成本说成多一次转码。代价是安装并维护 Sunshine 与桥接服务、两套会话/配对/配置，以及额外的本机媒体接收路径。更具体地，固定版本的 `video.rs:152` 和 `audio.rs:75` 使用无界帧队列；`video.rs:352–355` 的 REMB 处理分支仍是 TODO。源码能证明这些路径存在，但不能据此断言线上发生过内存泄漏或所有弱网都失败。它们意味着接入前还要补有界队列和反馈闭环，不能直接当已验证的云游玩成品。[视频发送与反馈](https://github.com/MrCreativ3001/moonlight-web-stream/blob/922c2e155d1d76b84932c42491f7c973509bfe29/src/api/stream/webrtc/video.rs)、[音频队列](https://github.com/MrCreativ3001/moonlight-web-stream/blob/922c2e155d1d76b84932c42491f7c973509bfe29/src/api/stream/webrtc/audio.rs)

Sunshine 仍值得用于同机相同场景的性能基线；版本不能泛指 master。所查新版本的 Mac 键鼠通过 libvirtualhid/CoreGraphics，Mac 虚拟手柄另需安装并许可的 Virtual HID Broker；Windows 的驱动输入也有可选 broker 与回退策略。不能把这些依赖或“手柄支持”一并算成无需安装、三平台相同的能力。首期键鼠体验不以安装虚拟 HID 驱动为前提。[固定版本的安装/输入说明](https://github.com/LizardByte/Sunshine/blob/d7e5fe00701539a5be4a0304239730e1dfec4cf9/docs/getting_started.md)

**`scap + enigo + WebRTC` 也不是天然省事。** 所查 scap Windows 路径调用 `frame.buffer()` 并 `to_vec()` 输出原始图像，公共帧结构主要是 `Vec<u8>`，没有在该接口保留可直送硬编码器的 GPU surface。1080p60 BGRA 的单次全帧搬运量约 498 MB/s，4K60 约 1.99 GB/s（宽 × 高 × 4 × fps，未计其他拷贝/转换）；这只是数据量计算，不是性能跑分。适合作为功能探针，不能按“Rust + 跨平台”推断满足 UE GPU 共载。[Windows 帧路径](https://github.com/CapSoftware/scap/blob/c03f15a4631f40cd8d2e36807befb83b314cfeb7/src/capturer/engine/win/mod.rs)、[帧结构](https://github.com/CapSoftware/scap/blob/c03f15a4631f40cd8d2e36807befb83b314cfeb7/src/frame/video.rs)

enigo 则需要区分鼠标模式：所查 Windows 默认配置把 Rel 转成读取当前位置再发送 Abs，多屏绝对映射附近还有 `MOUSEEVENTF_VIRTUALDESK` 待办。普通 DCC 可以验证使用，FPS 不能只见到 `Coordinate::Rel` 就算支持；其 drop 释放按键也不替代进程仍运行时的远控 watchdog。[Windows 输入实现](https://github.com/enigo-rs/enigo/blob/a88d9b7e2cec7043ab5f03e754500a091ea928d1/src/win/win_impl.rs)、[默认配置](https://github.com/enigo-rs/enigo/blob/a88d9b7e2cec7043ab5f03e754500a091ea928d1/src/lib.rs)

RustDesk 可参考系统权限、采集和输入实现，但整套远程桌面协议、配对和 UI 与我们已有能力重叠；Linux 为主的 Selkies、Wolf 和 UE 专用路径不再作为本轮主线。GStreamer / libwebrtc 保留为媒体传输层的替代，不为这次选型同时引入另一个完整产品。

### 3.5 推荐复用边界与停止条件

推荐的第一条实现验证路径如下；这是组件选型，不是已经完成的原型：

```text
GeneHub H5 资源包：原生 video/audio + 输入 DataChannel；复用现有 Preview 服务授权
                  ↕ 标准 WebRTC；ICE/TURN 沿用 Channel
独立 Capture App（可含媒体 worker）
  ├─ Rust：媒体 PC、RTP/RTCP 接入、有界发送、控制许可与 watchdog
  └─ 窄 C ABI → mw-native-host 固定版本 C++ 静态库
                 Windows：DXGI/WGC → GPU 硬编码；WASAPI/Opus；键鼠
                 Mac：ScreenCaptureKit → VideoToolbox；音频/Opus；键鼠
daemon/guest：现有 service.preview 登记、鉴权、HTTP/WS 及取消 → Capture App
```

先尝试在 Capture App 中复用现有 webrtc-rs **库依赖**，建立独立应用媒体 PC，不复用 `genehub-data-v4` 对象或扩展现有 DataChannel-only WIT。App 内部 C ABI 只暴露 `probe/start/stop/send_input/request_keyframe/set_bitrate/report_link` 等原生操作，隐藏第三方配置结构；它不作为 daemon IPC。C++ 库只链接到 Capture App/其 worker，daemon 和常驻 `genehub-host` 不依赖采集库。

原生帧回调中的指针只在回调期间有效，Rust 端跨异步发送必须在返回前复制**压缩后的字节**到有界队列，不能保留裸指针或把整张 GPU 原始帧送过 guest/IPC。队列满时选择停止接受当前依赖链、丢弃过期内容并恢复到关键帧，不能随意丢一个参考帧后继续发送依赖它的帧。音频另设时限，不能等视频队列清空才发。RTP 时钟、关键帧、NACK、PLI 和码率反馈按真实编码参数处理。

**现有 Rust RTC 库不是已完成的游戏媒体引擎。** 本槽位依赖 webrtc-rs 0.17.2，具备编码样本/RTP 写入及 NACK、RTCP、TWCC 相关代码；默认 interceptor 注册不能证明已经把浏览器反馈连到外部硬编码器，也不能证明 pacing/拥塞控制达标。必须把反馈变成原生库的 bitrate/keyframe/link 调整并测队列。若满足弱网门槛需要从零实现完整拥塞控制，则停止这条媒体发送实现，改用有完整反馈与 pacing 方案的成熟媒体栈；保持采集库和产品协议不动，不把“已有 RTC”当作必须继续维护自研算法的理由。[0.17.2 默认 interceptor](https://docs.rs/crate/webrtc/0.17.2/source/src/api/interceptor_registry/mod.rs)、[编码样本发送](https://docs.rs/crate/webrtc/0.17.2/source/src/track/track_local/track_local_static_sample.rs)

| 要复用 | GeneHub 要写 | 首期不带入 |
| --- | --- | --- |
| 原生采集、GPU 编码、音频/Opus、已实现的键鼠映射 | 窄封装、受认证 IPC、标准媒体接入、有界缓冲、反馈连接 | Moonlight-Web 的网页、配对、rendezvous、UPnP、自动更新 |
| 编码器关键帧/码率接口、阶段时间戳、显示器坐标 | 默认 H5 播放/输入、遥测、目标代次与图形会话检查 | 视频 DataChannel、自定义 codec、WebGPU/WebCodecs 播放器 |
| 各 OS 的具体采集与注入经验 | 源端共享/控制策略、跨平台 watchdog、Agent 静止协调 | 安全桌面、驱动安装、虚拟显示器、修改桌面分辨率 |

M0 不是“先搭一堆选项再看”。只推进这一条主线，并设置明确出口：

1. **分离验证**：Windows 和 Apple Silicon Mac 上，原生模块能在无 Qt、无 GameStream、无公网服务的辅助程序中独立构建、签名运行；所有必要子模块固定到 gitlink SHA，并补齐 shader 等非文本资源。只取必要功能，但不为缩代码量立即重写其编码核心。
2. **媒体验证**：压缩帧进入标准 RTP 后，现有工作台浏览器和桌面 WebView 都能播放；1080p30 的 Blender 检查先验，1080p60 Demo 另验。TURN 的实际 relay pair、收敛/失败行为须可测。不能以自带播放器成功代替 GeneHub 集成。
3. **输入验证**：Mac 与 Windows 都覆盖组合键、中键、文本、相对鼠标、失焦/断连释放；无系统输入权时仍可观看；证明交还控制不必停视频。无需手柄、UAC 或第三方驱动才能通过。
4. **成本验证**：记录辅助程序构建依赖/安装体积、GPU 共载开销、队列和反馈行为，与同机 Sunshine 基线比较。上游原生模块源码存在不等于已在 GeneHub 制品验证，CI 定义也不等于实机通过。

若抽取需要把 Qt、配对平台或大量第三方产品策略拖入辅助程序，或 Mac/Windows 基本链路必须重做原生模块内部核心，停止扩大 fork。届时采用相同窄接口，分别实现 ScreenCaptureKit/VideoToolbox 和 WGC/硬编码接口的具体后端，使用现成 SDK/库，参考上游的输入与故障处理；仍不自己写编解码、ICE/DTLS/SRTP 或完整拥塞控制。这个回退是组件级替换，不是另做一个远程桌面平台。

**整体交付包含独立原生 App，不等于必须更新 GeneHub 原生基座。** Capture App 的安装、系统权限、签名和更新独立交付；daemon 若只做现有 guest/Web 服务预览的小幅扩展，可以按兼容门走 Live，无需为编码器修改 WIT 或重装 host。首期只做 Windows/macOS App，Linux 包装后置。

Capture App 拥有自己的媒体和控制领域状态，不复制 GeneHub 会话/Agent 业务内核。源端预检由 App 检查自身权限、制品/版本、图形会话、目标、实际编码器与音频，区分可观看和可控制；请求权限的动作与只读预检分开。

## 4. 最小模块结构与资源位置

```text
Workbench 可信外壳：沿用 enable，补媒体中继/接管/交还/停止
  └─ workspace/preview/remote/index.html + client.js/input.js/style.css
       ├─ 现有 fetch/WS + 小幅 describe/ice API → service.preview → Capture App
       └─ 原生 WebRTC 音视频与输入 ↔ Capture App（可选 Channel TURN）
```

默认 H5 的权威资源放在 `apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/`，经现有 Skill 分发并复制到 workspace。**浏览器“SDK”收敛为该目录的 client.js/input.js 薄封装**，只用标准 API 和少量预览宿主能力，不新增 packages/interactive-preview-sdk、npm 发布链或 Workbench 源码依赖。

平台默认资源保留，用户副本只归项目；Agent 可以改 HTML/JS/CSS、输入映射和应用状态展示。源端可以改 profile 或构建协议兼容 App。H5 修改无需重装 GeneHub；原生采集变化依然要独立构建、安装和校验代码签名身份，但不应把每次正常更新设计成重新授予 OS 权限，不能宣传为纯网页更新。无人值守和首次授权的具体交付约束见 5.2。

## 5. 权限与应用协议

### 5.1 保持现有粗粒度权限

沿用 services，files 不代替它，PreviewShare 不开放服务。Capture 默认不共享、不控制；用户在源端显式开启指定显示器及控制策略，普通远端 API 不能放开这些开关。本页面的 enable/接管由工作台外壳限制，真实注入由 Capture 的会话和租约决定。

需要明确简化的代价：共享开启后，拥有 services 且能访问入口的可信客户端可以申请观看；控制开启后可以申请接管。**本期没有设备级“只看/可控”的新增授权档位**，不能把按钮当成隔离其他原生客户端的权限门。共享前必须说明这个现有 services 服务范围；如确需按设备分权，再针对服务端鉴权缺口设计，不提前造完整委托体系。

App 不信客户端自报 principal/scopes。初期只需区分已认证本地桥与 App 自己的会话，不传递账号身份；现有 v1 HMAC 即可沿用。账号/登记 secret 不进入 H5；获授权 H5 接触本次画面、SDP 和短期 TURN 配置，这与任意用户代码可信服务模型一致，不保证脚本无法外传画面。

### 5.2 首次配置与无人值守是交付条件（2026-10-29 用户补充）

**用户后续澄清说的是“继承已有权限”**：当前优先问题是新版本/采集组件沿用已经授予的系统权限，不是再增加首次授权向导。上一轮将问题主要展开为集成配置，偏离了这次澄清；下述首次配置仅用于确实从未授予的权限，不应成为已有授权用户的必经步骤。先核对实际权限持有者、代码身份和启动归属，再选择沿用该 App 的兼容更新或内置 helper。不能未经核实就假定权限已经授予 GeneHub 主 App，也不能把跨独立 App 的 IPC 调用称为权限继承。

正常代码更新应保持与原授权记录兼容的 designated requirement，原生库或可执行文件内容变化本身不等于必须重新授权。当前 unsigned 开发包身份漂移属于打包/更新路径待修正问题；不继续让用户为每次构建反复授权。已有 ad-hoc 身份在产物被替换后能否继续满足原授权，仍需实际代码身份与 OS 验证，不能靠更改 Bundle ID、伪造签名或操作 TCC 数据库恢复。

用户的机器可能在办公室，Agent 在其中运行 Blender，用户只带手机或另一台电脑。当前优先保证：已有授权机器可以由已授权 Agent 用显式 --share/--allow-control 按需启动；兼容更新不丢权限；异常登记不能迫使用户回到现场手工处理。持久选择、登录启动和新安装引导是可选增强，不应扩成继承已有授权的前置条件。缺失权限必须准确报告，不用重复弹窗或新常驻框架代替身份兼容修复。旧 Mac 包是 linker ad-hoc 开发包；本轮已新增稳定签名和兼容更新路径，实际权限保留仍须两个不同可执行文件版本的实机升级验收。

2026-10-30 用户补充：本机管理窗口不能成为每次观看、接管或升级的必经步骤。当前打开的独立窗口仅用于开发包迁移授权和本机故障处理。正式用户不应配置开发签名证书或执行构建命令；开发证书确认属于本次测试环境修复，正式发行使用连续的发行签名身份。首次确实缺失的录屏/辅助功能许可仍由 macOS 确认，但入口应收敛到 GeneHub 的本机设置，而不是让用户在聊天、独立管理窗口与多个手工步骤之间反复切换。

进一步澄清：**独立 Capture App 不等于必须有独立管理窗口**。设置和启用入口归 GeneHub；Capture 作为稳定签名的后台权限持有者，响应明确的本机设置动作并调用系统权限请求，用户只处理 macOS 必要的确认。当前 `manager_mac.mm` 的独立窗口不是 OS 授权先决条件，不能作为正式流程依赖；已有预览页承担观看、接管、交还和停止，不另做一套管理 UI。未来接线应复用现有轻量服务/启动入口，避免新增常驻权限代理或重复权限模型。现已新增 `--request-permission screen|input`：同一固定签名 Capture App 可经 LaunchServices 直接发起系统请求，不打开自己的管理窗口；显式申请进程保留自己的 AppKit 事件循环，最多等待120秒并只轮询许可状态，不重复请求，系统设置分派失败必须报错，返回前不把“已派发”当作“已允许”；`--probe` 与普通启动保持无提示，且拒绝把 probe/capture 参数与请求模式混用。GeneHub 设置到该原生入口的接线仍未接入；在完成前不宣称已实现产品一键配置。

现有 `--headless --share --allow-control` 已支持获授权 Agent 按需无窗口启动，无需用户每次在源机勾选管理窗口；这不表示网页已经具备自动唤起未运行 Capture 的能力。当前网页只能连接已登记运行的 provider，后续轻量唤起接线仍需实现和验收。日常目标为“网页打开成果 → 连接观看 → 按需接管 → 交还/退出”；既有已授权用户不强制重走配置，源端操作只留给首次缺失权限、明确撤销后的恢复或真实 OS 要求。升级验收必须让用户离开源机再完成，不能用每次本地点击来掩盖启动或权限保留缺口。

集成配置入口可以放在 GeneHub 中，实际 OS 授权必须归属于执行采集/输入的稳定 Capture App，不能因为入口放进 GeneHub 就假定两个 App 共用授权。保留 daemon 与 Capture 独立进程；下面只调整 Capture 包装、既有状态接口和轻量启动对接，不增加权限 broker、按项目 ACL 或另一套浏览器 SDK。

| 修改位置 | 拟实现行为与验收 |
| --- | --- |
| `apps/capture/build.py`、App 发行构建入口 | 独立 Capture 使用固定 Bundle ID、固定安装位置和连续的代码签名身份；签名内嵌 native 库、可执行文件及 App，验证签名及升级前后 designated requirement 的兼容性。产物记录签名、entitlement/profile 身份。普通构建不能冒充签名发布，也不能自动替换已授权运行包。 |
| `apps/capture/native/manager_mac.mm`、GeneHub 设置入口 | 一次进入“配置此机器远程体验”，统一显示录屏、输入、远程桌面持续访问及必要网络权限的真实状态，按需引导系统确认；授权完成后验证、处理仅 Capture 自身的重启并继续配置，不再靠聊天逐项指挥。系统最终同意由用户作出。 |
| Mac entitlement / provisioning 与原生能力探针 | 仅在目标 OS 的持续使用实测确实需要时，另行评估/申请 Apple 的 `com.apple.developer.persistent-content-capture`；它不是继承已有授权的默认先决条件，不能自行写一个 plist 就宣称获得资格。以批准的 profile 和实际目标 OS 为准验证持续访问；普通录屏 preflight 不等于独立 Remote Desktop 权限状态，不把未知状态误报为拒绝，也不在后台轮询会弹系统提示的请求 API。 |
| `apps/capture/src/main.rs`、`state.rs` 和用户配置 | 新安装默认关闭；现有 Agent 显式启动参数继续可用。可选的无人值守设置才持久保存本机启用、指定显示器和允许控制的意愿，不能强制所有用户配置常驻服务。撤销本机启用立即停止新会话并释放旧输入；会话 token/控制租约不持久化。 |
| Capture 生命周期与既有服务登记 | 首次配置允许用户选择登录后启动、异常退出后恢复；轻量连接方负责发现/唤起已配置的 Capture。沿用现有 OS 生命周期机制，自动处理自己可证实已失效的登记，不能要求用户手工删文件。恢复保留当前独占锁、短期租约和释放确认；无法确认时报告并阻止新输入。 |
| 现有 `/api/remote/state`、Preview/H5 | 在现有 `available/inputPermission/shared/allowControl` 状态上提供可解释原因、是否需要源机处理及继续方式。远端能区分未首次配置、OS 权限缺失、等待自身重启、目标改变及暂时离线。已配置正常连接无需源机点击；远端 HTML 不能用请求接口擅自启用本机共享。 |
| H5、profile 和自定义 provider | 只改 HTML/JS/CSS 或运行参数不替换权限持有者，不能触发 OS 重新授权。修改 native 实现仍需构建和签名兼容检查；另换独立 provider 的 OS 授权不自动继承。授权不是任意不同二进制的通用通行证。 |

依据：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) 说明 TCC 记录并校验 designated requirement，正常更新不应仅凭文件 hash 改变就更换授权身份；仅 Bundle ID 相同或 Team ID 相同并不足以替代兼容性验证。[Persistent Content Capture 文档](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture) 明确需要向 Apple 申请；[Remote Desktop 系统设置说明](https://support.apple.com/guide/mac-help/mchle046574e/mac) 说明独立的系统授权入口。Apple DTS 对其独立只读状态查询的[答复](https://developer.apple.com/forums/thread/841530) 表明不能假设已有专门的公开查询 API。上述是设计依据，非本项目已经获得 entitlement 或完成签名的证明。

验收必须增加：首次配置完成后离开源机，远端连续多次连接/交还/重连；Capture 异常退出恢复；H5 定制及兼容签名版本升级后继续真实播放和输入，全程无需源机再次点击。另测用户撤销权限后的准确错误和释放、不同签名身份被拒绝及 source opt-out 不被远端打开。是否需要系统重新确认以实际 OS 策略为准，不承诺 OS 升级或用户撤销后永久免授权。FileVault 解锁、未登录、锁屏状态分别验证，不把用户登录后恢复外推到所有开机状态。

2026-10-30 已在 Mac mini 实测旧包：签名标识为 `genehub_capture-f0154285c89a65cd`，DR 只有 `cdhash`，Info.plist 未绑定，完整资源签名校验失败；机器没有可用签名身份。不是已有稳定签名更新后的正常授权行为。

本轮具体改动：

- `apps/capture/macos_signing.py`：显式一次性初始化本机开发证书/专用钥匙串；仅用户级 codeSign 信任，不改 TLS/系统根信任、TCC 数据或 daemon 身份。后续构建复用同一证书，绝不每次重建；正式分发另用既有 Developer ID，不把本机测试证书当发行资格。
- `apps/capture/build.py`：Mac 必须选择既有证书或已初始化的本机开发签名；先签 native dylib，再签固定 `com.genehub.capture` App，完整 strict/deep 验证后才生成成功包。先在旁边完成打包，编译/签名失败不破坏旧包；禁止覆盖仍从 dist 运行的程序。
- `macos_signing.py install`：固定安装路径；获取 Capture 与输入 guard 的现有 OS 独占锁；校验当前包和新包，使用 macOS 自己的 requirement evaluator 双向验证升级兼容，再替换。签名不匹配、资源被改、旧包/guard 仍运行均拒绝；不提供强制忽略身份选项。
- `apps/capture/src/main.rs`：增加无引擎依赖的 `--version`，方便支持人员区分已安装程序与 native ABI；使用真实不同可执行文件验收升级，不能只换资源后说代码更新已验证。

旧 hash 身份无法由新证书伪装继承；必要的一次迁移授权必须由用户在 macOS 作出。目标是迁移后连续正常更新保留权限，签名兼容通过不等于 TCC 实机验收已通过。本机开发签名已配置，两个不同可执行文件版本的 strict/deep 与双向 DR 校验已在 Mac 通过。带无管理窗口授权命令的 build 10 已兼容安装，已从固定安装 App 发起 screen/input 两项系统请求；后续用户关闭再开启权限，tccd 日志已确认当前安装 App/证书 DR 的 ScreenCapture Allowed；但新进程仍因另一份旧 cdhash verifier 校验失败而不获准。刷新 App 版本/注册、排除验证副本注册及相同签名换路径均未修复，不能把此状态误报为用户未授权。尚未重置或修改现有 TCC 授权，实际升级后保留 TCC 许可仍待验证，不声明已获得 Apple entitlement、完成公证或发布。按需启动继续复用现有 Agent；新引导、登录常驻和额外 entitlement 不作为此次修复前置条件。

### 5.2.1 核心诉求：完全无人值守，不以用户解锁为前提（2026-10-31）

**用户明确要求：正常的开发、编译、运行、录制和验证，全程不得要求用户到机器前解锁屏幕。**
此前多轮把“请解锁一次”当作继续条件，是把平台的首次授权成本转嫁给了用户，不符合产品定位。

本轮在 Mac mini 上实测到一个具体的、可复现的无人值守缺口：

- 工作区迁到外置卷 `/Volumes/SDD` 后，启动 `UnrealEditor`（由 GeneHub 会话内的 shell 派生）在引擎初始化前停住；
  `sample` 显示主线程阻塞在 dyld 的 `open()`。
- 同时间的 TCC 日志给出直接原因：
  `kTCCServiceSystemPolicyRemovableVolumes` 的授权请求，
  `accessing=com.epicgames.UnrealEditor`、`responsible=com.apple.Terminal`，
  并记录 `responsible process has com.apple.private.tcc.allow-prompting entitlement` ——
  也就是 macOS **准备弹窗询问“是否允许访问可移动卷”**。屏幕锁定时无人能确认，`open()` 永久阻塞。
- 对照实验：锁屏状态下 `Calculator`、`TextEdit` 通过 LaunchServices 可以正常启动，说明
  **不是“锁屏禁止 GUI 应用”**，而是“访问可移动卷的首次 TCC 授权必须由人确认”。

由此形成三条产品要求（本节之前只写了“首次配置是交付条件”，这里细化为可验收的约束）：

1. **一次预置、长期免人工**：安装/首次配置阶段把执行采集、渲染、编码所需 App 的
   “可移动卷 / 屏幕录制 / 辅助功能”等 TCC 授权一次性完成；之后正常使用、升级、故障恢复不得再要求用户到机器前。
   TCC 无法由 Agent 自行写入，必须显式设计为一次性配置项，并在配置未完成时明确报告，而不是让任务静默卡住。
2. **可解释的等待状态**：Agent 遇到“等待 TCC 确认”时必须能识别并报告具体服务名与请求方（例如
   `kTCCServiceSystemPolicyRemovableVolumes` + `UnrealEditor`），不能用“进程没起来”当作运行结论。
3. **数据布局与权限的取舍要写清楚**：工作区放在可移动卷会为每个 GUI 执行体引入一次授权；
   若产品要求零人工，部署时应优先内置盘，或把可移动卷授权纳入一次性预置清单。

验收补充：在**屏幕锁定、用户不在机器旁**的条件下，完成一次“启动 UE 工程 → 出画面 → 录制产物 → 退出”的端到端流程；
过程中不允许出现需要人工确认的弹窗、不允许要求用户解锁。该条件不满足时，应判定为未交付，而不是“环境限制”。

### 5.3 在描述符和旧 API 上做增量

保持 ServicePreviewDescriptor version1，在 media 可选增加 `client:"html"`、`protocol:"remote-desktop/1"`、`sessionPath` 和 `controlPath`；offerPath/stopPath/microphone 沿用。普通 HTML 继续使用现有 fetch/WS，宿主小 API 只加公开 describe 和当前已批准策略的 ice 查询，复用 ServicePreviewClient.ice，不暴露 Client 或任意机器/端口。

Capture 通过 `/api/remote/` 提供 state、观看 WS、offer/stop、独立控制 WS。WS 是存活锚点，App 签发绑定运行/连接的 sessionToken；offer 绑定真实 SDP fingerprint；控制需要独占 lease、epoch 和目标代次。应用消息/schema 在 packages/proto 定义，daemon 只处理现有服务桥，不解析 control.acquire。

关键差异与完整消息示例、预算、兼容行为见[接入设计 §4–§7](interactive-preview-service-protocol.md)。未知版本明确拒绝，旧 Web 没有有效 WS 会话/token 时 Capture 不输出桌面，旧媒体服务不受影响。

### 5.4 输入与 Agent 协调

标准 RTP 播放，两个 DataChannel 分别承载可靠键鼠状态与允许丢弃的移动；输入包绑定 session、lease epoch、目标/布局代次与序号。坐标处理黑边、DPI、Retina、多屏负坐标；相对鼠标/指针锁定各端原型验证。OS/浏览器保留快捷键不承诺完整透传。

Capture App 仲裁控制，Workflow 让参与的 GUI Agent 静止并交还；daemon 不认识 Agent 的计划。waiting-for-yield 是等待，只有 granted 才可操作；非参与 OS 自动化不保证被强制隔离。首期同一桌面只启用一个控制 provider，切换先释放旧端。

## 6. 生命周期与定制边界

观看/控制分别绑定已有 WS，关闭控制 WS 仍可观看，关闭观看 WS 回收媒体及控制。App 每秒发当前一次性 challenge，3 秒未从同一 WS 收到有效回答就关闭；这是待原型固定的起始预算。过期/消费的挑战不能重放，不能预排队 renew，也不能仅沿媒体 DataChannel 续权。普通链路恢复、设备撤销、daemon 冻结时，仍活着的媒体 PC 不维持旧授权。

源端 watchdog 和释放不得等待 GPU 编码或协议 ACK；需要证明服务进程崩溃仍释放输入时，守护必须独立进程。已关闭连接不等于已释放 OS 输入，证据包含实际键/按钮状态与资源回基线；整个进程树被强杀后的情况独立验收。不杀 Blender/UE/Agent，不修改用户工程所有权。

沿用预览生命周期，在入口/source version、页面重载、runId、连接变化时取消 enable 和旧会话；副本修改后重新开启。删除前版 renderer manifest、完整资源快照和逐依赖授权平台；当前信任所选预览脚本及依赖，不声称完整依赖 TOCTOU 防护。普通 H5 不全局放宽设备权限；仅 HTML 媒体模式评估必要锁定/播放策略，不加 allow-same-origin，外壳全屏仍保留独立停止入口。

## 7. 画质、延迟、网络和运行成本

以下均为待原型验证的目标/起始参数，不是 WebRTC 自动提供的保证。

| 模式 | 初始档位 | 优先级 |
| --- | --- | --- |
| 创作检查 | 1080p / 30fps，码率约 6–12 Mbps，自适应 | 小字、线框和材质可辨；移动时保持操作响应 |
| 游戏体验 | 1080p / 60fps，码率约 10–20 Mbps，自适应 | 延迟、连续帧和音画同步 |
| 弱网 | 降到 720p / 30fps 或更低并明确提示 | 控制及时，避免大缓冲；不悄悄把目标体验记为已验收 |

首期基线 H.264 + Opus，SDR；硬编码、低延迟设置、短队列，拥堵时丢旧帧并请求关键帧，避免编码 backlog。AV1、HEVC、4K、HDR 和高色度文字模式之后再测；H.264 4:2:0 不保证专业色彩审片或精细排版体验。系统声音和麦克风分开：下行声音按源端选择和授权采集，麦克风默认关闭；不把它当成游戏声音。Windows 的系统 loopback 和 macOS 音频路径分别验收，Linux 后续单独验收；窗口独立采集即使以后实现，也不自动代表只采该应用声音。

在编码 GPU 与 UE/Blender 共用资源时，先保护工作负载：测有无串流的渲染 FPS、耗时、显存与 encoder session，限制单路输出。无硬编码时可明确提供低规格观看降级，但不能标记为“游戏体验可用”。不首期引入多清晰度编码、多观看者或 SFU。

网络上继续区分服务数据策略与媒体策略：默认不擅自启用 TURN；直连失败显示原因，用户允许媒体中继后用当前 Channel 短期凭证重建。诊断显示实际选中 candidate pair、RTT、丢包和码率。UDP TURN 不解决所有企业网；TCP/TLS 443 需独立入口、容量与实网验证后再承诺，不拿 HTTP/3 或 Caddy 路径当媒体隧道。

粗算一路持续 15 Mbps 视频约 **6.75 GB/小时**（十进制，仅视频载荷，不含音频、协议与重传）。直连消耗源端上传；TURN 同时承担接收与转发，计费口径还取决于服务商。开放中继需有每会话带宽、并发和运行时长预算、流量观测及关闭开关，不能默认无限免费托管。

延迟应拆成采集、编码、传输、解码显示，以及输入到软件动作，再到画面呈现。`getStats().currentRoundTripTime` 只反映网络一段，不能拿它充当操作延迟。建议原型门槛：在指定硬件、RTT ≤40ms、可用带宽 ≥25 Mbps、丢包 ≤0.5% 的受控网络下，1080p60 游玩输入到可见反馈 P95 ≤150ms；DCC 检查 P95 ≤200ms。每组合至少取 100 次交互样本及 30 分钟稳定性记录，达不到就分析预算或降级能力，不改名宣称通过。

新增观测包括点击连接到首帧（含授权/信令分段）、真实帧更新停顿、解码 FPS、编码耗时/队列、输入序号确认、控制授予/回收耗时、资源释放及 GPU 工作负载影响。连接前已完成权限预检的受控环境，首帧目标 P95 ≤5 秒；当前非 trickle 收集可能用到 12 秒，需实测并通过现有登记 WS 的 trickle ICE 改善，不能沿用旧路径却许诺目标。跨机端到端延迟用可见帧标识/独立录像或受控测量装置校验，不依赖未校时的两端 wall clock 相减。

## 8. 到底修改/新增什么

以下是确定的首期实施范围；当前落地和未验收边界见 §12。详尽逐文件清单以[接入设计 §9](interactive-preview-service-protocol.md)为准。

| 范围 | 具体增量 |
| --- | --- |
| packages/proto/src/service_preview.rs | media 的四个可选 HTML 模式字段、remote-desktop 应用消息类型及生成类型；version1 保持 |
| Workbench serviceClient/serviceBridge | 复用 discover/fetch/WS/ice，补窄 describe/ice 页面入口、controlPath 门与定向关闭/状态 |
| AssetPreviewPage + 现有工具栏/媒体面板 | HTML 模式分流、保留可信停止、版本/连接失效、必要沙箱策略；旧面板继续 |
| daemon dataplane/service_preview.rs | 新媒体字段和路径校验、已有取消/撤销清理验证，缺口才补；保持原握手/方法/代理 |
| genehub-preview/assets/remote-desktop | 新增 index.html、client.js、input.js、style.css，薄封装、播放和输入可编辑 |
| genehub-preview 现有参考/示例 | 描述新旧模式、复制真实入口、Capture 登记、授权/停止/定制与验收；实施时再更新现行 Skill |
| 独立 apps/capture | 系统权限/共享 UI、现有登记/桥、原生采集硬编码、媒体/反馈、应用会话、输入 watchdog、安装/签名 |
| preview 专项和相关前端测试 | 旧服务回归、新 H5 实际媒体、控制门、断线/撤销/释放；平台真实软件另验 |

明确从实施清单删除：新 service.session 方法、service_session.rs、broker/HMAC/context 体系、remote:view/control 全局权限、npm SDK/独立客户端包、renderer manifest/委托/不可变包框架；Cloud/Fabric/Relay/网络握手没有首期新增业务改动。不实现动态原生插件、市场或跨 provider 仲裁框架。

| 阶段 | 独立交付与验收出口 | 仍不能宣称 |
| --- | --- | --- |
| M0 | 原生模块独立构建/媒体反馈；H5 opaque 沙箱真实 RTP、声音、输入/锁定、WS 回收预算可行 | 产品已远控、未经测量的性能数字 |
| M1 | 默认 Capture + 内置 H5 观看、声音、停用/撤销和资源回收；H5 从第一版就是实际客户端 | 已可编辑/游玩 |
| M2 | 键鼠、控制租约、交还与参与 Agent 静止；真实 Blender 完成任务 | 所有快捷键或自动化强制隔离 |
| M3 | 指定无保护 Demo、直连/允许 TURN 跨网；H5 修改与恢复默认 | Pixel Streaming、完整手机输入、任意游戏兼容 |

M0 不估工期，先给可测出口；Linux/Pixel 不阻塞。GeneHub Web/guest 小改按兼容门做 Live；Capture 原生制品独立 full 交付，不默认要求改 WIT/重装 GeneHub 基座。

## 9. 验收、证据和恢复

实现与验证按当前 testctl 合同执行，执行结果和阻塞见 §12。复用现有 preview 注册/HTTP/WS、Channel ICE、原生浏览器媒体专项入口并扩展真实场景，不以 mock SDP/WS echo 代替画面和输入。

| 输入/故障 | 需要看到的最终结果 |
| --- | --- |
| services 有/无，PreviewShare，Capture 未共享/只看/允许控制 | 真实源端输出/注入符合策略；按钮不是额外设备授权的说法正确；files 不能提权 |
| 新 H5/旧媒体服务、新旧 Web/guest/App 组合 | 新模式走真实 H5，不双建 PC；旧服务工作；不支持明确拒绝；无 WS/token 的旧 offer 不泄露桌面 |
| 纯直连、Fabric 信令、允许 TURN 且阻断直连、UDP 全禁 | 数据策略和媒体策略独立；selected pair 可证路径；未支持 443 的网络明确失败 |
| 查看端断开，控制 WS 单独关闭，拒发 release，daemon 冻结/崩溃，设备撤销而媒体仍直连 | 保留观看/停止媒体符合合同，输入按期限释放；过期 challenge/token 不复活，恢复不续控 |
| Human 接管时 Agent 有在途 GUI 动作 | 实际静止并交还；waiting-for-yield 不注入；外部未参与自动化说明限制 |
| Chrome/Edge、Safari、WKWebView/WebView2 及指定 Windows/Mac | 各端真实播放/声音/锁定/失焦、OS 权限与硬编码通过；不能用 Chromium 或 Linux 编译替代 |
| Blender、普通 Demo、DPI/Retina/黑边/负坐标/显示器热插拔 | 动作真实正确或明确暂停；旧布局代次不误操作；保留工程 |
| 30 分钟 UE/Blender 共载，之后关闭 | 延迟/帧/资源曲线可追溯，GPU/采集/输入回基线；守护故障另测 |
| 修改 H5 布局和一种输入映射，页面重载，换 App 版本 | 无需改 daemon，旧会话失效，默认资源可恢复；不声明完整依赖快照保证 |

报告保留两仓 revision、Capture 制品 hash、OS/浏览器/GPU/驱动、软件/工程版本、网络条件、真实路径、首帧/延迟样本、动作结果与释放证据；不记录原始 SDP、TURN 密码、用户画面/文本。mock 只限确定性协议/坐标不变量，真实产品边界使用 WASM daemon、公开 Client、实际浏览器、App 与测试工程。

回滚先停止新控制、释放输入/媒体，再切换兼容制品并重新登记；旧 token/lease 不恢复。缺 Capture 安装/系统权限如实说明，保留文件/旧媒体入口；不自动以未经验证的二进制回退，不关闭用户软件。

## 10. 取舍与 M0 未决项

本次简化放弃的是首期设备级看控分权、通用 broker/SDK 平台和完整执行依赖快照，保留现有可信服务模型。需要这些更细能力时，基于实际缺口再设计。对于当前“自己的机器、自己的工程、可信客户端随时检查/体验”，现有 services + 源端显式开启 + 连接绑定租约是更小且可解释的起点。

截图/代理视频仍适合离线阶段审阅，但不能代替操作；整套 Sunshine/Moonlight 产品引入重复配对/网络/更新，继续不选；只做 Pixel 覆盖不了 Blender/普通游戏。原生模块复用结论不因 Web 简化而改变，停止条件见 §3.5。

M0 必须核对四个缺口：H5 在各端的真实 RTC/指针锁定/外壳可见；取消/设备撤销到 App WS/输入释放是否闭合；现有背压下 challenge 期限的预算；原生模块独立抽取与完整媒体反馈。缺口明确后只增加必要能力，不以“SDK 完整性”为由恢复整套通用框架。

## 11. 工程边界声明

依据[工程引导](engineering-guidance.md)、[工程律法](engineering-laws.md)、[架构](architecture.md)。Git blob digest：引导 `0668e079136b4f0033db893a16628922bb51b973`；律法 `e23dbb87e2168181010feb4d8585e016b5ab02f2`。仅设计声明，不代表运行验证。

| 引导 | 适用性和方案回应 |
| --- | --- |
| G01 适用 | 工程留源机、远程是正常入口、Agent 通过工作流参与；B1/B2/B4 不变，Capture 独立原生交付明确触达 B5 |
| G02 适用 | 复用现有 Preview 两类实际形状：旧媒体服务与 Capture/H5；原生 Windows/Mac 适配各验，不为单消费者新建通用框架 |
| G03 适用 | 协议进 packages/proto，描述符 v1 增量；旧 Web/服务兼容或明确拒绝，不手写跨仓副本 |
| G04 适用 | GeneHub guest/Web 小改可 Live；Capture 安装/签名独立 full，不扩 WIT |
| G05 适用 | 源端目标/共享/租约归 App，换客户端重新申请，远端不可达不冒充已连接 |
| G06 适用 | 直接检查/操作作品和游玩 Demo，减少截图、坐标口述与人工找进程 |
| G07 适用 | 描述符声明 H5 模式、App 报实际采集/编码/输入能力，不靠反复失败探测 |
| G08 适用 | H5/Agent 输出为用户预览内容；协议类型化、有界；services 的粗粒度与脚本信任范围明确，不借按钮伪造服务端权限 |
| G09 适用 | 首帧、冻结、真实输入反馈、WS/控制回收、GPU 共载与网络路径同批验证，见 §7/§9 |
| G10 适用 | §1/§8/§10 明确删减及顺序理由，不重新引入网络 pacing、SDK/broker/插件平台 |
| G11 适用 | 真实 App/公开 Client/浏览器/OS 行为为 oracle；mock 只限确定性合同，缺平台证据不得声称通过 |
| G12 适用 | 预览副本/profile 归项目，私有登记/机器 OS 设置归本机；短期 session/token/lease 内存化，不把业务放 daemon 数据目录 |

## 12. 首轮实现状态（2026-10-29，dev-4）

已开始实现，未上线。源码入口是 [Capture](../apps/capture/README.md)、
[默认 H5](../apps/daemon/builtin-skills/genehub-preview/assets/remote-desktop/index.html) 和
[接入说明](../apps/daemon/builtin-skills/genehub-preview/references/remote-desktop.md)。

| 部分 | 当前落地 |
| --- | --- |
| 现有 Preview | 描述符可选字段、daemon 校验、H5 describe/ice、外侧 relay/control/停止工具栏；源文件版本变化失效，旧媒体模式保留 |
| H5 | 四个可复制修改的静态文件，原生 RTP H.264/Opus、候选交换、统计、观看/控制分离 WS、键鼠/文本/指针锁定；无 npm SDK |
| Capture | 独立 Rust App + 固定版本原生模块，v1 登记/桥、硬编接线、本机 Win32/Cocoa 管理窗口，默认关闭共享/控制，独立输入守护 |
| 生命周期 | 同 WS 一次性 challenge、3 秒期限、lease epoch、可靠按键状态进度、源端/呈现帧进度、失联/关闭回收、释放未确认时阻断新控制 |
| 构建 | 含带锁源码准备与 unsigned 开发包脚本，不安装、不发布、不自动请求 OS 权限；签名/公证/安装器尚未交付 |

Linux、Windows 4090、Apple Silicon Mac 已有 Rust/C++ 构建和 unsigned 开发包记录；归档构建校验源文件摘要，
避免固定文件时间导致复用旧编译结果。Windows 11 / RTX 4090 D 的实测记录保留；按用户最新要求，当前从 Mac 切回 Windows 优先验收。此前 Windows build 12 与 Mac build 7 的私有 native ABI 均为 4；最新 Windows build 13 / Mac build 10 的限定结果见 12.5。Mac build 7 含 Retina 尺寸修正，本轮新增的有界后端诊断未重建或替换 Mac 包。Mac 尚未通过原生画面/输入验收，具体进展见 12.2；Windows 本轮结果见 12.3。Linux 未启用图形后端，返回 `native_graphics_backend_not_built`。
Windows 实测已取得 1920×1080 原生桌面视频（短时约 30 fps）、系统音频 Opus 接收与 440 Hz 测试音 PCM 识别、实际鼠标 down/up、文本框键入。主动交还后按键释放样本约 227 ms；暂停 Capture 父进程后，独立输入守护仍在约 861 ms 内释放保持的 W。上述浏览器与源端均在同一 Windows 机，host/host ICE，不能外推跨机性能。
测试使用公开 Preview/Client、实际 H5 和独立测试 runtime；现有账户的 Hub 跨机入口没有因此验收。首帧前会话过期、一次完整点击未被观测的失败仍保留，初连/输入稳定性未关闭。
Web 已完成构建/typecheck；Workbench 历史基线
860 项通过（包含 Preview/Markdown 110 项），新增鼠标取消/画面外释放、页面授权失效的组件回归均通过。
本轮补充 Preview 定向回归 90/90、typecheck 通过。真实 Capture 默认不共享、实际 opaque H5 的页面 API/接管入口、既有参考对端真实音视频及 ICE 的
3 项浏览器专项通过；参考对端不是 Capture 原生引擎，不能据此证明桌面远控可用。

完整 `change` 门禁已执行 687 项：682 通过、5 失败，资格为 **false**。其中 1 项因系统 Python 的
SQLite 3.26 不支持 `DROP COLUMN` 失败，改用机器现有 Python 3.12 / SQLite 3.53 后该项专项复验通过；
另 4 项既有 Claude 真服务测试在该轮返回 `403 Insufficient account balance`；账户的当前状态需以新门禁为准。原失败记录和
主动停止的重复全量尝试均保留，不把专项修正或中断拼成完整门禁通过。
本轮尚未取得提交审查封印、尚未提交或发布；源码保留在 dev-4。正式证据沿用任务
`remote-desktop-implementation-20261029`。账户恢复后，用已核对的 Python 运行时重跑完整门禁，再审查提交。

**M0–M3 尚未通过完整平台验收。** Windows 基础画面/声音/输入/释放已有上述证据，但稳定性、Blender/Demo、现有 Hub 跨机、Safari/原生 WebView、
跨网 TURN、持续负载及 macOS 当前源码的真实画面/操作仍需证据。原生库已做 Windows 输入坐标、macOS 输入专用接缝和 baseline H.264
适配，但没有据此宣称两平台远控运行通过。当前只接 RTCP PLI/FIR/REMB，不宣称完整游戏拥塞控制/弱网质量。
自动暂停其他 GUI Agent、完整手机输入、显示器热插拔后透明恢复不在此轮已实现清单；先验证、明确缺口后再扩。

### 12.1 Windows 实测带来的必要调整

- 完整 GPU 探针曾耗时 2931 ms，不能反复放在 3 秒租约路径。Capture 启动保存能力快照，租约、管理状态与输入子进程使用便宜的 OS 目标/权限 preflight；原生媒体启动仍实际检查。
- 输入子进程独立初始化 DPI，以物理像素贯通显示器 DEVMODE、虚拟桌面度量和输入坐标；显示编号与 GDI 设备名不相等，按稳定 monitor key 绑定。
- 当前 WS 对同一个已消费 challenge 的重复回答不延长期限；默认 H5 只回答同 nonce 一次。期限没有放宽，不增加 daemon/云端权限框架。
- Windows trace 发现浏览器本地 WebRTC 冷启动会延迟 H5 处理续期；ICE、peer 和本地 offer 先准备，再申请源端短会话。取消准备过程不创建源端权限；3 秒期限保持不变，修复后的单轮已连续解码约 47 秒，稳定性仍需更广验证。
- 增加有界协商阶段、WS challenge/renew 计数与 watchdog 诊断，先报告原因再等待清理；不记录 SDP、令牌、输入正文或用户工程画面。
- 验收先确认原生窗口可见并在视频匹配独立 RGB 标记，再发送输入；声音以接收端实际 PCM 判定，按键释放以 OS 状态判定。组件/参考对端通过不能替代这些真机结果。

### 12.2 Mac 实测、修正与当前等待项

在 macOS 26.4.1 / Apple Silicon 上，用户授予录屏与辅助功能后，build 6 经 LaunchServices 启动，实际允许 `--share --allow-control`；公开 Client、Preview 和内置 H5 已加载。测试浏览器 Chromium 153 先报 `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`，为本次新建测试 context 的精确 loopback origin 授予标准浏览器 `local-network-access` 后连通。它是浏览器的独立权限，不需要新增 daemon ACL，也不能误报成录屏权限缺失；该结果不代表 Safari 或现有 Hub 跨机入口已通过。

随后原生会话报 `target_changed`。同机 OS API 实测：显示模式物理尺寸为 3840×2160，旧 `CGDisplayPixelsWide/High` 却返回 1920×1080。快速 preflight 与目标快照现统一使用 `CGDisplayModeGetPixelWidth/Height`，与原生探针一致，同时保留显示 UUID、逻辑边界、旋转和权限检查；未放宽租约或目标变化保护。修正后的 build 7 编译通过，原生源码及包摘要已绑定。此修正仍需真实解码与输入验证，不能仅凭编译宣称通过。

build 7 的 LaunchServices 只读探针再次显示录屏和输入权限均未授予：重编译后的 unsigned 开发包没有继承旧包授权。新包本地管理入口已准备且默认不共享；用户后续明确要求继承已有权限，因此不再把重新授予当作恢复路径，先处理稳定身份和兼容更新。正式分发必须使用稳定代码签名身份并单独验证更新后的 TCC 行为；当前 unsigned 包不具备免重复授权的交付资格。期间未重启原 daemon，未更改账户权限，未向其他用户窗口发送输入，也未截取桌面内容。Mac 原生视频、音频、键鼠及冻结父进程后的独立释放仍未取得通过证据。

### 12.3 切回 Windows 后的复验与当前阻塞

用户离开源机后要求先跑通 Windows。复核目标 PC-4090-1 可达，既有 build 11 exe/DLL 摘要一致，原生探针显示采集/输入可用；没有重装软件或重启原 daemon。attempt 21 与诊断 build 12 的 attempt 25 都通过真实公开 Client/Preview/H5/WebRTC 连接，浏览器解码 1920×1080，但三个自身测试窗口标记采样均为 RGB (0,136,0)，无法确认桌面真实内容，因此没有发送键鼠，也没有保存桌面截图。历史正常运行的画面、声音和输入结果不能替代本轮失败。

补充的只读窗口诊断显示 WinSta0/Default、当前 console session 1；自己的两个显示器测试窗口均 uncloaked，但实际测试点属于 Explorer。虚拟桌面 COM 查询曾超时，其确切自建子进程经核验后停止；未操作其他应用窗口或推断具体根因。新加 `GENEHUB_CAPTURE_NATIVE_DIAGNOSTICS=1` 可选后端诊断，最多 64 条、每条 768 字节，只记录选定媒体阶段，排除输入/键盘及窗口标题。build 12 的真实日志确认 DXGI 3840×2160 SDR/BGRA8、RTX 4090 D/NVENC 1920×1080 初始化成功；同时 WASAPI 返回 `no default playback device (0x80070490)`。这证明声音设备在该轮不可用，不能用它替代对视频异常根因的调查。

一次标准显示器唤醒系统消息发送得到回执，后续命令在取得退出状态前断线；唤醒效果及该命令的最终退出状态未知，不得重发当作恢复，也不能断言该消息导致离线。随后同身份 context 和机器目录连续报告 Windows 离线，WTS 状态查询未能进入目标，原生验收在此中断。恢复后先核对未确认命令及精确自建进程，再检查桌面/实际首帧、默认音频端点、必要的采集后端选择，继续自身窗口和 Blender 工厂场景验证。不得凭在线目录、NVENC 初始化或解码帧数宣称已经跑通。

build 12 的归档摘要与产物 sourceDigest 已绑定；同源 Linux 开发包构建成功。`261029-2254-remote-desktop-native-diagnostic-6ca6` 的真实 Capture 默认关闭共享及公开 Preview/H5 专项 1/1 通过，仅 `dev-feedback` 范围；不能替代 Windows 实机结果或完整 change 门禁。当前仍未完成 Blender/UE/Demo、稳定持续运行和跨机/跨网验收，未封印、提交、合并或发布。

### 12.4 未合入代码全面复查与专项补充

复查基线共 45 个未合入常规文件，涵盖 daemon 增量、协议及类型投影、Workbench/H5、Capture Rust/C++/构建、依赖锁与文档；Cloud 无改动。两仓 `git cherry origin/main dev-4` 无独有已提交补丁，待处理的是工作树内这些文件。

本轮已修正三处真实问题：文本提交后旧按键集合被下一次心跳重新按下；DataChannel 发送瞬间关闭时异常未触发交还；外侧关闭服务桥后 H5 WebSocket 由于 MessagePort 无对端关闭事件仍显示 OPEN。前两处有先失败再通过的组件回归，第三处由真实浏览器专项先复现，再修复通过。测试自身也改用独立 HOME/XDG/应用数据目录，避免并行 Capture 争用运行者的真实账户锁。

新增三项实际编译 Capture / daemon / 公开 Client 专项：一次性 challenge 重复答复与到期、RPC 同 ID 重放/冲突与控制/观看端点隔离、实例锁/正常重启/硬退出登记归属。原有浏览器专项增加编码/query 路径绕过拒绝和外侧撤销后的 H5 关闭事件。修复后的 `261029-2319-remote-desktop-review-fixed-b1d5` 4/4 通过，仅为 dev-feedback 范围；保留此前 3/4 的失败 run。Preview 组件回归 93/93、类型检查、Linux Capture 构建通过。当前完整门禁结果另以任务证据记录，不由这些局部结果替代。

复查仍阻止把整项需求认定为完成：

| 优先级 | 尚未关闭的事实/缺口 | 必须补充的验收与改动方向 |
| --- | --- | --- |
| P1 | `media.rs` 用编码回调刷新 last_native，上游静止重复帧也会编码；Windows resendStamps 甚至将 capturedUs 设为 now，简单追加该时间戳也不能证明真实采集进度 | 明确采集健康与首个真实画面状态；测首次采集延迟、静止桌面、采集失效但编码仍重复输出。无有效画面不能授予/继续控制；绿画面根因仍未知 |
| P1 | `Registration::publish` 拒绝所有已有记录；硬退出后确实无法自动重启，新的专项验证的是显式拒绝，没有验证自动恢复 | 只恢复可证明属于自身且失效的登记，保持独占输入锁和新会话身份；远端无需手工删文件 |
| P1 | Mac 已补稳定证书签名、固定安装路径和兼容更新校验；用户已授权，但当前 TCC verifier 仍失败，未证明更新继承；异常登记恢复未完成 | 保持兼容签名身份，遵守用户已授权的本机选择；升级/异常退出后离开源机仍能实际观看和输入，不重复要求授权 |
| P2 | 缺系统音频设备时原生模块静默降为无声；远端 state/H5 还没有解释该状态 | 暴露有产品意义的音频能力/故障原因；测试无设备、设备恢复及实际接收 PCM |
| P1 验收 | Blender/Demo、持续稳定性、真实设备撤销/守护故障/显示器变化、现有 Hub 与 TURN、Safari/WebView 仍缺本轮证据 | Windows 恢复后先核对上次中断命令，再测自有窗口像素和动作；禁止以帧数、初始化日志或参考端替代原生成功 |

本轮不凭静态推断改写原生采集核心，也不增加 broker、SDK 或权限层。原生模块复用路线继续保留；首帧/健康状态的具体接缝应由上述专项和真机事实确定。未取得完整门禁与提交审查封印前，不提交或合入。

本轮完整复查门禁 `261029-2323-remote-desktop-review-full-948e` 已结束：690 项，682 通过、6 失败、2 中断，qualification=false、inputDrift=false。失败涉及既有 Claude CLI/真服务测试；两个中断为千轮历史与进程列表旅程超时，原因未全部定位，不能一律归因为环境。之后只修旧媒体页面的一次性凭证消费时机、调整测试证据和本节说明，需以定向复验记录评估；本轮没有当前完整候选资格。内部 ServicePreviewClient 替身生命周期测试已从未合入候选移除并保留任务回执，实际撤销以公开浏览器专项验证，不声称已复现特定 React 微时序窗口。

另补充媒体合同检查：`media.rs` 固定 H.264 profile-level-id，而原生编码器为自动 level，尚无实际 SPS/接收能力一致性证据。后续在该文件与原生配置接缝校验/约束协商参数，并补 Safari/WebView 真机播放；不凭修改一个 SDP 常量宣称修复。采集健康接缝、可解释的音频状态、自身异常登记恢复与兼容权限身份仍是具体优先项，不重写整套远控框架。

### 12.5 用户离开后的实验与本轮代码调整（2026-10-30）

Windows 同身份恢复可达后，先核对诊断26，确认自身命令/窗口已退出，没有重发唤醒操作。新自建窗口仍无法在桌面采样点确认身份；独立 WTS 查询报告 WTSActive、SessionFlags=0（锁定），即使 OpenInputDesktop 为 Default、UOI_IO 为1。锁定状态取值依据 [Microsoft WTSINFOEX_LEVEL1 文档](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w)。这是本轮明确的 OS 状态证据；旧 attempt25 无 WTS记录，其全部绿屏原因不能据此倒推为已证明。

据此完成最小改动，保持daemon和权限模型原样：

| 位置 | 实际调整 | 本轮验证 |
| --- | --- | --- |
| Capture native/capture.cpp、CMakeLists.txt、capture.h | 连接preflight及独立输入守护目标检查要求WTS会话活跃、未锁定；失败返回desktop_unavailable，链接系统wtsapi32，不引入后台服务或自动解锁 | Windows build13实际编译，100次原生preflight全部拒绝，最大2.3972ms；未验证按键保持后再锁定的释放时延 |
| Capture src/main.rs、engine.rs、preview.rs | 只读CLI探针合并当前preflight，明确报告不可用；新错误经现有WS返回。运行中保留原始编码能力快照，避免把临时锁定缓存成永久不可用 | build13探针available=false/inputPermission=false；真实公开Preview/H5的attempt31得到desktop_unavailable，视频未解码、peer/输入通道closed、无注入 |
| H5与Workbench消费者 | 本轮没有新增SDK或改协议框架；使用当前源码构建公开消费者，继续沿用既有关闭/取消路径 | 四项真实Capture/公开H5专项4/4通过，feedback范围、inputDrift=false |

Windows build13源归档SHA256为7c6ac6100231e610b8ef93bb1dc122599ef1501a07cf279b82550f84c008dba2，sourceDigest为733da0bb264f360300371504be855049a663f97c8370db8975460b44458bab94；实际31个包文件hash已核对。专项run为261030-1043-windows-session-health-6eec。此后只有文档状态说明修改，未改编译代码。

Mac本轮只验证原安装包及读取状态，没有替换现有build10或重置授权。其稳定证书签名和磁盘完整性通过，用户此前的Allowed记录已有系统日志佐证，但新进程preflight仍失败；此前SecStaticCodeCheckValidity -67050与旧指纹不匹配的问题尚未解决。固定签名身份及兼容安装机制已经实现，但不能宣称免重复授权已验收。本轮未再次打开权限申请或管理窗口，原daemon未重启。

**本轮结论仍为未完成。** 锁定拒绝已经修正，非锁定采集健康/首个真实画面、缺音频设备的可解释状态、自身异常登记恢复、Mac TCC继承、Blender/Demo、持续负载及跨机/跨网仍待真实验收。后续先在可用桌面上按同包验证自己的动态色标，再做输入和Blender工厂场景；不加载用户工程，不以一次拒绝路径成功替代观看与操作成功。

### 12.6 不依赖现场授权的继续验证（2026-10-30）

桌面锁定和 Mac TCC 问题只阻塞对应的实画面/输入验收，不应成为整个实现、故障注入和包更新验证的停点。本轮继续完成以下工作，均不要求用户回到电脑前：

| 工作 | 实际改动和证据 | 验证边界 |
| --- | --- | --- |
| Capture 崩溃后恢复 | preview.rs在既有账户实例锁内保存私有内容摘要回执，硬退出后自动回收完全匹配的自有登记；main.rs保持实例锁直到登记析构完成。每次新进程生成新runId、secret且默认不共享/不控制 | 旧原型没有回执的记录仍明确拒绝，不根据名称、协议或PID猜测归属；不引入新daemon接口/权限层 |
| 登记清理归属 | 正常退出按完整字节摘要比对；即使另一个登记保留相同runId，只要内容不同就不删除；发布继续采用不覆盖已有路径的原子操作 | 不把同OS账户的任意文件写入当作隔离攻击模型；保留他人登记及无归属残留 |
| 真实产品回归 | 增强现有Capture进程专项，先复现旧包的entry-already-registered失败，再证明硬杀恢复、新身份/默认关闭、旧公开客户端拒绝、保留其他登记。现有重放、独占、H5默认关闭四项专项通过；类型、lint和governance通过 | 专项仅feedback范围，不是完整change/发布资格；保留全部失败run |
| Windows/Mac包的生命周期 | Windows build14与Mac build11均由同一源归档构建。真机实际杀死Capture、再次启动、关闭并检查自有登记清理、替换同runId的登记后检查保留及拒绝覆盖。Mac headless模式，Windows定向关闭本轮自己的隐藏管理窗口；两端通过 | 只证明真实进程、锁和文件生命周期；没有把它计为原生视频/键鼠成功 |
| Mac更新保护 | 在隔离安装路径以两个不同可执行文件实测：运行中拒绝更新、资源篡改拒绝、ad-hoc签名拒绝且原安装内容不变；合法兼容包通过系统双向requirement校验并更新 | 原~/Applications安装包的f977179b…摘要保持不变，未替换已授权App、未请求/重置TCC；仍未证明实际权限继承 |
| Windows Blender计算侧 | Blender4.5.1工厂场景经Cycles/OptiX实际使用RTX4090D完成512×512、16samples渲染，生成并校验PNG，单次render调用约2.31秒 | 后台计算验证，不是交互延迟/性能基准，更不是远程键鼠或实时桌面验收 |

同时补齐共享Capture测试driver的隔离LocalAppData目录准备。Windows独立夹具曾因缺少父目录、缺少LocalAppData和无法用MainWindowHandle找到隐藏窗口而失败；失败证据保留。修正的是夹具前置和准确窗口定位，没有改弱断言、跳过平台检查或重放已完成副作用。

源归档SHA256：00d0092d86fd7218993db60fb9e65623a36cf0bd3ef6e3329dd277a8a6fb3faa；两端sourceDigest均为1aa7ec339e4672e50a773caa10513e0f0b073dc1aa40188a48b205acc1981bd1，实际包文件Windows31个、Mac32个已核对。Mac保留原安装包，新的签名包只作候选和隔离验证。后续改动仅共享测试driver的目录准备和文档说明，编译代码与以上两端包一致。

此外，旧Mac管理进程49199的残留已按本任务原始启动回执runId f627d8eb…、当前文件hash和进程不存在三者核验；持有既有实例/输入锁后，仅备份并移走这一条本任务自建的失效登记。含旧secret的备份只留Mac本地owner-only目录，没有传出。三份隔离更新试验App也已清理；未触碰其他服务或原daemon，用户不需要手工删文件。这是有历史证据的一次定向清理，不作为“任何旧记录都可自动迁移”的产品承诺。

采集停滞撤控的核查仍发现独立缺口：media.rs的last_native由编码回调刷新；上游静止重编码把capturedUs设为now，Windows初始化awaitingPicture=false也仍可能在未有源画面时发送输出。锁定检查与进程冻结释放都不能覆盖“采集失效、编码线程仍重复输出”。后续需要显式的源画面有效状态和采集后端健康证据，并分别验证静止画面、首次采集缺失及后端停滞；不能只加一个编码时间戳或用参考媒体服务冒充Capture原生路径。本轮没有将这个P1标记为已解决。

整项需求仍未完成，当前无完整候选资格、未封印提交或合入。后续任务保持可推进状态，只有具体的原生观看/操作与TCC验收标注各自阻塞，不再把它们扩大成全部工作等待。


### 12.7 Mac 授权恢复与连续验收（2026-10-30）

用户再次强调：不能反复让其回到电脑前点击，也不能在每个内部阶段停下。本轮将明确授权申请和自动验收接起来，继续在固定安装路径和同一证书身份上修复，不新增权限代理、SDK或管理窗口。

- 在已有修复/申请范围内，用官方tccutil仅清理com.genehub.capture的ScreenCapture/Accessibility/PostEvent旧记录，各一次且全部exit0；不清其他App、不直接访问TCC数据库、不变更证书或系统信任。之后不再重复reset。
- 修正原生显式申请入口立即退出、忽略系统设置分派错误的问题。新增按需解析的内部ABI4交互扩展：主线程AppKit生命周期最多120秒，明确申请一次，之后仅轮询preflight；不创建自定义窗口，设置分派失败明确报错。普通probe/启动保持无提示，原管理按钮不改为阻塞等待。
- 真机build12/13均实际编译、同证书签名并核对32个包文件；build12已兼容安装，build13更新CLI help且实际exe不同，作为升级保留验证候选。Linuxfmt/check、diff、testctl lint/governance均通过。原build10和build12留在Mac本地tar归档，可核验恢复；原daemon未重启。
- 已运行一次完整交互验收序列：先核验两包，再按顺序申请缺失权限，随后计划新进程复验、一次实际升级和升级后再次启动。screen申请进程实际持续约120秒，最终和新进程探针仍false；该失败保留，未继续申请input或执行升级，不计通过。

最新系统日志已对当前证书绑定requirement返回status0，原cdhash060964匹配失败在本次请求片段不再复现；当前screen记录为Denied(System Set)。日志中另有anchor apple返回-67050，这是本地开发证书不属于Apple签名的独立检查，不能误报为当前Capture证书匹配失败。旧签名冲突的消退与实际OS许可可用是两项不同事实，目前后者仍未通过。

当前Mac上的独立观察程序只读取新进程权限状态，最多观察15分钟，不再请求/重置；一旦实际screen/input可用，就自动验证重启后保留、build12到13的真实兼容升级以及两次升级后新进程状态，升级后失去权限则恢复基线。后续真实画面/音频/键鼠验收也已接续，只有权限保留实际通过才启动，使用固定安装App的headless模式、隔离runtime和自己的Cocoa色标窗口，识别不到自有画面就不发送输入。这些仍是待结果的手工真机验收，不构成完整候选或发布资格。

build12 exe SHA256：9c906d3cce51856adb5933d85343645cdc4bfa7b531fd692b15cbc13c1b42644；sourceDigest：4adfdaa02963582a5eeb5d381380b07ba5d8608a47d64fefb0763dfd787d026a。build13 exe SHA256：db81b69715a7c748386fed8b22bf2f74dd6842300ee5b450bc9a263e9e0e60ac；sourceDigest：ef5c3f1e64fd9526e7aadf02f80c3d91b1690a4e6969719fd6962ee461900203。build13编译代码与当前源码一致，后续差异仅本文验收记录。整项需求仍未完成，非锁定源采集健康等既有缺口保持开放。


### 12.8 Mac 真实权限保留及基础交互通过（2026-10-30 15:50）

用户回到Mac后，未再申请或重置任何权限。新进程实际检测录屏/输入均可用。`present-retention-2-retention.json`证明build12→13真实兼容更新后，两次新进程仍有两项许可；`guard-retention-3-retention.json`又证明build13→14真实更新后的同项结果。固定BundleID、安装路径和证书DR未变；不扩展为所有未来OS/证书迁移或重启场景的保证。

首次原生attempt6画面和声音通过，但申请控制失败。系统崩溃报告87200及只读输入诊断89981均定位到`current_display`中的UUID查找：独立输入进程没有先跑GPU probe，macOS26在图形连接尚未初始化时于SLSGetDisplayForUUID断言终止。修正为先调用公开CGGetOnlineDisplayList建立显示连接，再做UUID查找，仍不做GPU探测、权限请求或创建窗口。保留attempt6失败，没有重复其副作用。

build14实际Mac编译、同证书签名、32个包文件hash通过。sourceDigest `7fb008ad1d6425f4934b1e57bf11b404181797e5a3de498d7cad0b3ca4a7d414`；installed executable SHA256 `0cfb7b4b9e1ef38b1ea863ae210068f7225211a7cb8f1859e2a4e53f4489f847`；源归档 `cb26ca301765aa495d76e3eaffb83014bf2b3fa39c18c460541f522664b45325`。

`attempt-7-installed-result.json`通过实际公开Client/ServicePreview/H5链路：1920×1080原生视频，23帧/0.753秒短样本；自己的Cocoa RGB色标确认后才发送输入；440Hz测试声实际解码峰445.3125Hz、RMS0.001924；真实OS mouseDown/up及文本a；按住W后交还控制，100毫秒观察内释放；停止观看后媒体轨/peer关闭。独立guard在101毫秒就绪。只是本Mac隔离runtime/Chromium的真机验收，不是现有Hub或跨网、长时性能及Safari验证。

清理再次核验测试主管91564、隔离daemon91746、Capture91796、Cocoa91803全退出，无Capture残留；原daemon13817仍在。证据经接收端专用传输完成并验证归档SHA256 `91a72e2530c5a9129371676d677efbb7a67a857c820a33c41f4daf1655ef2d67`，证据位于dev-4任务状态库的mac-acceptance：`mac-positive-acceptance-1.tar.gz`及原始JSON。Linuxfmt/diff、testctl lint/governance通过。

本次Mac授权保留与基础实时交互已通过；整体任务仍未完成，源采集健康P1、缺音频状态、H264 SDP、Blender交互、持续负载、跨机/跨网及完整候选门禁保持开放。此前12.7的待授权状态已被本节实测结果更新；失败记录继续保留。

---



### 12.9 Human 要求的真实端到端预览截图（2026-10-30 17:04）

Human 明确不要求在 Stable 预览，但要求实际跑通并提供截图。本轮保持产品编译代码与已签名 Mac build14 不变，新增手工真机截图夹具与普通文件验收入口，未发布或升级 Stable。

已完成的链路是：Mac 本机浏览器的真实公开 Client / AssetPreviewPage / 默认 H5 → 隔离 daemon 的 Service Preview → 已安装的独立 Capture → 实际 Cocoa 应用 / OS 输入 → H.264 / Opus WebRTC → 浏览器实际解码和页面截图。界面消费者通过现有手工夹具加载，没有替换视频帧、伪造 SDP 或把参考媒体服务当成 Capture。此链路不经过公共 Hub / Fabric 跨机路径，不能称为公开 dev-4 入口的完整跨网用户旅程。

`attempt-10-fullview` 实际通过：1920×1080（短样本23帧/0.736秒）；自己的原生窗口色标、全屏几何及边缘匹配后才截图和输入；440Hz音实际解码峰445.3125Hz、RMS0.001925；原生鼠标按下/抬起；原生窗口确认为 foreground/keyWindow 后 KeyA 使输入框收到a；等待后续解码帧后截取包含可信工具栏的完整预览页；交还控制后W在100毫秒观察内释放；停止观看后媒体轨/PC关闭。截图保留了原生输入法状态，没有更改用户输入法。

三张原始图片是`attempt-10-fullview-watch.png`、`attempt-10-fullview-keyboard.png`、`attempt-10-fullview-stopped.png`，通过专用文件下载到 release-beta 工作区的`preview/mac-remote-desktop/results/`，入口`preview/mac-remote-desktop/index.html`展示真实前后对照。证据包SHA256 `fb8155186f70a86352a98c23d2678245ef79f6c393e6a92ac398496855f5da56`，接收端completed及全部文件hash已核对，原始JSON/清理回执在dev-4的remote-desktop-human-preview-20261030任务状态库。安装exeSHA仍0cfb7b4b…；主管57889、隔离daemon57910、Capture58006、测试窗口58032均已退出，无Capture进程；原daemon13817未重启，无新授权申请。

保留失败：attempt8实际画面/色标通过，但将Cocoa calibrated color误当原始sRGB的边缘判定失败，未发送输入；attempt9画面/声音/真实鼠标通过并留存观看截图，但新borderless窗口不能默认取得键盘焦点，键盘断言失败。手工源程序随后显式允许key/main并在注入前检查真实焦点；改用纯黑边缘、保留原色标和真实OS/释放/停止断言。两次失败未删除、未算作通过，没有将夹具调整混为产品输入修复。

dev-4已完成成对构建、真实parity安装，supervisor349221及新gateway417185在启动会话外存活，输入/制品身份和HTTP页面通过；共享网关仅增加dev-4，其他路由不变。官方dev smoke仍因缺少`apps/daemon/workflow-packages/game-delivery`失败，未篡改门禁或认定完整交付。Mac向候选域名的连接由iOA返回明文403（code190001、软件需确认后才能访问网络），从而表现为TLSInvalidContentType；这不是证书匹配问题。未绕过网络控制、改证书信任或转用其他进程代理该被拒请求。

整体任务继续：公网/跨机实际入口、源采集健康P1、Blender/UE/游戏交互、持续负载及完整候选门禁仍未完成。以上仅是已完成的Mac本机端到端媒体/输入与截图证据。


### 12.10 Windows 实际 Blender 操作与 Mac 新盘访问异常（2026-10-30）

Windows PC本轮桌面实际可用，识别到两块3840×2160显示器。现有Windows build14包31个文件hash全部核对通过，sourceDigest为1aa7ec339e4672e50a773caa10513e0f0b073dc1aa40188a48b205acc1981bd1，exe SHA256为9fe67830d490c5c79982ad28e47cdb8c72b8b3f68b8e2771fccc51714a8b62ee。与当前源归档比较，后续编译代码变化为Mac条件分支的权限申请/图形连接初始化及CLI help文字；没有将旧包称为当前完整候选制品。

- 实际attempt32：真实公开Client/AssetPreviewPage/H5，经隔离产品runtime和打包Capture到原生桌面，1920×1080解码、自有RGB、440Hz声音峰445.3125Hz、原生鼠标和文本a、交还后W在96ms观察内释放、Stop关闭媒体通过。
- 实际attempt45：先启动自己的Blender4.5.1工厂场景，再用headless Capture进入真实预览。原生PID、窗口操作点及视频色标确认后，经预览左击原生归属已验证的标题栏获得焦点；实际光标(900,122)，再将鼠标移入视图区，发送G/X/1/Enter，原生Cube X0→1。前后截图来自浏览器实际解码区域，仅裁剪自己的测试窗口。交还/Stop通过。
- 实际attempt46：保持W后暂停自己的Capture主进程，独立输入guard在1084ms观察内释放；主进程随后恢复，Stop关闭媒体。不能将该结果等同于非锁定情况下采集后端失效的P1修复。
- 原始21文件证据包358015 bytes，经接收端专用下载completed和包内20份文件hash核对，archive SHA256为fa60d2ebf310a736d5efe1e5f5d10b83df7d1e6def6a4368e3b82ea4a5bea227。记录的33个测试PID已全部退出，无Capture残留。首工作区入口preview/windows-remote-desktop/index.html提供实际前后图与原始JSON。

失败保留：33/37/38/39/40/42在采集开始后启动新Blender的路径未通过原生目标归属，未向Blender发送输入；37的手工观察器因Windows共享文件替换WinError5停止，后续改为每轮独立状态文件、有界发布错误和时间/PID断言。43的原生Blender前置检查已通过，但WinForms Shown回调Write-Output被void委托吞掉，修正为实际Shown事件Console.Out.WriteLine；44取得真实Blender画面和控制租约，middle click未使应用获得键盘焦点；45改为已验证自己的原生标题栏普通左击并确认前台后才发送按键。观察器、原生启动和焦点夹具调整不算产品行为修复，streaming-first的新应用启动路径仍未认定通过。没有用程序直接设置Cube X或在输入之后强制系统焦点来冒充远程操作。

此轮是Windows本机隔离runtime的native E2E，不经过现有Hub跨机路径，不是Stable/Beta发布。原Windows远程context仍可达，version0.16.0/webProtocol3；OS确认Stable host PID200872、Beta PID76372仍在。CLI daemon status读默认目录返回false与实际连接矛盾，仅作为本地发现口径问题保留，未据此重启。

Mac新外置APFS盘/Volumes/SDD约4TB、可写挂载、UID501、mode0775、df显示空间充足；stat/access不代表实际文件读写通过。Python scandir与系统ls均在打开目录时阻塞，自己的ls sample落在__open_nocancel；未写盘/改权限/卸载/修复盘。tccd记录可移动卷preflight，responsible为Terminal，authValue1不是最终拒绝结论。真实公开Client连接原Mac daemon13817后，directory.list根列表8ms、/Volumes列表5ms成功，能发现SDD；随后进入SDD请求未收到返回、远程命令中断、peer握手超时，Hub报告Mac离线，尚不能确定进程崩溃还是仍阻塞。源码DirectoryList同步canonicalize/read_dir及wasm blocking::run inline值得核查，但未取得daemon现场sample，不能宣称完整因果链已证实。

Mac独立诊断任务mac-external-disk-access-20261030已保留现场和未确认项，并等待现场OS提示/进程检查。没有重置Capture许可、重签安装包或尝试绕过OS/iOA限制；没有独立恢复连接时不重启唯一远程入口。当前需求整体仍未完成，跨网、源健康P1、缺音频状态/H264 SDP、长时和完整候选门禁继续开放。


### 12.11 Windows 动态画面与 GPU 共载短测（2026-10-30 18:02）

在既有Blender真实远程操作通过后，实际attempt47通过自己的原生Blender60Hz动态视图及后台Cycles/OptiX共载：65.907秒窗口内平均解码28.3278fps，60次取样画面hash均变化，相邻取样均有新帧和画面变化。门槛在运行前写入手工计划为1080p30目标下短测均值至少27fps，未按结果修改门槛。仍不代替§7要求的30分钟稳定性、受控网络和100次输入到可见反馈延迟测量。

后台自己的工厂场景实际完成12帧1024×1024、128samples OptiX渲染，用时41.84秒，禁止CPU回退、未加载用户项目或保存用户偏好；同时记录nvidia-smi GPU/encoder利用率与显存。环境为Windows build22631、Edge142.0.3595.53、RTX4090D驱动591.74。本轮原生远程Cube X0→1与Stop仍通过；GPU任务/GUI/launcher/隔离runtime/Capture五个PID清理通过，无Blender/Capture残留。

249668bytes原始证据包通过专用接收端download completed、7个成员文件hash验证，SHA256为4fa7ff9da3884bcbcf13ece63600b7ccef80fe655409c9ce66034aadd40a861b。首工作区Windows验收页已附原始逐秒取样、GPU结果和清理/版本记录。未将此短测写成完整候选或游戏体验的发布结论。该时点Mac新盘访问诊断仍待现场恢复，后续恢复实测见12.12。

### 12.12 Mac 新盘授权后访问恢复（2026-10-30 18:22）

用户批准命令行系统提示后，Mac重新在线。先核对旧回执external-disk-platform-3.json，原SDD请求为6007ms客户端超时，未盲目重放；原生ls恢复exit0后，再通过真实公开Client连接原Stable daemon读取/Volumes/SDD，13ms成功返回系统隐藏目录，随后/Volumes请求9ms成功。诊断浏览器已关闭、Node25560已退出，后续远程命令正常，原Stable daemon13817始终未重启，版本仍0.16.0。

原始回执external-disk-platform-4.json通过接收端专用下载completed，1219bytes，SHA256=d76c3628729fd0d4186e4bd3a1278862c80d30e08e30f4e7a8326ad3fbbe2c39，接收后复算一致。证据保存在dev-4状态库的mac-external-disk-access-20261030任务内；首工作区preview/machine-validation/mac-disk-assessment.md更新为恢复结果。全程未重置或重新申请Capture授权、未改新盘文件/挂载/权限、未更新或重启daemon。

当前不再把新盘目录访问列为待用户授权阻塞。系统提示批准与恢复的先后关系、此前可移动卷TCC记录支持OS文件访问许可的解释，但没有最终TCC决定或daemon现场sample，不把完整根因链写成已证实。实际验证仅限目录读取，未做写入、项目创建、任意子目录、跨重启或未来升级验收。同步目录IO的调度/取消风险未修复，iOA跨网限制和远程桌面其余验收缺口继续保留。

### 12.13 源采集健康、音频状态、H.264 协商与关闭顺序（2026-10-30 晚）

收敛此前列为合入阻断的 P1/P2，均在 Capture 自己的原生接缝解决，不新增 broker、权限框架或 SDK。

- **有效画面判定（R3）**：对固定上游做三处精确计数的补丁（`prepare.py`，补丁版本 `…-repeat/4`）：`EncodedFrame` 增加 `repeat`，Windows/Mac 会话在输出时按引擎自己已有的 `resend` 事实填写。上游把"静止地板/细化/光标重绘"都标为 resend，因此 Capture 用引擎的说法区分"新的桌面采集"和"同一张旧画面再编码一次"，而不是猜时间戳。`View.health` 记录两类计数；`frame_live()`（授予控制、接收输入的前提）新增"至少有过一次真实采集"。仅有重复帧不能证明源端存在，也不能授予控制。已有的上游行为保持：地板帧由采集循环产生，循环出错会结束会话。会话期间桌面被锁定、被 UAC/安全桌面接管、显示器变化，`target_live()` 在 Windows 检查会话锁与输入桌面名，在 Mac 检查 `CGSSessionScreenIsLocked`、控制台会话与显示器休眠（Mac 之前缺这一检查，锁屏时仍报 available；已在锁屏的真机上验证现在返回 `desktop_unavailable`）。
- **残余边界**：采集循环对 DXGI 的"超时"与真正静止无法区分，这是上游设计；本实现不声称能发现这种静默卡死，只保证它不会冒充"首帧前"或"锁屏/安全桌面"。
- **音频状态（R5）**：新增原生 ABI 5 的 `gh_capture_audio_status`，使用引擎会话 `info().audio` 与其"streaming silent"告警文本（有界、仅此一行）。`/state`（及会话 WS `state.get`）、`media.status` 事件和 H5 页面 `#source` 显示"源端无可用声音输出（原因）"，不再只显示已连接。
- **H.264 协商（R8）**：SDP `profile-level-id` 由配置的尺寸/帧率/码率按 H.264 Table A-1 推导（42e0 + level，替代固定 42e01f）；webrtc-rs 匹配只比较 profile 与 constraint，不比较 level。首个关键帧的 SPS 被解析（profile、level、裁剪后尺寸），profile 不是 Baseline 就拒绝发送并关闭会话 `h264_profile_mismatch`；level 超出所宣称时记录并在状态中标明 `levelWithinAdvertised:false`，不静默吞掉。实测 SPS 见下面真机记录。
- **关闭顺序**：`View::close` 的第二个调用者此前遇到已在关闭即返回，应用停机因此可能在第一次关闭（含输入守护释放确认）完成前退出。现在后到者等待首个关闭完成（最多 8 秒）。
- **测试**：Capture 纯规则单元测试 5 项（SPS/level/重复帧不算采集/音频事实）注册为 `specialty.preview.capture-source-health-units`；H5 新增 `media.status`/`session.closed` 原因回归；source-off 专项断言无会话时 `source` 为空。
