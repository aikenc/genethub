# 远程桌面 H5 与独立 Capture

这是 `service.preview` 的可选 HTML 媒体模式，协议名 `remote-desktop/1`。内置客户端四个普通文件在
`assets/remote-desktop/`：复制到用户 workspace 再定制。无独立浏览器 npm SDK，不在 HTML 嵌入
Preview loader，不为静态文件开 HTTP 服务。没有运行中的兼容 Capture 服务时只会显示未连接 UI。

Capture 是独立原生程序，不在 daemon 中采集。开发构建/启动见仓库 `apps/capture/README.md`。
不能假定用户已安装 Capture 或新模式已发布；先核对当前制品是否含此能力。不要自动替用户请求
系统隐私权限、打开共享或控制。macOS 权限由本机窗口引导，默认共享与控制都关。

1. 将四个文件复制到用户工程，例如 `review/desktop/index.html` 及相邻 JS/CSS。
2. 用实际入口绝对路径和对应渠道 daemon dataDir 启动 Capture。它直接实现既有 v1 登记/HMAC/HTTP/WS，
   不需要再包一层运行器。一次选定一个显示器，切换显示器要重启并重登记。
3. 用户在源机器打开本机共享；发普通 HTML 文件链接。查看端在外侧 Preview 中启用登记服务，再点击 H5 连接。
4. 需要键鼠时，源端允许控制，查看端在外侧工具栏允许本页接管，H5 再发 acquire。默认只观看。
5. 定制页面的布局、快捷键、统计、输入映射时改 workspace 副本；需要恢复时重新复制内置四个文件。

启用后页面可用：

```js
const {descriptor, controlAllowed} = await window.genehubServicePreview.describe();
const {iceServers} = await window.genehubServicePreview.ice();
// 现有 fetch / WebSocket 桥：只访问 descriptor.routes 登记的 /api/ 路径。
```

API 不暴露 daemon Client、私有登记 secret 或任意设备能力。ice 由外侧“允许媒体中继”决定；页面不能
替用户启用中继。源端真实 PeerConnection 也使用此配置。HTML mode 的普通 RTP 媒体直接到 H5，
麦克风/摄像头采集不开放。外侧停止/交还控制、控制状态与控制 WS 开关属于 Preview，不由可编辑 H5 绘制。

需要替换 Capture 实现时，保留 `service.preview` v1 私有登记与桥；公开 media 指定：

```json
{"client":"html","protocol":"remote-desktop/1","offerPath":"/api/remote/offer",
 "stopPath":"/api/remote/stop","sessionPath":"/api/remote/session",
 "controlPath":"/api/remote/control","microphone":"none"}
```

四个路径必须各不相同且在登记路由内，session/control 路由必须允许 WS。路径不允许编码变体、query、
fragment、反斜杠或点段。`media.client` 缺省的旧服务继续使用可信媒体面板，旧 offer/stop 形状不变。
完整应用协议在仓库 `docs/interactive-preview-service-protocol.md`；`remote-desktop.ts` 在
`@genehub/proto/remote-desktop`。不要把 C++ 内部采集 ABI 当成公开插件协议。

观看 WS 与控制 WS 分离；同一 WS 回答源端一次性 challenge 才续期，不能靠仍然直连的媒体保活。
控制 WS 关闭只停止控制；观看 WS 关闭释放整个会话。应用还需要独立输入守护、可靠按键状态进度、
会话/lease epoch/target generation 和真实帧呈现的校验，不能信任页面“已释放”的自报。

完整连接具有目标 OS 账号能力：源端启用后，其他已认证完整连接也可请求观看/控制；不另分 services grant。
“允许本页接管”不是每设备 ACL。当前没有自动暂停另一个正在使用 GUI 的 Agent，接管前需协调。
不要承诺任意游戏、受保护内容、手机全部输入、Linux、Pixel Streaming 或企业网必通。
本地编译或参考端媒体通过不能代替 Windows/macOS 真机输入、音频、权限与断线释放验收。

## 源端状态事实

`state.get` 与 `/api/remote/state` 在有观看会话时带 `source`：`state`（`starting` 尚无真实采集、`live`、`idle` 桌面静止）、`realFrames`/`repeatFrames`、`video`（profile/level/尺寸、是否在宣称 level 内）、`audio`（`available`/`unavailable`+原因）。同样的内容每 2 秒通过 `media.status` 事件推送，参考页面据此显示"等待源端首帧"和"源端无可用声音输出"。没有真实采集之前，Capture 不授予控制；锁屏、安全桌面或显示器变化会关闭会话并给出原因（`session.closed` 的 `reason`）。
