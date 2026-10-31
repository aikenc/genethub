# 离屏应用：游戏和 DCC 的远程预览

用户要在预览里**看、玩**一个由 Agent 改过的游戏或场景，而软件可以离屏运行（不需要桌面窗口、锁屏也能工作）时读本页。需要在真实桌面窗口里点软件界面，或软件无法离屏，才用[远程桌面](remote-desktop.md)。

## 怎么接

不新建组件。用 `assets/python-adapter/run.py`（与 `app.py` 同一个目录、同一份 `requirements.txt`，需要 Python 3.11+ 和 aiohttp：平台自带的 Python 不装包，先 `$GENEHUB_PYTHON -m venv .venv && .venv/bin/pip install -r python-adapter/requirements.txt`，Windows 用 `.venv\Scripts\`；不需要 Node）一次启动并登记整个应用：`python run.py --config application.json --daemon-root <dataDir>`。配置就是 `application.json`：

- `backends[]`：按 argv 启动的进程，整棵进程树随运行器一起终止，任一进程退出则整个运行结束。
- 有 `origin` 的后端参与路由和健康检查；**没有 `origin` 的后端只被启动和监控**（例如游戏进程本身）。
- 路由 `maxViewers: n`（1–16）：同一路由同时只让 n 个 WebSocket 观看者进入；多出的得到 close 1013 `viewer_limit`。要“一个实例一个玩家”就设 1。
- 运行器在 `readyTimeoutMs`（上限 300 秒）内等所有有 `origin` 的后端 `health` 通过。

撤销就是在预览里停止服务访问：页面不再有桥可用，已有的 WebSocket 关闭、占用的观看者名额释放；用户重新允许后页面重新加载并可再连。

## 引擎自带串流（UE 5.4）：`assets/unreal/`

用于要**玩**的游戏。画面和输入走引擎自己的 WebRTC，运行器只转发信令。

1. 信令服务用随示例带的 `assets/unreal/signalling.py`（Python，UE 5.4 协议，只依赖 aiohttp），**不需要 Node，也不需要下载 Epic 的 `PixelStreamingInfrastructure`**。`application.json` 里的 `python` 命令表示运行器自己的解释器。
2. 工程启用 `PixelStreaming` 插件（`.uproject` 的 `Plugins`）。
3. 复制 `assets/unreal/` 到工作区，改 `application.json` 里三处路径：信令目录、`UnrealEditor.exe`、工程与地图。
4. 页面入口 `index.html` 与 `pixelstreaming.esm.js` 放在工作区入口目录。
5. 登记 `media` 用 `client:"html"`、`protocol:"pixel-streaming/1"`、`sessionPath` 指向信令 WebSocket 路由（见示例）。这会让沙箱允许指针锁定和自动播放，并给页面 `window.genehubServicePreview.describe()/ice()`。没有控制权开关：允许服务就是允许玩。
6. 启动：`-game -RenderOffScreen -PixelStreamingURL=ws://127.0.0.1:<信令端口>`，直接读未 cook 内容。冷启动（shader 与缓存为空）实测约 4 分钟，之后约 20 秒；首次使用前先预热一次。
7. 页面用平台的 ICE 替换信令下发的 `iceServers`（示例 `index.html` 已做）；跨网络需要用户在预览工具栏允许媒体中继。

Agent 改工程不需要桌面：`UnrealEditor-Cmd.exe 工程 -run=pythonscript -script=脚本.py -unattended -nullrhi`（保存资源实测约 20 秒），改完重启后端，预览入口不变。

## 后台渲染预览（Blender）：`assets/blender/`

用于 Agent 改场景、用户换角度看效果。`blender -b 场景.blend --python blender_server.py` 启动一个无界面 Blender，里面只开一个本机 HTTP 服务：`/state`、`/frame?az=&el=&zoom=&frame=&w=` 返回 JPEG；请求里只有五个数字，不执行任何请求内容。页面拖动旋转、滚轮缩放、拖时间轴，每次按需渲染一帧（默认 EEVEE，实测默认立方体约 0.2–0.5 秒/帧；Mac 的 Cycles 首次编译 Metal 内核约 80 秒）。这是低帧率的指令驱动预览，不是实时视口；要高质量成品另提交一次完整渲染。

## 其他引擎和 DCC

同样三件事：一份 `application.json`、一个页面、一个后端脚本（如需）。引擎自带 WebRTC 串流的（Unity Render Streaming 等）仿照 UE：信令走 WS 路由，`media.protocol` 仍用 `pixel-streaming/1` 当且仅当信令是一条 WebSocket 路由；协议不同就写成普通登记服务，自己的页面自己的路由。能离屏渲染但无串流的仿照 Blender。**Unity 等尚未实测。**

## 已验证与未验证

已验证（2026-10-31，Windows RTX 4090，真实 Preview + 本机 daemon）：见提案 `docs/interactive-offscreen-app-proposal.md` 第 10 节。# 离屏应用：游戏和 DCC 的远程预览

用户要在预览里**看、玩**一个由 Agent 改过的游戏或场景，而软件可以离屏运行（不需要桌面窗口、锁屏也能工作）时读本页。需要在真实桌面窗口里点软件界面，或软件无法离屏，才用[远程桌面](remote-desktop.md)。

