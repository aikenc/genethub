# Service Preview runner

从工作区启动并登记一次前台运行。HTTP/WS 由受控 loopback 适配器连接，原生媒体保持 WebRTC。

```sh
npm --prefix packages/service-preview ci
node packages/service-preview/run.mjs --config /absolute/application.json --daemon-root /absolute/daemon-data
```

`--daemon-root` 必须是目标 daemon 本 Channel 的实际数据目录，不能使用工作区目录。
应用配置中的 `entry` 与 `cwd` 相对于配置文件；后端命令是 argv，不是 shell 字符串。
每个后端必须前台运行、只监听配置的 loopback 端口，任何子进程退出就注销整次运行。
数据目录下 `service-previews` 的私有记录绑定入口和随机运行身份；不把记录复制进工作区。

打开登记的入口 HTML，在可信工具栏授权服务访问。文件读取权限不自动获得 `services` 权限。
API 以 `/api/.../` 前缀登记，去掉前缀后转发到对应后端；只支持声明的路由。
HTTP 支持有界请求、流式响应与取消；WS 支持文本/ArrayBuffer、正常关闭，尚不支持子协议和 Blob send。
API 不跟随重定向，不转发 cookie/Authorization，不自动重试写操作。

`media.offerPath` 的后端接收 `{type:"offer",sdp,iceServers}`，返回 `{type:"answer",sdp,sessionId?}`。
`media.stopPath` 接收 `{sessionId}`；应及时释放媒体与 GPU 会话。
`media.microphone` 目前支持 `webrtc` 或 `none`；WS PCM 输入需专门适配，不会把任意语音服务冒充兼容。
麦克风在可信面板通过用户点击授权，沙箱拿不到音轨或凭证。

`iceServers` 可配置自托管 STUN；否则从所属 Channel 获取。允许 TURN 时从已配对 Control 申请短期凭证。
后端须消费传入的 ICE 配置。`dataPolicy:"direct-only"` 拒绝服务业务走 Fabric；其他 GeneHub 功能的策略独立。

连接示例见 `examples/service-preview`。先运行 HTTP/WS 示例；原生媒体示例需要独立 Python 环境安装
其中 requirements，输出移动图案与测试音，不是数字人模型。替换真实后端时保持相同 offer/stop 契约。
停止 runner 后旧登记失效；若上次被强杀，确认对应 runner 已不存在后手工删除私有陈旧记录。
