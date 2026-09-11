# Unreal Engine 过程预览与云游玩

UE 是[创作过程接入](creative-workflows.md)的一类软件，不是 Service Preview 的唯一场景。先区分需求：

| 需求 | 必须证明的事实 |
|---|---|
| 看 UE 运行效果 | 指定实例输出真实画面/音频，媒体可达且能回收 |
| 远程操作游戏 | 观看之外，还要验证键鼠/触摸/手柄、焦点和断连处理 |
| 编辑器/PIE 中预览或游玩 | 明确 UE 版本和运行模式，实测对应编辑器/视口，再验收观看/操作 |

当前 `ServiceMediaPanel` 只协商音视频和可选麦克风，没有 Pixel Streaming DataChannel 输入、指针锁定/手柄控制或内置 UE 适配器。GeneHub 数据面 DataChannel 是另一种传输，不等于 UE 输入。收到视频不能标成云游玩。

## 版本依据

确认已安装 UE 版本、Pixel Streaming 或 Pixel Streaming 2 插件、工程、编码器/GPU 与对应 Infrastructure 分支。使用目标版本的 Epic 官方文档；下面是查阅入口，不是对所有版本的兼容承诺：

- [Pixel Streaming 入门](https://dev.epicgames.com/documentation/en-us/unreal-engine/getting-started-with-pixel-streaming-in-unreal-engine)：区分打包应用和 Standalone Game，不推广到所有 PIE 模式。
- [编辑器串流](https://dev.epicgames.com/documentation/en-us/unreal-engine/pixel-streaming-in-editor)：描述独立的实验性编辑器串流路径，需核对目标版本和实际视口行为。
- [官方 Pixel Streaming Infrastructure](https://github.com/EpicGamesExt/PixelStreamingInfrastructure)：选择与 UE 匹配的分支/版本，检查实际信令和前端输入协议，不因 master 最新就直接使用。

## 适配工作

先用匹配版本的 Epic 播放器证明所选本机 UE 实例能观看/操作，记录版本、插件、运行模式和命令。交给 runner 管理的后端需要先停止旧基线；runner 拒绝已占用端口，不会自动接管已经运行的服务。用户已有编辑器的所有权与未保存内容按通用创作过程规则处理。

GeneHub 观看适配遵循[媒体契约](media-contract.md)：浏览器通过 HTTP 发一次 offer，期待 answer。核对所选 Pixel Streaming 的信令角色、候选交换、编解码与会话生命周期，不能假设它的 WS 信令服务器接受这种 HTTP 格式。适配需协调双方并把 ICE 配置应用到真实 UE 媒体端；如果实际需要终止媒体并重新编码，要说明新增延迟和资源开销，在应用后端实现。

云游玩还需实现查看端输入与引擎协议。当前可信面板没有加载任意 Pixel Streaming 前端的扩展槽；可能需要 GeneHub 产品层补充授权输入采集、协议版本、焦点、断连释放按键、触摸/手柄、控制权和有界背压。HTTP/WS 控制适配可以承载明确的应用操作，但不能自动替代完整游戏输入。不能向可信面板注入引擎脚本或放宽静态沙箱来绕过缺口。

用户选择 Epic 独立播放器时，将其视为独立应用/部署，提供实际验证的地址和访问控制；不要嵌入 Asset Preview 或宣传为已存在的 GeneHub 原生集成。公网托管和永久在线需要相应授权与部署。

## 验收

确认指定场景在所需模式运行，持续收到画面/音频，记录媒体路径与 RTT。游玩需实测输入产生正确动作、失焦不粘键、断连释放控制、重连回到正确实例。PIE 必须验证用户指定的编辑器模式，Standalone Game 成功不证明视口内 PIE 支持。

停止媒体后验证每位查看者的会话回收，再停止所拥有的 runner 和后端进程树。启动器退出、已有编辑器或独立脱离的 UE 进程不一定属于 runner，需说明所有者和停止方式。交付入口/地址、访问前提、源机器运行期限及剩余工作；未验证输入或 PIE 时，该部分仍未完成。
