# 离屏应用的远程预览与游玩：沿用现有服务运行器的最小方案

- 状态：第 1 期已实现并在 Windows RTX 4090 上用真实 Preview 验证（见第 10 节；运行器为 Python 版）；锁屏已实测通过、UE 一侧已接入平台 ICE（第 11 节）；跨网络媒体受平台 TURN 只有 UDP 所限，待基础设施决定（§11.3）
- 日期：2026-10-30
- 适用范围：GeneHub Service Preview、`genehub-preview` Skill、在内置 Python 适配器旁新增 `run.py` 服务运行器；首批适配 Unreal Engine 5.4.4（游玩）与 Blender（Agent 驱动的预览），之后可接入任何支持离屏渲染的软件
- 事实基线：`main` 的 `baae72ae`（含远程桌面 Capture）；UE 实验在 PC-4090-1（RTX 4090 D、驱动 591.74、Windows 11、Edge 142 无头）上完成
- 关联：[远程桌面提案](remote-interactive-preview-proposal.md)（桌面抓取路径，本提案不改动它）

## 1. 摘要与建议

**问题。** GeneHub 的用户是游戏和重度创作从业者，Agent 会不停改工程或场景。他们要随时看、玩 Agent 刚改完的结果，而不是看截图。能离屏渲染的软件很多（UE、Unity、Blender，以后还有更多），不应该每接一个就重写一遍启动、授权、清理。

**先说结论：不需要新的平台组件、新的清单格式或新的权限模型。** 产品内置的是 Python 运行环境，不是 Node。`genehub-preview` 里原有的 Node 示例运行器（549 行）已删除，由 Python 版取代 [`python-adapter/run.py`](../apps/daemon/builtin-skills/genehub-preview/assets/python-adapter/run.py)（沿用 `app.py` 的登记与认证协议，约 300 行）。它是一个通用的服务运行器：按 argv 启动一个或多个后端、检查端口、等健康就绪、整棵进程树终止、登记到 Service Preview、代理 HTTP 和 WebSocket。它的配置（`application.json`）就是清单。Pixel Streaming 的信令服务（HTTP + WebSocket）本身就是这样一个后端。

软件之间真正的差别只有两处，都已经是现有扩展点：

| 差别 | 放在哪里 |
| --- | --- |
| 后端是什么 | `application.json` 的 `backends`：UE 是"Epic 信令服务 + UE 进程"，Blender 是"一个 Python 脚本，在无界面 Blender 里自己开 WebSocket 服务" |
| 页面怎么显示、怎么发输入 | 一个可编辑的 H5：UE 用 Epic 前端（固定版本）；Blender 用一个"帧查看器 + 相机/时间轴控件" |

没有"适配器种类"、没有"视口适配器接口"、没有租约。以后接新软件 = 一份 `application.json` + 一个 H5 + 一个后端脚本（如需）+ 一页文档，Agent 照着 Skill 就能做。

**本期要改的只有四处**（§5）：运行器支持"无 HTTP 端口的后端"、WebSocket 路由加"单观看者"上限、固定版本的 UE 前端和 Blender 后端作为示例资产、Skill 文档。

**请评审的事项**：§5.3 用"单观看者 + 撤销即关信令"取代租约是否可接受；§6 分期；§8 未决问题。

## 2. 背景与用户场景

**场景 A（游戏）。** 关卡设计师让 Agent 把角色移动速度调到三倍。改完后他想立刻在浏览器里跑两步确认手感，而不是等打包。

**场景 B（DCC）。** 美术让 Agent 调整灯光和材质。他想换几个角度看看效果，不想等一次完整渲染，也不想守着一台不能锁屏的工作站。

| | 现在 | 目标 |
| --- | --- | --- |
| 看到结果 | Agent 回一张截图 | 打开预览页：游戏是实时画面和声音，DCC 是按指令刷新的低帧率画面 |
| 操作 | 无 | 游戏：键鼠（以及手柄）直接玩；DCC：环绕/推拉相机、拖时间轴等白名单指令 |
| 前提 | 需要 cook、打包或完整渲染 | 直接读未 cook 的工程 / 当前场景文件 |
| 机器 | 要有人守着、桌面不能锁 | 不依赖桌面会话（待验证锁屏） |

Pixel Streaming 的基本概念：游戏进程是"串流端"，通过一个**信令服务**（WebSocket）与浏览器交换 SDP/ICE，之后画面、声音走 WebRTC，输入经 WebRTC 数据通道回到游戏。

