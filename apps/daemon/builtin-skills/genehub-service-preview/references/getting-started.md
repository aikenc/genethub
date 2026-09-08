# 启动与分享登记服务

## 确认运行环境和源码

内置包携带本 Skill 和参考文档；这里没有 runner、Node 依赖、Python 环境、模型权重或创作软件。不要在 Skill 旁寻找 `scripts/run.mjs`。

优先使用已有的兼容 GeneHub 源码。没有时，在已授权搭建范围内获取[官方源码](https://github.com/aikenc/genethub)，选择与目标安装版本兼容的发布标签或提交并记录版本，不用最新 main 盲目替换旧安装。核对源码中的以下路径：

- `packages/service-preview/run.mjs`、`package-lock.json`：runner 与依赖锁。
- `examples/service-preview/application.json`、`index.html`、`backend.mjs`：HTTP/WS 连通性基线。
- `examples/service-preview/media-application.json`、`media.py`、`requirements.txt`：原生媒体连通性基线。
- `docs/service-preview.md`：维护者架构、能力现状及验证说明。

这些路径相对于**源码根目录**，不是安装后的 Skill 目录。缺少文件或 daemon/host/Workbench 版本不兼容，属于运行前提未满足，不能归因为模型或创作软件失败。

从实际安装或启动配置确认目标 Channel 的 daemon 私有数据目录。需要 CLI 查询时使用内置目录/`GENEHUB_CLI` 提供的准确绑定并查看帮助；不猜 Channel 命令、数据目录或 `preview register` 子命令。当前通过 runner 登记。

## 先建立可复用的连通性基线

需要 Node.js 22+。在确认的源码根目录安装锁定依赖：

```sh
npm --prefix packages/service-preview ci
```

把 HTTP/WS 示例的 `index.html` 和 `application.json` 复制到用户源机器的工作区。把配置中的后端 `command` 改为 `["node", "/实际源码路径/examples/service-preview/backend.mjs"]`。后端脚本保留在源码树内：它通过 `../../packages/service-preview/package.json` 加载 `ws`，单独复制脚本会破坏依赖解析。先确保入口存在，再从源码根目录启动：

```text
node packages/service-preview/run.mjs --config /实际工作区/demo/application.json --daemon-root /实际目标Channel数据目录
```

替换以上示意路径，保留可停止的前台终端或进程句柄，不需要另开静态文件服务器。媒体基线把 `media-application.json` 复制到同一入口旁，在隔离 Python 3.10+ 环境中安装源码示例的 requirements，配置命令为实际解释器加源码 `media.py` 的绝对路径。实际创作软件/模型可以使用自己的环境。

在 GeneHub 打开复制的入口，点击“允许本次预览访问登记服务”，测试 HTTP、流式进度和 WebSocket。媒体使用可信面板的“连接音视频”；验证麦克风时由用户选择“启用麦克风并连接”。同一入口的 HTTP 配置和媒体配置是两次独立运行，切换前先停止上一份。示例页面的 HTTP 按钮调用 `/api/demo/`，媒体配置只登记 `/api/media/`，因此媒体基线应操作可信媒体面板，或按实际路由修改页面。

这些测试图案/状态只验证基础传输。随后按[创作过程接入](creative-workflows.md)换成真实软件任务、产物和画面。

## 应用配置

以下是已有 `index.html` 与实现媒体契约的 `backend.py` 时可使用的配置形状，不是已提供的创作软件适配器：

```json
{
  "name": "创作过程预览",
  "entry": "index.html",
  "dataPolicy": "auto",
  "backends": [{
    "origin": "http://127.0.0.1:18011",
    "command": ["/实际环境/bin/python", "backend.py"],
    "cwd": ".",
    "health": "/health",
    "routes": [{"prefix": "/api/media/", "websocket": false}]
  }],
  "media": {
    "offerPath": "/api/media/offer",
    "stopPath": "/api/media/stop",
    "microphone": "none"
  }
}
```

- 使用实际平台的解释器路径，Windows 环境的目录结构不同。`entry` 与后端 `cwd` 相对于配置文件；`command` 是 argv，不是 shell 字符串。后端环境变量用 `env`，秘密不写入版本管理中的配置。
- 一次运行允许 1–8 个后端，每个 origin 只能是 `http://127.0.0.1:端口`。后端必须按配置监听并保持前台；端口占用时拒启，不结束无关进程来让路。
- `health` 必须留在该 origin，返回成功 HTTP 状态且不重定向。就绪期限默认 120 秒，`readyTimeoutMs` 最长 300 秒；更慢的应用需明确启动设计，不能假报就绪。运行后没有持续的应用健康检查。
- 路由前缀是唯一的小写 `/api/.../` 且以 `/` 结束，优先使用不重叠的前缀。`/api/media/offer` 会去掉前缀后转到后端 `/offer`。需要 WS 才声明 `websocket: true`。
- 只有 HTTP/WS 的应用不必声明 `media`。麦克风仅支持 `none` 和 `webrtc`，后端实际消费输入音轨时才使用后者。
- `iceServers` 可配置自托管 STUN；媒体 TURN 由配对 Channel 在用户选择中继后提供，不在应用配置中保存 TURN 秘密。

## 前端入口与运行期限

分享实际存在的普通入口文件，例如 `[过程预览](demo/index.html)`，路径相对于当前工作区根。每个被预览文件不超过 64 MiB。文件链接只打开入口，不授予服务权限，也不发布独立网站。

远程查看者需要已验证的 GeneHub Web/Relay 地址或应用入口、源机器选择、工作区/入口，以及配对和 `services` 权限。查看端 localhost 不是源机器，文件链接也不是匿名公网云游玩地址。不要根据 Channel 名猜域名或编造 `/assets/preview/...`。

当前没有统一登记服务列表。打开登记 HTML 后才能看到服务名称、数据路径策略及授权按钮；授权后显示媒体控制。另有“工具 → 全局 → 此电脑的后台进程”，但它面向会话进程，不是服务目录，不能据此判断所有运行都已登记或已结束。

停止 runner 或任一受管后端退出，会注销整次登记。“暂停服务访问”只关闭当前页面的访问，“停止”媒体只释放该媒体会话，二者都不等于停止 runner。结束应用应对所拥有的 runner 使用 Ctrl+C / SIGTERM 并验证子进程及登记回收。新运行有新身份，必要时重新打开/授权入口；不要承诺永久在线、自动恢复或未经测试的多查看者隔离。

## 分层排障

| 现象 | 检查与恢复 |
|---|---|
| 没有服务工具栏 | 目标版本、规范化入口路径、runner 就绪、Channel 数据目录、源机器和工作区 |
| 权限不足 | 配对设备具有 `services`，用户已授权当前入口；已有窄授权不会自动扩大 |
| 已登记或端口占用 | 确认所有者，停止所需的旧运行后重试；确认旧运行与子进程已退出才能清理私有陈旧记录 |
| 就绪超时 | 实际命令、cwd、端口、health；查看脱敏启动错误并修正后端 |
| 路由失败 | 前缀与去前缀规则、WS 开关、支持的头和取消；不自动重试写操作 |
| HTTP 可用但媒体失败 | 按媒体契约检查真实收帧与 ICE，信令成功不代表媒体可达 |
| 面板为空但软件仍在运行 | 进程归属和平台枚举限制；通过所持运行句柄确认，不把空列表当成全部退出 |
