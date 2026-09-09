---
name: genehub-service-preview
description: 为内容工作者搭建、登记、诊断和分享创作过程预览。用户要求可预览时，先复制 python-adapter、用 GENEHUB_CLI daemon status 取 dataDir、启动登记，然后在聊天里给出工作区入口 HTML 链接让用户直接点开；不要只写架构，也不要把用户赶到后台进程里找「打开预览」。用于影视剪辑与合成、DCC 建模/材质/动画/仿真、游戏引擎运行与交互、数字人制作和实时驱动，以及这些流程需要的本地 HTTP/WS 服务和原生 WebRTC。纯静态 H5、相册和文件预览使用 genehub-html-preview。
---

# GeneHub 创作过程与服务预览

面向内容工作者，交付能观察当前创作状态、检查阶段产物或操作运行中工具的真实入口。影视软件、DCC 工具、游戏引擎是主要应用类别；数字人属于其中跨建模、动画、渲染和实时驱动的一类工作流，不是这项能力的总称。

用户说「搭建预览」「对接预览」「可预览」时，**先落地一条能点开的入口**，再替换成真实管线。不要先写长文，也不要把用户赶到进程列表里找按钮。

## 先做这 6 步

数字人、UE、DCC 都走同一条落地顺序。细节文档放在后面按需读。

1. **判断路径。** 只要阶段文件、相册、静态页 → `genehub-html-preview`。要本机后端、麦克风、原生 WebRTC、引擎/数字人画面 → 继续本 Skill。
2. **取 daemon 数据目录，不要猜路径。** 只用系统给出的 `GENEHUB_CLI`：

   ```text
   "<GENEHUB_CLI>" daemon status
   ```

   把返回的 `dataDir` 当作 `--daemon-root`。不要手写 `AppData\Roaming`、`LocalAppData` 或 Linux 家目录变体。
3. **复制本 Skill 自带示例到用户工作区**（不要在 Skill 目录装依赖或写产物）。Skill 目录就是系统提示里的 `location` 所在文件夹：

   - `assets/python-adapter/` → 工作区 `preview-adapter/`
   - `assets/demo/index.html` → 工作区入口 HTML（项目已有合适入口则沿用；必须是普通静态文件）
4. **启动登记。** 在工作区虚拟环境安装 `preview-adapter/requirements.txt` 后运行（路径换成实际值）：

   ```text
   .venv/bin/python preview-adapter/app.py --entry /实际工作区/index.html --daemon-root <dataDir>
   ```

   Windows 用 `.venv\Scripts\python.exe` 和该机的入口绝对路径。登记用的 `--entry` 必须就是接下来要链接的那个 HTML。数字人/UE 的 offer 桥放在这条基线通了之后，见[数字人接入](references/digital-human.md) / [UE 接入](references/unreal-engine.md)。
5. **交付就是聊天里的入口链接。** 只链工作区里的普通 HTML，正斜杠相对路径，例如 `[预览](preview/index.html)` 或 `preview/index.html`。不链目录，不写 `E:\...`、`file://`、`http://127.0.0.1`，不编造 `/assets/preview/...` 或公网播放地址。用户点这个链接即打开预览；打开后只需在可信工具栏点 **允许本次预览访问登记服务**（`files` 不能代替 `services`）。数字人/引擎画面在预览里的 **可信媒体面板**，不在 HTML 页面当中，也不在本机 `:7860` 演示页。
6. **完成标准。** 已经写出可点的入口链接，并且 `"<GENEHUB_CLI>" process.list` 能看到适配器还在，才说「可以点开」。不要让用户去「后台运行 / 后台进程」里找「打开预览」——那个面板只用于停止应用或排障。健康接口或 SDP answer 只证明对应的一层。数字人/引擎还要说明：点开链接后在媒体面板看真实画面（或明确报告「媒体基线已通，内容管线未接」）。

## 按需阅读

- 阶段产物 vs 实时画面：[创作过程接入](references/creative-workflows.md)
- 自己写接入、不走示例：[语言无关登记与协议](references/registration-contract.md)
- 启动、授权、手机预览、排障：[启动与分享](references/getting-started.md)
- 实时音视频 / ICE / 麦克风：[媒体架构与契约](references/media-contract.md)
- 数字人制作与实时驱动：[数字人接入](references/digital-human.md)
- Unreal / Pixel Streaming / PIE：[UE 接入](references/unreal-engine.md)。当前媒体面板没有 UE 输入协议，收到画面不等于能云游玩。

## 影响实现的边界

- 入口仍是沙箱静态页面。后端使用声明的 `/api/.../` 路由；不要把查看端指向源机器的 `127.0.0.1`，嵌套软件网页，注入 GeneHub 加载器，或在入口里创建 PeerConnection、采集设备。
- 用户在可信工具栏开启服务访问。麦克风与可选媒体中继由用户在可信面板操作，Agent 不伪造手势或向页面复制凭证。
- `dataPolicy: "direct-only"` 约束本服务的 Fabric 数据路径；媒体是否允许 TURN 是另一项选择。
- 应用登记对应一次运行。不要假定能接管用户已经打开的 DCC/编辑器。不要手改私有登记来冒充可用应用。
- 已授权的搭建任务可以继续必要的本地工作。公网托管、付费资源、上传用户媒体或修改驱动/系统安全设置需要相应授权。

## 交付说明

**第一条就是可点的入口 HTML 链接。** 再补充 Channel、`dataDir` 来源、停止方式（需要时再到「此电脑的后台进程」停应用）。区分阶段产物与实时画面、参考图案与实际内容、观看与操作、本机与跨网结果。