## 3. 现状与证据

### 3.1 已有平台能力（可复用）

- Service Preview 登记：外部程序按[登记协议](../apps/daemon/builtin-skills/genehub-preview/references/registration-contract.md)说 daemon 的认证二进制 WebSocket，声明 HTTP/WS 路由。
- 内置可编辑 H5 模式（`media.client=html`）：页面拥有自己的 `RTCPeerConnection`，经预览页 `describe()`/`ice()` 取得服务描述和平台 ICE/TURN；外侧工具栏决定是否允许接管，撤销即关闭连接。
- 沙箱页面里的 `WebSocket` 对相对路径已由桥接垫片接管（`packages/workbench/src/preview/serviceBridge.ts` 的 `ServiceSocket`），因此 Epic 前端可以把信令走到登记的路由上。
- 独立 Capture 已在 Windows/Mac 真机验证画面、声音、键鼠、断线释放。

### 3.2 UE 实验（2026-10-30，PC-4090-1）

引擎 `F:\dev\TikiStarMain_TMR\UnrealEngine`（5.4.4 源码版，只读），工程是 `Demo01_Tp` 的拷贝（原工程未动）。启动：`UnrealEditor.exe 工程 /Game/ThirdPerson/Maps/ThirdPersonMap -game -RenderOffScreen -PixelStreamingURL=ws://127.0.0.1:8888 -PixelStreamingEncoderCodec=H264 -ResX=1280 -ResY=720`。信令/前端取自 Epic 官方仓库 `UE5.4` 分支。完整数据和截图见 `spaces/release-beta/preview/ue-remote-play/README.md`。

| 观察 | 结果 | 性质 |
| --- | --- | --- |
| 未 cook 的 `-game` 能串流 | 是 | 现场复现 |
| 冷启动（shader/DDC 为空）到信令注册 | 约 3 分 49 秒 | 一次实测 |
| 热启动到信令注册 | 17–19 秒（三次） | 实测 |
| 浏览器点击到首帧 | 约 2.1–5.6 秒 | 实测 |
| 视频质量（本机回环，147 秒） | 1280×720 H.264，59.9 fps，0 丢包、0 冻结、0 丢帧，约 57.6 Mbit/s | 实测 |
| 键盘 | 按住 W 画面变化 5.2–6.6（空闲 0.4），松开回落 | 实测 |
| 断线不粘键 | 按住 W 时关页面，重连后角色静止 | 实测（仅页面关闭这一种断线） |
| 鼠标 | 默认悬停模式下拖拽不转视角；`?HoveringMouse=false` 锁定模式可转 | 实测 |
| Python 无界面编辑 | `-run=pythonscript` 把 `max_walk_speed` 500→1500，保存成功约 20 秒；重启后同样按住 W 的最大画面变化 6.7→15.7 | 实测 |
| 信令服务被强杀 | UE 保持运行，约 2 秒内自动重新注册 | 实测一次 |
| 多个观看者 | 先加入者（第六轮）和后加入者（第四轮）各自"从干净状态第一次发送输入"都能驱动游戏；信令服务不限制谁输入 | 实测，**未测同时输入**；角色走一次会撞到场景边缘，之后的画面差不可用，所以只信各轮第一次 |
| 撤销（只关信令 WebSocket，页面被阻止重连） | 视频帧数立即停止增长（停在 11），按住 W 无任何画面变化；信令服务向 UE 发出 `playerDisconnected`。浏览器端的 `RTCPeerConnection` 仍显示 connected，但 UE 已不再发送 | 实测一次。注意：Epic 前端在信令断开后**会自动重连**，所以撤销必须由平台一侧关闭并阻止重新连接 |
| 声音 | 有音频轨和 RTP 包，但该模板工程无声，能量为 0 | 有声游戏未测 |

### 3.3 没有证据的部分（不写成结论）

- 锁屏下是否可用：测试时桌面已解锁。
- 手柄、有声游戏、跨网络、强制 TURN、30 分钟稳定性、输入到画面的延迟、Safari/手机浏览器。
- 同时输入的多观看者行为。
- Mac 与 Linux 上的 UE。

## 4. 目标与范围