## 怎么接

不新建组件。用 `assets/python-adapter/run.py`（与 `app.py` 同一个目录、同一份 `requirements.txt`，需要 Python 3.11+ 和 aiohttp：平台自带的 Python 不装包，先 `$GENEHUB_PYTHON -m venv .venv && .venv/bin/pip install -r python-adapter/requirements.txt`，Windows 用 `.venv\Scripts\`；不需要 Node）一次启动并登记整个应用：`python run.py --config application.json --daemon-root <dataDir>`。配置就是 `application.json`：

- `backends[]`：按 argv 启动的进程，整棵进程树随运行器一起终止，任一进程退出则整个运行结束。
- 有 `origin` 的后端参与路由和健康检查；**没有 `origin` 的后端只被启动和监控**（例如游戏进程本身）。
- 路由 `maxViewers: n`（1–16）：同一路由同时只让 n 个 WebSocket 观看者进入；多出的得到 close 1013 `viewer_limit`。要“一个实例一个玩家”就设 1。
- 运行器在 `readyTimeoutMs`（上限 300 秒）内等所有有 `origin` 的后端 `health` 通过。

撤销就是在预览里停止服务访问：页面不再有桥可用，已有的 WebSocket 关闭、占用的观看者名额释放；用户重新允许后页面重新加载并可再连。

## 引擎自带串流（UE 5.4）：`assets/unreal/`

用于要**玩**的游戏。画面和输入走引擎自己的 WebRTC，运行器只转发信令。

1. 信令服务用随示例带的 `assets/unreal/signalling.py`（Python，UE 5.4 协议，只依赖 aiohttp），**不需要 Node，也不需要下载 Epic 的 `PixelStreamingInfrastructure`**。`application.json` 里的 `python` 命令表示运行器自己的解释器。
2. 工程启用 `PixelStreaming` 插件（`.uproject` 的 `Plugins`）。
3. 复制 `assets/unreal/` 到工作区，改 `application.json` 里三处路径：信令目录、`UnrealEditor.exe`、工程与地图。
4. 页面入口 `index.html` 与 `pixelstreaming.esm.js` 放在工作区入口目录。
5. 登记 `media` 用 `client:"html"`、`protocol:"pixel-streaming/1"`、`sessionPath` 指向信令 WebSocket 路由（见示例）。这会让沙箱允许指针锁定和自动播放，并给页面 `window.genehubServicePreview.describe()/ice()`。没有控制权开关：允许服务就是允许玩。
6. 启动：`-game -RenderOffScreen -PixelStreamingURL=ws://127.0.0.1:<信令端口>`，直接读未 cook 内容。冷启动（shader 与缓存为空）实测约 4 分钟，之后约 20 秒；首次使用前先预热一次。
7. 页面用平台的 ICE 替换信令下发的 `iceServers`（示例 `index.html` 已做）；跨网络需要用户在预览工具栏允许媒体中继。

Agent 改工程不需要桌面：`UnrealEditor-Cmd.exe 工程 -run=pythonscript -script=脚本.py -unattended -nullrhi`（保存资源实测约 20 秒），改完重启后端，预览入口不变。

## 后台渲染预览（Blender）：`assets/blender/`

用于 Agent 改场景、用户换角度看效果。`blender -b 场景.blend --python blender_server.py` 启动一个无界面 Blender，里面只开一个本机 HTTP 服务：`/state`、`/frame?az=&el=&zoom=&frame=&w=` 返回 JPEG；请求里只有五个数字，不执行任何请求内容。页面拖动旋转、滚轮缩放、拖时间轴，每次按需渲染一帧（默认 EEVEE，实测默认立方体约 0.2–0.5 秒/帧；Mac 的 Cycles 首次编译 Metal 内核约 80 秒）。这是低帧率的指令驱动预览，不是实时视口；要高质量成品另提交一次完整渲染。

## 其他引擎和 DCC

同样三件事：一份 `application.json`、一个页面、一个后端脚本（如需）。引擎自带 WebRTC 串流的（Unity Render Streaming 等）仿照 UE：信令走 WS 路由，`media.protocol` 仍用 `pixel-streaming/1` 当且仅当信令是一条 WebSocket 路由；协议不同就写成普通登记服务，自己的页面自己的路由。能离屏渲染但无串流的仿照 Blender。**Unity 等尚未实测。**

## 已验证与未验证

已验证（2026-10-31，Windows RTX 4090，真实 Preview + 本机 daemon）：见提案 `docs/interactive-offscreen-app-proposal.md` 第 10 节。**跨网络限制：** 页面只把平台 ICE 换进浏览器一侧；`signalling.py` 发给 UE 的配置没有 STUN/TURN（UE 自身的默认值没有核实）。所以现在只能说在浏览器与 UE 机器同一局域网（或 UE 机器可被直接访问）时可靠；浏览器在别的网络、UE 机器在 NAT 后面，需要先把 TURN 配到 UE 一侧，目前没有这一步，也没测过。未验证：锁屏下的 UE、跨网络与强制中继、手柄、有声游戏、30 分钟稳定性、Safari/手机。
、跨网络与强制中继、手柄、有声游戏、30 分钟稳定性、Safari/手机。
