# 媒体架构与适配契约

## 三条独立路径

```text
工作区入口/阶段文件 → Asset Preview 沙箱
沙箱 /api/.../ 或可信面板信令
    → 授权服务客户端 → GeneHub 加密数据面
    → daemon → 身份校验后的本地 runner → 声明的 loopback 后端
可信 Workbench 媒体面板 ↔ WebRTC 音视频 ↔ 应用媒体端
                                 ↕
                         可选的 Channel TURN 中继
```

daemon 按规范化 HTML 路径关联登记。每次运行有新身份和秘密，daemon/runner 双向证明运行身份，避免端口复用继承旧授权。页面拿不到私有登记材料或 daemon Client。runner 负责可信应用编排，不提供针对恶意后端的 OS 隔离。

静态沙箱保持不透明源，不能采集设备或嵌套其他应用页面。HTTP/WS 桥不会自动兼容 cookie、OAuth 导航、自定义头或任意软件网站。媒体在沙箱与 Fabric Relay 之外传输；信令和业务仍走既有加密数据面。TURN 转发加密媒体包，GeneHub 不负责应用媒体转码，也不自动采集源机器的桌面或 DCC 视口。

## HTTP/WS 接口

用普通 fetch / 支持范围内的 WebSocket 调用声明的 `/api/.../` 路径。只转发登记的 loopback 路由，不能逃逸路径，不跟随重定向。HTTP 请求体最多 8 MiB，单个桥包最多 256 KiB。允许的请求头是 `accept`、`content-type`、`range`、`if-none-match`、`last-event-id`；不转发 cookie、Authorization 或任意自定义头。软件后端需要的凭证保留在应用适配器一侧。

流式响应支持背压和取消。WS 支持文本、ArrayBuffer、有界缓冲和正常关闭，不支持 Blob send 或子协议协商。桥连接最长一小时；应用需呈现关闭状态，不能假设无限会话或自动重放写操作。WS PCM 属于应用数据，不会自动成为原生音轨。

## offer 与 stop

可信面板创建浏览器 PeerConnection 接收音视频；用户点击时可加入麦克风音轨。候选收集完成或达到 12 秒期限后，发送一次请求：

```text
POST <media.offerPath>
Content-Type: application/json
{"type":"offer","sdp":"...","iceServers":[...]}

200 application/json
{"type":"answer","sdp":"...","sessionId":"本次应用会话ID"}

POST <media.stopPath>
Content-Type: application/json
{"sessionId":"本次应用会话ID"}
```

当前契约没有独立的 trickle-ICE 端点。后端接收浏览器 offer，把传入 ICE 配置用于自己的 PeerConnection，协商兼容编解码和方向并返回可用 answer。创作软件若使用不同信令角色或逐步候选交换，适配不一定只需改端点名称。

answer 的 SDP 字符串最多 256 KiB，同时要遵守 HTTP/桥限制。线上形状中 `sessionId` 可选，但当前面板仅在取得不超过 128 字符的字符串 ID 时调用 `stopPath`。实际应用应同时提供非空 ID 与停止端点。停止应幂等且只作用于该会话，释放所属音轨、编码、推理、队列与 GPU 资源。

停止通知只能尽力送达。后端还需回收失败或遗弃的连接，包括 answer 未送达查看端的 offer。不能只依靠客户端 stop 回收资源。参考后端限制会话数和期限，实际应用应选择并验证自己的上限；共享创作软件进程与每位查看者的媒体会话需分开管理。

## ICE 与中继

默认使用 STUN/host 候选并拒绝 relay 候选。配置来自所属 Channel 或私有自托管 STUN；配置不可达时保留 host 候选，不偷偷改用第三方公共 STUN。

用户可以在连接前勾选“允许媒体中继”，然后从配对 Channel 获取短期 TURN 凭证。双方实际媒体端都要消费该 ICE 配置。勾选允许中继并不强制走中继，只有选中候选对才能证明使用了 TURN。没有可用凭证时面板报错，不用硬编码凭证或另找公共中继绕过。

`dataPolicy: "direct-only"` 拒绝本服务的 Fabric 数据路径，`auto` 使用通常数据选路；二者都不决定媒体路径，也不改变其他功能。聊天正常或 offer 成功不能证明应用媒体端口可达。当前文档描述的是 UDP STUN/TURN，不能承诺 TURN/TLS 443 或企业网必通。

## 验证与恢复

1. 先证明后端就绪和信令交换，再检查媒体。
2. 看见真实持续变化的帧和预期音频，PeerConnection 连接状态不够。自动播放策略限制声音时检查用户播放操作。
3. 记录实际直连/中继候选类型、RTT、首帧与持续播放，不记录原始 SDP、凭证或用户音视频。
4. 需要麦克风时由用户操作可信面板，并证明应用实际消费输入；麦克风指示灯不能代替内容处理结果。
5. 停止、切换入口、重连，确认采集状态消失且后端会话回收。面板会关闭持续断连的连接，后端仍需独立处理失联。
6. 单独验证所需远程网络。本机/局域网成功不证明蜂窝或企业网可达；仅直连失败应明确报告，不能偷偷启用 TURN。

有产品源码的维护者通过工作区测试流程使用 `testctl`：`specialty.preview.registered-service-http-ws`、`specialty.preview.channel-ice-credentials`、`specialty.preview.native-browser-media`。浏览器用例需要 Playwright Chromium 和真实 aiortc 环境；依赖缺失是 blocked。这些用例验证参考行为，不代替实际影视/DCC/引擎或数字人任务验收。