**目标（本期）**
1. Agent 或用户用一份 `application.json` 启动 UE 或 Blender 实例，在预览页里观看并操作，能可靠停止并清理。
2. 沿用 Service Preview 的授权与外侧撤销：撤销后画面停止、输入失效。
3. UE 与 Blender 共用同一个运行器和同一个验收脚本。
4. 接入新软件不改平台代码。

**不在本期**：编辑器/PIE 串流、多租户调度、公网永久托管、新账号或权限层、替换 Capture、Unity 等第三个软件的实际接入。

## 5. 具体方案

### 5.1 沿用什么

原 Node 示例已有、`run.py` 保留的行为：argv 启动并整棵终止进程树（Windows 用 `taskkill`）、启动前探测端口占用、`health` 就绪轮询（可调超时，上限 300 秒）、`routes` 声明 HTTP/WS 前缀、对 WS 路由的代理（保持路径）、按 runId 登记与退出清理。Pixel Streaming 的信令服务可以直接作为一个 `backends` 项。

### 5.2 需要新增或调整的（三处代码/资产，加文档）

| 改动 | 为什么 | 做法 |
| --- | --- | --- |
| 后端可以没有 HTTP 端口 | UE 进程本身不监听 HTTP，现在每个后端都必须有 `origin` | `origin` 变为可选；无 `origin` 的后端只被启动、监控和终止，不参与路由 |
| WS 路由的 `maxViewers` | 实验表明信令服务和 UE 不限制谁输入 | 路由配置 `maxViewers: 1`，第二个观看者被拒绝并得到明确错误（见 §5.3） |
| 固定版本的前端与后端示例资产（外加 Skill 文档） | Epic 的 `UE5.4` 分支前端工程依赖名写成 `ue5.5` 且在该机无法用 `npm link`/junction 构建（实验中手工复制库目录才构建成功） | 把构建好的前端放进示例资产并锁定来源提交；Blender 后端脚本同理 |

**就绪怎么判断。** 信令服务有 HTTP，`health` 立即通过；UE 自己没有健康探针，Epic 前端在串流端注册之前会显示等待状态（冷启动实测约 230 秒，热启动约 19 秒）。第 1 期不为此新增探针；首次启动前建议先预热一次。

示例配置（拟议；字段沿用现有格式，`maxViewers` 与无 `origin` 后端为新增）：

```json
{
  "name": "Demo01_Tp 第三人称",
  "entry": "ue-client/index.html",
  "readyTimeoutMs": 300000,
  "backends": [
    {"origin": "http://127.0.0.1:18081", "command": ["python", "signalling.py", "--http-port", "18081", "--streamer-port", "18888"],
     "health": "/", "routes": [{"prefix": "/api/ue/", "websocket": true, "maxViewers": 1}]},
    {"command": ["{engine}/Engine/Binaries/Win64/UnrealEditor.exe", "{project}", "{map}", "-game", "-RenderOffScreen",
                 "-PixelStreamingURL=ws://127.0.0.1:18888", "-PixelStreamingEncoderCodec=H264", "-ResX=1280", "-ResY=720"]}
  ]
}
```

```json
{
  "name": "场景预览",
  "entry": "blender-client/index.html",
  "backends": [
    {"origin": "http://127.0.0.1:18082", "command": ["{blender}", "-b", "{scene}", "--python", "blender_server.py"],
     "health": "/health", "routes": [{"prefix": "/api/blender/", "websocket": true, "maxViewers": 1}]}
  ]
}
```

### 5.3 控制权：为什么不需要租约

Capture 有控制租约、纪元号和独立的输入守护进程，是因为它向**用户的真实桌面**注入系统级键鼠：一旦释放失败，卡住的按键会留在用户的桌面上，只能靠另一个独立进程兜底。离屏应用不是这样：

- **应用是平台自己启动的进程**，输入只作用于它自己；最坏情况是终止并重启这个进程（UE 热启动约 19 秒）。
- **谁能输入由已有机制决定**：预览外侧"允许本次预览访问登记服务"已经决定页面能否连接；撤销即关闭桥。不需要再造一层。
- **撤销即关信令**（已实测，§3.2）：信令 WebSocket 一关，UE 收到 `playerDisconnected`，视频和输入同时停止。重要的是**不能让页面重新连上**：Epic 前端在信令断开后会自动重连。预览外侧关闭服务访问后页面不再有桥可用：实测撤销后 8 秒内画面一直停止，重新允许后恢复（第 10 节）。
- **一次只有一个观看者**（`maxViewers: 1`）取代了仲裁：不存在"两个人抢控制"的情况。不支持"别人观看、一人操作"；需要时是后续需求。
- **Blender 的输入是后端自己收的指令**，只有一个 WS 连接，被拒绝的指令就是不存在的指令。

