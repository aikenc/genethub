# 启动、发现与手机预览

## 选择接入方式

GeneHub 本体不要求 Node 或 Python。外部程序可按[语言无关接入协议](registration-contract.md)直接登记；下面两个目录只是随 Skill 携带的可选源码示例。先复制到用户工作区，**不要在内置 Skill 目录安装依赖或写运行产物**，也不需要下载 GeneHub 工程。

- [Python 直接接入示例](../assets/python-adapter/app.py)：单程序实现登记、认证、HTTP/WS 和可选视频文件的 WebRTC 播放，无 Node 依赖。需要 Python 3.11+；基础依赖为 aiohttp。
- [Node 多后端适配示例](../assets/node-adapter/run.mjs)：可选启动器，适合现有 Node 工作流，读取 application.json，前台管理多个后端。需要 Node 22+；其 ws 依赖仅属于该示例。
- [入口 HTML](../assets/demo/index.html)：复制到工作区，演示 HTTP、流式进度与 WS。真实程序替换相应业务输出。

用系统提供的 `GENEHUB_CLI` 取目标 Channel 的数据目录，不要猜路径或子命令：

```text
"<GENEHUB_CLI>" daemon status
```

返回 JSON 里的 `dataDir` 就是 `--daemon-root`（其下的 `service-previews/` 由适配器写入，不要手改，也不要在聊天里贴登记内容）。

## Python 路径：无需 Node 或产品源码

把整个 `assets/python-adapter/` 复制成工作区的 `preview-adapter/`，将示例 HTML 复制成工作区 `index.html`。在用户认可的 Python 环境中安装依赖；推荐项目独立虚拟环境。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r preview-adapter/requirements.txt
.venv/bin/python preview-adapter/app.py --entry /实际工作区/index.html --daemon-root /实际目标数据目录
```

Windows 使用相应的 `.venv/Scripts/python.exe`。上述路径是示意，按实际目录替换。

已有视频可直接走文件预览；需要验证实时媒体契约时，可安装 `media-requirements.txt`，给示例增加 `--video /实际视频路径`。此时用可信面板连接音视频，Python 程序消费传入 ICE 配置并发送该视频。它不运行数字人模型。

将示例 `http_response` 与媒体输出替换成实际内容软件的插件/API/画面。测试回声、测试图案不等于 DCC 或游戏适配已验收。

## 可选 Node 路径

将整个 `assets/node-adapter/` 与 `assets/demo/` 并排复制到工作区，保留相邻目录关系。两者现在是可独立复制的示例，不引用 GeneHub 源码树。

```sh
npm --prefix node-adapter ci
node node-adapter/run.mjs --config demo/application.json --daemon-root /实际目标数据目录
```

根据实际环境调整配置中的后端命令与端口。命令是 argv 数组，不是 shell 字符串；后端要前台运行，已有端口会拒启。该示例停止时清理自己启动的后端；不会接管用户原本打开的软件。

`demo/media-application.json` 可用于 Python/aiortc 测试图案，配置解释器为安装了 `demo/requirements.txt` 的实际环境。此路径只是可选多后端组合，不能要求所有服务采用它。

## 找到入口并体验

1. 在源机器已登记的 Workspace 中创建普通入口 HTML。不要为静态文件再起 HTTP 服务。
2. 启动应用，等待登记成功。**在聊天里给出该入口文件的链接**（例如 `[预览](preview/index.html)`），让用户直接点开。不要改口去「后台进程 / 后台运行」里找「打开预览」。那个面板只用于停止应用或排障。
3. 手机上先通过实际配置的 GeneHub 入口连接源电脑，再打开同一 Workspace 里的同一个入口文件。不要把手机指向源电脑的 localhost，不编造匿名云游玩地址。
4. 预览打开后，在可信工具栏点“允许本次预览访问登记服务”。HTTP/WS 请求由桥转发，音视频使用可信媒体面板；需要中继时由用户勾选允许媒体中继。
5. 检查真实画面、进度或业务结果；记录实际直连/中继路径。只有健康接口或 SDP 成功不能宣称播放成功。

文件访问权限不等于 Services 权限；能看预览也不自动拥有结束应用的权限。运行重启后使用“重新检查服务”，重新授权并连接新运行。

## 退出与排障

- 关闭预览：释放请求、媒体和麦克风，不停止内容软件。
- 支持应用控制的服务可在「此电脑的后台进程」请求停止；绑定 runId，旧请求不能停止新一代。
- 入口无服务：核对 Channel 数据目录、规范化入口、应用是否已登记，然后刷新。
- 服务不可达：先检查源程序和登记；不能直接认定模型失败，也不要覆盖残留记录。
- 媒体失败：区分权限、安全上下文、信令和 ICE；只直连模式可能跨网不可达。参见[媒体契约](media-contract.md)。
- 分享时说明源机器必须在线、应用必须运行。安装包版本、代码验证和实网手机验收分别记录。