**这个简化放弃了什么。** UE 路径没有"只看不能操作"的模式；允许连接即允许操作。Capture 的"允许观看但不允许控制"的区分在这里不存在。我的判断是这符合游戏试玩的场景，需要评审确认。

**仍待验证。** 撤销之外的释放路径：运行器被杀、浏览器崩溃、网络中断时 UE 是否释放按键。目前只验证了关闭页面和关闭信令两种。

### 5.4 网络与 ICE

仅对 UE 这类 WebRTC 直连的后端有意义；Blender 走预览的 WebSocket，不需要 TURN。同机回环不需要。跨网络时两端都用预览页 `ice()` 的平台配置：浏览器侧直接替换；页面再经信令把同一份服务器交给 `signalling.py`，由它在通知 UE 有新玩家前重发 `config`（§11.1）。短期 TURN 凭据随每次允许重新获取。网络是否允许到达 TURN 见 §11.3。

### 5.5 Agent 编辑与迭代

不需要平台新增运行时能力，每个软件一页"编辑配方"写进 Skill：UE 用 `UnrealEditor-Cmd.exe 工程 -run=pythonscript -script=…`（实测约 20 秒）；Blender 用 `blender -b 场景 --python …`。改完重启后端，预览入口不变；Agent 以"实例在跑、行为变了"验收，而不是命令退出 0。

### 5.6 Blender 后台渲染实验（依据）

**结论：Blender 与 UE 走同一个运行器，只是后端和页面不同；它也是目前锁屏下唯一有实测的路径。** 区分两件事：

- **Agent 驱动的预览**（改场景、调相机、看渲染结果）：`blender -b` 无界面，不创建窗口，不依赖桌面会话。
- **人在编辑界面里亲手拖拽**：需要真实窗口和桌面，只能走 Capture，锁屏下不可用。

**实验（2026-10-30）。** 脚本（工厂场景，不加载用户文件）让相机绕立方体 8 个角度，每角度渲染一张 640×360 PNG。

| 机器 | 引擎/设备 | 会话状态 | 结果 |
| --- | --- | --- | --- |
| Mac mini（M4 Pro，Blender 5.2.3） | Cycles / Metal，16 spp | **锁屏**（`CGSSessionScreenIsLocked=true`，渲染前后均确认） | 8 张；首张 79.8 秒（首次 Metal 内核编译），之后约 329 ms/张 |
| Mac mini | EEVEE | **锁屏**（前后均确认） | 8 张；首张 0.9 秒，之后约 328 ms/张 |
| PC-4090-1（Blender 4.5.1） | Cycles / OptiX，16 spp | 解锁（对照） | 8 张；首张 1.1 秒，之后约 542 ms/张 |
| PC-4090-1 | EEVEE Next | 解锁（对照） | 8 张；首张 1.3 秒，之后约 116 ms/张 |

画面样张：`spaces/release-beta/preview/ue-remote-play/blender-locked-mac/`（f00 与 f04 哈希不同，是不同角度的真实渲染）。

**边界。** 场景是极简的默认立方体，帧耗时不代表真实项目；每次启动都重新加载场景，没有常驻进程，没有测"按需响应相机指令"的延迟；Mac 首次 Metal 内核编译 80 秒，需要预热；Windows 的锁屏下后台渲染**没测**（当时解锁，Mac 的结果不能替它证明）。

**未决。** 常驻 Blender 的指令协议与安全边界（只接受白名单操作，不执行任意 Python）；渲染引擎选择（EEVEE 低延迟、Cycles 画质）；GPU 与游戏实例共用时的调度。

## 6. 分期

| 期 | 交付 | 完成时可对外开放 | 仍不开放 |
| --- | --- | --- | --- |
| 1 | §5.2 的四处改动 + UE 示例（Epic 前端固定版本）+ Blender 示例（后端脚本 + 帧查看器）+ Skill 文档 + 共用验收脚本 | 本机/局域网内 Agent 启动 UE 或 Blender，浏览器观看并操作 | 跨网络、手柄、锁屏承诺 |
| 2 | 平台 ICE/TURN 接入 UE 路径、强制 TURN 实测 | UE 跨网络可用 | 30 分钟稳定性承诺 |
| 3 | 释放与清理全路径（运行器被杀、浏览器崩溃、断网）、手柄、有声游戏、两台机器各一次锁屏实测 | 可作为 Demo 流程常规使用；锁屏能力按实测写明 | — |
| 4 | 第三个软件（Unity 或另一个 DCC）接入验证；判断是否需要把 `run.py` 升级为产品组件 | Agent 能自行接入新软件 | — |

每期先写验收再实现；没有测量依据时不承诺工期。

## 7. 验收

| 目标 | 输入条件 | 可观察结果 |
| --- | --- | --- |
| 启动与就绪 | 清单 + 未 cook 工程 | 预览入口出现；冷启动时间被记录；超时有明确错误 |
| 画面/声音 | 浏览器连接 | 解码帧率、丢帧、冻结被记录；有声游戏的音频能量不为 0 |
| 输入 | 键鼠/手柄 | 画面或游戏状态按预期变化；失焦不粘键 |
| 单观看者 | 第二个观看者连接 | 被拒绝并得到明确错误，不影响第一个 |
| 撤销 | 外侧撤销 / 关闭信令且页面试图重连 | 画面停止、输入失效，重连被拒绝直到再次允许 |
| 释放 | 按住键时：撤销/关页/杀服务/断网 | 游戏侧按键释放，固定期限内可观察 |
| 清理 | 停止 | 引擎与信令进程树消失，端口释放，登记删除 |
| 锁屏 | 会话处于锁定 | 画面与输入仍工作（**若不成立，必须在文档中写明限制**） |
| 跨网络 | 强制 TURN | 通过；记录选中的候选对、RTT |
| 稳定性 | 30 分钟共载 | 无冻结、资源无持续增长 |
| 一致性 | 同一套验收脚本分别对 UE 和 Blender 配置运行 | 启动/就绪/单观看者/撤销/清理的用例两者都通过，仅"输入效果"断言按软件不同 |
| Agent 编辑闭环 | Agent 改参数后重启 | 同一预览入口里行为变化可见 |

Agent 工作流验收看最终环境状态（实例在跑、行为变了、进程清掉了），不以"命令退出 0"为准。

## 8. 取舍、兼容与未决问题

**取舍。** 不新建运行框架：已有运行器形态已覆盖进程、就绪、代理和登记，新建框架只会产生第二份生命周期代码。不引入"适配器种类"：UE 与 Blender 的差别只在后端进程和页面，不需要平台理解它们。不做租约：理由见 §5.3。代价是 UE 路径没有只看模式。不用 Capture 做游戏和后台可渲染的 DCC：它依赖解锁桌面并向真实桌面注入输入。

**兼容。** Service Preview v1、内置 H5 模式、Capture、`app.py` 的配置都不变；Node 示例整体删除；新增字段都是可选。

**风险。** Pixel Streaming 与 Pixel Streaming 2 随 UE 版本变化；Epic 前端依赖的构建需要固定；GPU 上渲染与编码共载未测；UE 冷启动约 4 分钟需要预热；`run.py` 是示例级代码，升级为稳定组件前要补测试；UE 的信令服务已用 Python 重写（`assets/unreal/signalling.py`），示例运行不需要 Node。

**未决问题**
1. 接受"没有只看模式"吗？若需要，最简单的做法也是页面层的约定，不是平台强制。
2. ~~锁屏下 UE 与 Windows 上 Blender 是否可用~~：Windows 上已实测可用（§11.2）。
3. ~~TURN 短期凭据如何交给 UE 侧~~：已由页面经信令转交（§11.1）；只放行 TCP 443 的网络需要 `turns:` 443（§11.3，待基础设施决定）。
4. Blender 帧编码：JPEG 够用，还是需要软件内 H.264；白名单指令集由后端作者定，还是平台统一。
5. 是否把 4090 按"专用 Agent 工作站"处理（自动登录、不休眠），这决定 Capture 路径在该机上的可用性。

## 9. 安全与恢复

- 沿用既有模型：已认证且能驱动完整 Agent 的连接等价目标 OS 用户；不新增项目/Agent ACL。外侧"允许"与撤销不变。
- 运行器只启动配置里声明的命令，只终止自己启动的进程树；登记按 runId 清理，残留的自有登记需先确认进程已退出再清理（沿用现有规则）。
- 回滚：停止运行器即回到无离屏预览；不修改用户工程，Agent 的工程改动走既有工作流。

## 10. 落地与实测（2026-10-31）

**实际改动**（均已在 dev-4，未合入前以提交为准）：

| 改动 | 位置 |
| --- | --- |
| 运行器（Python，内置环境）：多后端启停与进程树清理、后端可无 `origin`、WS 路由 `maxViewers`（1–16，超限得到 close 1013 `viewer_limit`） | `apps/daemon/builtin-skills/genehub-preview/assets/python-adapter/run.py` |
| 新页面模式 `pixel-streaming/1`：只需一条信令 WS 路由；沙箱允许指针锁定与自动播放；页面得到 `describe()/ice()`；工具栏不出现 Capture 的接管开关 | `packages/proto/src/service_preview.rs`、`packages/workbench/src/preview/serviceClient.ts`、`AssetPreviewPage.tsx` |
| UE 5.4 示例（固定版本的 Epic 前端库 157 KB + 页面 + 配置） | `assets/unreal/` |
| Blender 后台渲染示例（本机 HTTP + JPEG 页面） | `assets/blender/` |
| Skill 文档 | `references/offscreen-apps.md`，并从 `SKILL.md`、`unreal-engine.md`、`registration-contract.md` 指向 |
| 回归 | Rust 单元测试 2 项；`htmlServiceMedia.test.ts` 3 项；specialty `offscreen-runner-viewer-limit`、`engine-streaming-page-mode`（均先对未改动代码确认失败再通过） |

与第 5.2 节计划相比多出一项：UE 路径需要新的页面模式（沙箱指针锁定与 `ice()` 原先只对 `remote-desktop/1` 开放）。

**真机端到端**（Windows，RTX 4090 D，真实 Workbench Preview 页面 + 本机 daemon + 上述运行器与示例，Edge 无头；证据 `spaces/release-beta/preview/offscreen-apps/`）：

| 项 | 结果 |
| --- | --- |
| UE（未 cook，`-game -RenderOffScreen`）通过 Preview 出画面 | 允许服务后约 19 秒首帧（UE 缓存已热） |
| 沙箱内指针锁定 | 成功 |
| 键盘 | 按住 W 画面变化 6.6（空闲 0.43） |
| 锁定鼠标转视角 | 帧差 9.1 |
| 第二个观看者 | 被 close 1013 `viewer_limit` 拒绝；第一个继续出画 |
| 撤销（工具栏"停止观看"） | 帧数立即停止增长（8 秒内无新帧）；重新允许后恢复 |
| Blender（4.5.1，EEVEE）经 Preview | 首帧 1.5–2 秒；拖动旋转后图像变化，每帧约 0.25 秒；撤销后服务不可达，重新允许后恢复 |
| 进程清理 | 运行器结束后 UE、信令、Blender 均不在，端口释放 |

**未验证，不能外推**：锁屏下的 UE 与 Windows Blender、跨网络与强制中继（页面已把平台 ICE 换入，但本次平台 ICE 为空，只测了本机回环）、手柄、有声游戏（模板工程无声）、30 分钟稳定性、输入到画面延迟、Safari/手机、Mac 上的 UE、真实滚轮（无头驱动的滚轮事件到不了沙箱 iframe，只验证了页面的滚轮处理函数）、撤销之外的释放路径（运行器被杀、浏览器崩溃、断网）。UE 冷启动约 4 分钟（第一次，来自此前的 spike），运行器 `readyTimeoutMs` 上限 300 秒只覆盖信令服务，UE 就绪由页面等待（页面会提示"等待游戏启动"并持续重试约 5 分钟）。

**Python 运行器复验（2026-10-31，同一台 4090）。** 产品内置的是 Python 环境而非 Node，运行器因此迁为 `python-adapter/run.py`，原 Node 示例整体删除。同一套真机脚本在 Python 运行器上重跑：UE 允许服务后约 21 秒首帧、指针锁定、按住 W 画面变化 6.9（空闲 0.43）、锁定鼠标帧差 9.2、第二个观看者被 `viewer_limit` 拒绝、撤销后 8 秒内无新帧、重新允许后恢复，UE 与 Blender 进程均无残留；Blender 首帧 1.5 秒、拖动与滚轮处理函数改变画面、撤销后不可达、重新允许后恢复。Linux 专项（`offscreen-runner-viewer-limit`、`engine-streaming-page-mode`）在 Python 运行器上通过，前者新增断言：正常停止会删除登记并结束全部后端进程。随后把 Epic 的 Node 信令服务也换成 Python（`assets/unreal/signalling.py`，UE 5.4 消息流：config/identify/endpointId、listStreamers、subscribe、offer/answer/iceCandidate 转发、ping/pong、人数；不含 SFU 与 matchmaker），专项 `pixel-streaming-signalling` 用替身 streamer 与 player 走完整握手并在移除 playerId 转发时失败；4090 上再跑一遍真实 UE：首帧 18.3 秒、指针锁定、按住 W 画面变化 6.5、锁定鼠标帧差 9.2、第二个观看者被拒绝、撤销后画面停止、重新允许后恢复，Python 运行器与 Python 信令服务之外没有 Node 进程参与，UE 与监听端口均无残留。示例运行不再依赖 Node；仅 `pixelstreaming.esm.js` 当初用 npm 构建过一次，它是预构建的浏览器模块。

## 11. 云端游玩与锁屏实测（2026-10-31）

### 11.1 改动：UE 一侧拿到平台 ICE

此前页面只把平台 ICE 换进浏览器，`signalling.py` 发给 UE 的 `config` 是空的，UE 在 NAT 后只会报局域网地址。查 UE 5.4 源码（`PixelStreamingSignallingConnection.cpp::OnConfig` → `SignallingConnectionObserver::OnSignallingConfig`）：UE 每收到一次 `config` 就覆盖 `Streamer.PeerConnectionConfig`，之后每个新玩家的连接都用它（`Streamer.cpp` 创建 `FPixelStreamingPeerConnection` 处）。所以不需要改引擎、也不需要命令行参数：

- 页面拿到 `ice()` 后，在信令连接打开时先发 `{"type":"iceServers","iceServers":[…]}`；
- `signalling.py` 校验（≤8 项，`stun:`/`turn:`/`turns:`，字符串长度上限，错误即 1008 关闭该玩家），在向 UE 发 `playerConnected` **之前**重发 `config`；
- 每次重新允许都会带新的短期 TURN 凭据，凭据过期不影响下一次连接。

专项 `pixel-streaming-signalling` 增加断言：UE 在 `playerConnected` 之前收到的 `config` 恰为页面给的服务器；非法列表被 1008 拒绝。真机上 UE 日志显示 ICE 收集从“立即完成”变为等待 STUN/TURN 超时（约 40 秒），说明配置已生效。

### 11.2 锁屏（Windows，PC-4090-1）

会话为 RDP 会话；用 `LockWorkStation` 锁定，运行前后均确认会话 1 中有 `LogonUI`。同一套真机脚本（真实 Preview + 本机 daemon + Python 运行器 + Python 信令）：

| 项 | 解锁（基线 k1） | 锁定（k2/kb2） |
| --- | --- | --- |
| UE 首帧 | 26.7 秒 | 20.3 秒 |
| 键盘（按住 W 帧差，空闲约 0.41） | 6.61 | 6.67 |
| 锁定鼠标转视角 | 9.15 | 9.18 |
| 第二个观看者 | 1013 `viewer_limit` | 1013 `viewer_limit` |
| 撤销 / 重新允许 | 停止 / 恢复 | 停止 / 恢复 |
| Blender 首帧、拖动、滚轮、撤销 | — | 1.5 秒、变化、变化、不可达后恢复 |
| `UnrealEditor-Cmd -run=pythonscript` | 约 20 秒 | 18 秒，“executed successfully” |

结论：在这台机器上，**锁屏不影响 UE 离屏串流、Blender 后台渲染和 Agent 的 Python 编辑**。Mac 上的 UE 未测。

### 11.3 云端（跨网络）实测与阻塞

**环境。** 观看端：开发云 Linux（出口 14.22.11.167），真实 Workbench `AssetPreviewPage`（无头 Chromium），经 **Beta Hub** 的 Fabric 连到办公室的 PC-4090-1（出口 43.132.141.25）；两台机器上跑的是 dev-4 构建的 daemon（Windows 端为交叉编译），配对进 Beta Hub 的一个试用身份（实验用，未用任何人的账号）。

**结果。**

- 发现服务、打开工作区、允许服务、信令往返（offer/answer/候选）全部经 Hub 通过；页面拿到 Beta 的 STUN + 带凭据的 TURN 并交给了 UE。
- **媒体没有建立**（连接状态 `failed`）。逐层排查：开发云主机没有任何 UDP 出口；办公网 UDP 只放行白名单（Google STUN 19302、DNSPod 可达，Beta 的 `rtc-beta:3479`、Cloudflare/腾讯的 STUN、NTP 都不可达）；在 Beta 服务器上抓包，办公网与开发云发往 `1.13.182.31` 的 UDP（任意端口）和 3479/3480/5349 的 TCP SYN 一个都没到。两边都只有 TCP 443（经透明代理）能出去。
- Beta 的 coturn 是 `no-tcp`/`no-tls`、只听 UDP 3479，且 `max-bps=1250000`、`bps-capacity=10000000`（coturn 按字节计：单会话约 10 Mbit/s，整台约 80 Mbit/s）。这与 `genethub-cloud/deploy/rtc/README.md` 的既定范围一致：“只放行 80/443 的传统企业不在 P0”，`turns:` TCP 443 明确不做。

**结论。** 平台和 UE 这一侧的代码已就绪；**在只放行 TCP 443 的网络里（包括本团队办公网和开发云），任何 WebRTC 媒体（UE 串流、Capture 远程桌面）都到不了 Beta TURN**，这是基础设施范围问题，不是引擎问题。家庭网络等允许出站 UDP 的环境理论上可用，但本次没有这样的观看端，未实测。

**要让办公网也能云端游玩，需要决定一项基础设施改动（需要 Beta/Stable 发布 owner 授权）：**

1. 给 TURN 增加 **TLS on TCP 443**（`turns:rtc-beta.genethub.com:443?transport=tcp`）。443 已被同机 Caddy 占用，可选：(a) 为 `rtc-beta` 加一个独立公网 IP，coturn 独占其 443；(b) 换带 layer4 的 Caddy 按 SNI 分流（改动现网入口，风险较高）；(c) 独立小主机。Control 侧只需在 `HUB_BETA_TURN_URLS` 增加该 URL（`rtc.ts` 已允许 `turns:` 与 `?transport=tcp`）。
2. 评估中继带宽：现配置单会话约 10 Mbit/s、整台约 80 Mbit/s；本机回环时 720p 串流约 58 Mbit/s，走中继会被码率自适应压到 10 Mbit/s 以内，画质下降，同时游玩的人数也有上限。

### 11.4 Unity

PC-4090-1 未安装 Unity，Unity 编辑器需要账号登录激活，无法由 Agent 自行完成。接入路径与 UE 相同（Unity Render Streaming：一条 WebSocket 信令路由 + 引擎侧拿平台 ICE + 页面），信令协议不同，需要一个与 `signalling.py` 同样大小的 Python 实现。需要 Human 提供已激活 Unity（版本与示例工程）后才能实测。

### 11.5 公司网络内部（办公室机器之间）

用户的机器都在公司网络里，所以又测了“办公室机器看办公室 UE”：Mac mini（30.29.134.59）上的真实 Preview 页面经 Beta Hub 连 PC-4090-1（30.29.52.11）的 UE。

- 信令、发现、允许服务都通，UE 收到平台 ICE；**媒体仍然 `failed`**。
- 原因在网络：两台机器之间的内网流量都走 iOA 零信任隧道（Windows 的 `NGNClient Adapter`、Mac 的 `utun4`，下一跳 192.168.255.x），而不是直连网卡。UDP 实测：
  - 任一方向的“首包”都能到达对端，但源端口被改写（如 50557 → 61456）；
  - 对端按收到的源地址回包（STUN/ICE 的应答就是这样）**两个方向都收不到**；
  - 双方各自往对方**绑定端口**同时发送则双向都通（15 秒约 2760 包/方向）。
  ICE 的每次连通检查都要求应答送回观察到的源地址，所以在这条隧道上点对点 UDP 必然失败；公网 UDP TURN 又被办公网拦。**在公司网络里，只靠 UDP 无法建立任何 WebRTC 媒体（UE 串流、Capture 都一样）。**
- 同一隧道上 TCP 正常（任意端口，PC → Mac 往返成功）；办公网到 Beta 服务器的 TCP 443 也正常（Fabric 本身就走它，非 GeneHub 自签程序同样可连）。

结论：对“所有机器都在公司网络”的用户，能用的只有 TCP 中继：首选 `turns:` TCP 443（§11.3 第 1 项），或只在公司内用的话在内网放一台 TCP TURN。家庭宽带、手机流量等允许 UDP 的网络不受此限制。

