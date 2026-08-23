# 桌面端规格

> 参考实现：工作区 `ref-repos/cc-switch`（Tauri 2：托盘、关窗驻留、轻量模式、开机自启、安装包；不属于本仓发布内容）。
> 目标：有**安装过程**、能**后台常驻**、托盘可**唤醒主界面**；daemon 与默认 agent 随客户端存活。

## 0. 这一版发到哪些平台

**桌面壳只支持 Windows 与 macOS。** 当前公开流水线产出 Windows 安装包；macOS 代码与真实进程监督测试同样是发布门禁，但正式下载要等签名与公证就绪。下面的生命周期约束同时适用于这两个平台。

**Linux 这一版只有命令行**：`scripts/install.sh` 装薄 CLI `genet`、原生 `genehub-host` 与
`genehub_guest.wasm`；daemon/内置 agent 是同一 component 的两个入口，不再发布独立 agent 二进制。
daemon 启动后打印不含长期密钥、15 秒有效且只能使用一次的连接地址，浏览器指过去就是同一个工作台——同一份
`packages/workbench`，不少一个功能。

这不是砍功能，是 Linux 机器的实际用法：多半是 SSH 进去的，窗口没有用；有图形界面
的那些，浏览器本来就在。为一个"打开一个浏览器"的壳去背 WebKitGTK 与
libayatana-appindicator 两个依赖（前者装不上就跑不起来，后者不少桌面根本不显示
托盘图标），换不到任何东西。

想让 Linux 机器一直可达就跑 `genet daemon run`（或 `genet daemon start` 后台拉起），用 systemd user unit 或者 `nohup` 都行——
它本来就是设计成这样活着的进程，桌面外壳只在 Windows/macOS 上替用户做了这件事。仓库不构建、测试或发布 Linux Tauri 壳、AppImage 或 deb。

macOS 正式发布必须先完成签名与公证：没有公证的下载是一个"安全警告后面挂着一个 App"。

---

## 1. 用户可感知行为

| 行为 | 默认 |
|------|------|
| 官网下载 → 安装器安装（非绿色解压凑合） | 必须 |
| 安装后可从开始菜单 / Applications 启动 | 必须 |
| 关闭主窗口 → **最小化到托盘**，进程与 daemon 继续跑 | 默认开启（可改为退出） |
| 托盘左键 / 菜单「打开主界面」→ 显示并聚焦窗口 | 必须 |
| 托盘菜单「退出」→ 停 agent → 停 daemon → 退出 | 必须 |
| 开机自启（设置项） | 应有 |
| 单实例：再次打开快捷方式 → 唤醒已有实例 | 必须 |
| 托盘图标区分在线 / 离线 / 有任务在跑 | 建议 D2 |
| **装完不用装别的东西就能跑任务** | 必须（靠内置 Genet Agent） |

用户心智：**装一次，挂后台，手机/浏览器随时连这台 PC。**

**升级时安装器先停「看护进程」,再停 daemon,然后等文件真的可写。** 顺序不是风格问题:App 会在 daemon 死后一秒左右重新拉起一个(`daemon.rs` 的 `watch`,这正是"关窗后机器仍可达"的实现)。所以先杀 daemon 的安装器,一秒后会撞上一个**全新的** daemon 正握着它要写的那个文件——和它本来要修的那个错误一模一样。第一版钩子就是这么写的,于是同一个报错又出现了一次。要停的那个进程叫 `genethub-desktop.exe`(Cargo 二进制名),不是 `GeneHub.exe`——后者只是开始菜单里显示的名字。v0.1.7 杀的是后者,即等于什么都没杀,升级照旧失败;流水线现在拿真产物核对钩子里的每个进程名确实存在。等待也不是睡一个猜出来的时长:句柄多久释放、杀软多久放手、重启多久完成,在这里都不可知,所以直接问那个文件能不能写。

**当前不存在应用内「立即安装」。** 外壳的 `install_update` 命令无条件失败关闭，不启动任何子进程；用户从官方发布页手动下载安装包。安装器自己的升级钩子仍需先停 App，再停所有正在装载 daemon/agent entry 的 host 进程，以便替换正在使用的文件，但这不再是一条能从页面或 Relay 消息触发的执行路径。组件后台验签、切换与自动回滚是 [architecture.md](./architecture.md) B5 的未完成项。

**托盘在等 daemon 之前就建好。** 启动 daemon 会等它报端口,最长二十秒,而第一次运行这个等待是真花掉的:两个全新的、没签名的可执行文件要被杀软扫,防火墙可能还在问其中一个。把托盘放在这之后建,意味着人生第一次启动在那段时间里**根本没有托盘**——而那正是有人想确认"它到底跑起来了没有"的时刻。状态行写着「启动中」,就是为这段时间准备的。

**官方发布的安装包里预置了官方 Hub 地址**（发布流水线注入,见 `.github/workflows/release.yml`）。自己从源码编译的那份是空的:一份别人编译的副本没道理默认连到我们的服务。

预置之后,**连接就是一次点击**:「连接」直接走 `hub.trial`,Hub 当场建身份并当场批准,整件事在这个窗口里完成——不开浏览器,不弹第二个窗口,也没有配对码要人念。配对码没有被删掉,它被折进「连到自己的 Hub」:自建 Hub 的人是真实用户,但把地址输入框摆在第一位,是让所有其他人把"连上"看成一份作业。那条路仍然会开一个自己的登录窗口(`open_window`),因为它本来就要有人在浏览器里确认一次。

---

## 2. 从 cc-switch 对齐的能力映射

| cc-switch | GeneHub Desktop |
|-----------|-----------------|
| `minimize_to_tray_on_close` | 同左，默认 `true` |
| 托盘菜单 `show_main` | 「打开 GeneHub」 |
| `lightweight`：销毁 WebView 只留托盘 | 可选「省内存后台」；daemon **不**随窗口销毁 |
| `auto_launch` | 设置项「登录时启动 GeneHub」 |
| `visible: false` 首启再 show | 先起托盘 + daemon，再弹主界面 |
| WiX / dmg `bundle` | Windows NSIS；macOS `.dmg`；不生成 Linux 桌面包 |
| `deep-link`（`ccswitch://`） | `genehub://` |
| `updater` 插件 | **不用**：检查和下载走 daemon，装是外壳按 `/UPDATE /P /R` 拉起安装包（§6.4） |
| 退出前移除托盘图标（Win 残影） | 必须照做 |

GeneHub **不要**复制 cc-switch 的业务逻辑，只复用桌面壳模式。

---

## 3. 进程与生命周期

```
安装
  └─ 写入 Program Files / Applications + 快捷方式
       + sidecar 资源（genet、genehub-host、genehub_guest.wasm）

启动（或开机自启）
  ├─ 单实例锁
  ├─ 创建托盘
  ├─ 启动 sidecar：genehub-host 装载 guest daemon entry（由 genet 生命周期入口选择）
  ├─ 校验 host 与 guest；内置 agent 按会话由新 host 进程装载同一 guest 的 agent entry
  └─ 显示主窗口（或仅托盘）

关主窗口
  └─ hide（或 lightweight 销毁窗口）—— daemon 继续

托盘「打开主界面」
  └─ show + unminimize + focus

退出
  └─ 停 agent 执行 → 停 daemon → 移除托盘 → exit
```

**硬约束：** 只要托盘还在，daemon 就必须在（除非用户显式「暂停远程连接」）。

### 3.1 接管，而不是抢

外壳崩溃时 daemon 不会跟着死——这是有意的，远程会话不该因为一个 GUI 崩了而中断。代价是下次启动时机器上已经有一个 daemon 在跑，而它持有数据目录的锁。

外壳启动时先读权限受限的 `endpoint.json`，再带一次性 challenge 请求 `/health`。响应必须同时匹配 pid、machine id、fingerprint，并给出由本地 bearer 计算的 HMAC，才会接管；仅仅“pid 还活着、某个进程在旧端口返回 200”不够。文件会在硬杀之后残留，pid 和端口也都会复用，旧实现会误接管甚至在退出时误杀无关进程。

在实现接管之前，这条路径的表现是：新 daemon 抢锁失败、一声不吭地退出，外壳等满 20 秒超时，然后告诉用户「没有可连接的机器」——而他的机器正跑得好好的。

### 3.2 看门狗

外壳在整个生命周期里每秒做同一份带 challenge 的身份探测。身份不匹配与不应答都按连接丢失处理，但只有再次证明本地 bearer 的进程才会收到 shutdown token 或强制终止；重启间隔 1s 起翻倍、上限 30s。daemon 的单实例约束使用 OS 持有的文件锁，不再把锁文件里可能复用的 pid 当权威。

重启后端口和本机密钥都变了，所以外壳通过 `genehub://daemon` 事件通知工作台重新取地址——每次重连都通过 Tauri IPC 取得新的一次性准入，不复用旧 URL。托盘的状态行同步更新（运行中 / 正在恢复 / 已停止）。

### 3.3 关停走 loopback，不走信号

退出时外壳向 daemon 自己的监听端口发 `POST /shutdown`：携带的是绑定 action、challenge、pid、machine id、fingerprint 与过期时间的 15 秒一次性 HMAC proof，不是长期 token；daemon 只接受来自 loopback、未过期、未使用且 proof 正确的请求。外壳等它自己收干净，超时才动手杀，并在强制动作前再次验证身份。

用信号更自然，但 Windows 上没有能送达无窗口子进程的信号，那里原先只能强杀——而那恰恰是最需要干净关停的平台：被杀掉的 daemon 不会去收它派生的 agent 进程，而 Windows 上没有别的东西会替它收。

---

## 4. 体积预算

目标：**下载体积 ≤ 80MB（压缩后）**。过去 Linux deb 的数字不能作为 Windows/macOS 桌面包的发布证据，因此不再引用；支持平台的真实安装器必须各自在发布流水线中记录并约束体积。

| 项 | 实测（未压缩） | 说明 |
|----|----------------|------|
| Tauri 壳（含工作台静态产物） | 5.3 MB（重构前记录） | 用系统 WebView，不带 Chromium；须在下一次真实 installer 重测 |
| `genet-local` | 2.35 MB | 2026-08-22 本槽位 release launcher |
| `genehub-host-local` | 11.17 MB | 2026-08-22 本槽位 release Wasmtime/OS 壳 |
| `genehub_guest.wasm` | 6.83 MB | 2026-08-22 单制品 daemon/agent 双入口 |
| 图标与桌面项 | < 10 KB | |

这些分项只用于定位增长来源，最终门禁以 Windows NSIS 与 macOS dmg 的真实产物为准。

### 4.1 硬约束：PC 端零 Node 运行时

安装包里**不允许出现 Node 运行时或 `node_modules`**。这不是体积偏好，而是一条边界：一旦允许带运行时，体积、启动时间、供应链面和跨平台适配都会跟着回来。

**这条约束禁的是「Node 这个进程」，不是「JS / H5 这套技术栈」。** 两者经常被混为一谈，这里说清楚：

- **UI 就是 H5**，而且是刻意选的。Tauri 用系统自带的 WebView（Windows WebView2 / macOS WKWebView）渲染界面，我们写的是标准 HTML + CSS + TypeScript。
- 这些 JS **跑在 WebView 里，是浏览器 JS，不是 Node JS**：没有 `require`、没有 `fs`、没有 npm 运行时依赖。要碰文件、进程、密钥这些，一律通过 IPC 交给 Rust 侧。
- 对比 Electron 的差别正在这里：Electron 同时打包 Chromium **和 Node**，所以起步就是一百多兆；Tauri 两个都不带，UI 却一样是 H5。**我们要的是 Electron 的开发体验，不要它的体积和运行时。**

于是「Node」在三个位置出现，只有第一个被禁：

| 位置 | 是否允许 | 说明 |
|------|----------|------|
| **随包分发、开机跟着跑** | **禁止** | launcher/host 是 Rust 原生程序，业务 guest 是 WASM Component，UI 走系统 WebView；都不带 Node |
| 构建期工具链（Vite / tsc / tauri-cli） | 允许 | 只在开发机和 CI 上跑，产物是纯静态文件，不进安装包 |
| 用户自己装的外部 agent | 不归我们管 | 某些 agent 自带运行时，那是它自己的安装，我们既不打包也不代劳 |

**不打包**：任何外部 agent 的 SDK 或运行时。用户想用 Claude Code、Cursor、OpenCode，daemon 检测本机已装的即可（[architecture.md](./architecture.md) §3.3）——把别人的 CLI 塞进我们的安装包既臃肿又有授权麻烦，还会把它的运行时依赖变成我们的。

**这条约束的顺带好处**：桌面端 UI 和浏览器工作台是**同一套前端代码**（`packages/workbench`），一次实现两处运行，差异只有一层薄薄的能力适配（见 §4.2）。

验收方式：桌面配置只允许把 launcher、host、guest 与静态 Web 产物放进 bundle；Windows/macOS CI 都应编译外壳并运行真实 daemon 的 start/adopt/stop 监督测试。发布流水线还必须直接启动将要随包发布的三件套，确认 guest 真能报出端口——装得上但跑不起来的包，不能等用户安装后才发现。当前 Windows host 的 `fs-perms` 仍返回 `Unsupported`，而 guest 首启强制收紧数据目录；修好 Windows ACL 并跑过三件套首启前，Windows WASM 包不能视为可发布。

### 4.2 同一套前端，两种宿主

`packages/workbench` 同时作为浏览器工作台和桌面窗口内容，靠一层运行环境适配抹平差异：

| 差异点 | 浏览器里 | 桌面 WebView 里 |
|--------|----------|-----------------|
| 连 daemon | 经 relay 的公网上行 | 直连 `127.0.0.1` 本地端口，最快且不出网 |
| 静态资源 | 服务端提供 | 打进 app bundle，离线可用 |
| 原生能力 | 无 | 托盘、通知、自启、选目录，经 Tauri IPC 调 Rust |
| 窗口外框 | 浏览器画的，不归我们管 | 自绘标题栏 + 窗内菜单（§6.0），窗口控制经 `Host.window` |
| 登录态 | Cookie / 设备会话 | 复用 daemon 本地凭证，不必再登一次 |

约束：**这层适配必须收敛在一个模块里**（`packages/workbench/src/host/`），业务组件不允许直接判断"我是不是在 Tauri 里"。否则两个宿主的分支会长满全项目，最后变成事实上的两套前端。

**交付状态：** 当前 Tauri `frontendDist` 仍把 Web 产物固化进 installer；官网更新或浏览器刷新不会更新 desktop WebView。若要把 UI 变化计入 95% 高频端到端交付，必须增加签名、内容寻址、可离线启动且可回滚的热 Web bundle，或让壳从受控远程 origin 加载并重新完成 CSP/离线/信任模型评审。未完成前，涉及 desktop UI 的 change set 走完整模式。

执行策略：按平台构建只带该平台二进制；release profile 开 `opt-level="z"` + LTO + strip；安装包压缩（NSIS LZMA / dmg 压缩）。

现在的风险已经不是体积超标，而是**别让它慢慢长回去**：每次发版记录一次三个二进制的大小，涨幅异常就查。

---

## 5. 内置 Genet Agent（保证「装完就能跑」）

桌面端随包的 `genehub_guest.wasm` 内置 Genet Agent（Rust 源码，规格见 [builtin-agent.md](./builtin-agent.md)），解决的是**新用户第一分钟就得能跑起一条任务**，不能卡在"请先安装并登录某个 CLI"。daemon 的 adapter 通过 `genet agent-serve` 再起一个 host OS 进程并选择同一制品的 `agent-run` 入口。

- daemon 的 `genet` adapter 按需拉起它，用户不需要装任何外部 CLI。
- 首启默认选中它，新用户的第一条任务就跑在它上面。
- MVP 能力：Agent Loop、provider（Anthropic + OpenAI 兼容）、SKILL 机制、session 持久化、7 个核心工具。
- 模型凭证：用户在设置里填 API Key；未填时首条任务给出明确提示而不是静默失败。

**它在 UI 里和其他 agent 平级**：设置页检测本机已装的 Claude Code / Cursor / Codex，装了就出现在 agent 选择器里，没装就不显示（不要弹安装指引打断新用户）。内置 agent 只是默认选中的那一个，不是唯一的那一个。

---

## 6. 窗口的两套入口：标题栏菜单与托盘

### 6.0 为什么标题栏是自己画的

主窗口关掉了系统装饰（`tauri.conf.json` 的 `decorations: false`）。原因只有一条，但躲不开：系统标题栏的颜色由系统决定，我们够不着。系统主题是亮色的 Windows 机器上，那是一条白带压在 `#181B1A` 的正文上方，看着像两个程序摞在一起——而这正是用户报上来的第一句话。

代价是最小化 / 最大化 / 关闭要自己接线：`window_minimize`、`window_toggle_maximize`、`window_is_maximized`、`window_close`（`src-tauri/src/lib.rs`），前端经 `Host.window` 调用；`data-tauri-drag-region` 负责拖动，需要 capability 里的 `core:window:allow-start-dragging`。`tests/wiring.rs` 有一条用例把这三样钉在一起：装饰关掉了、页面画了拖拽区、壳允许拖动——少任何一样都是一个关不掉也挪不动的窗口，比那条白带糟得多。

关闭按钮走的是 `window.close()`，**不是** `hide()`：窗口消失而 daemon 继续活着这个决定只写在 `CloseRequested` 里（§3），从那里过一遍，标题栏和系统自己的关闭手势才不会哪天分家。

macOS 上我们也画自己的三个按钮。关掉装饰会连红绿灯一起拿走，那边留一段空白就等于那个构建没有任何办法关窗；等到有签名的 macOS 版本时，再把那个平台换成 overlay 标题栏、把位置还给系统。

### 6.1 分工

窗口开着的时候人找菜单栏，窗口关掉的时候人找托盘。**同一套动作，同一套说法**——两处叫法不同就是两样要学的东西。

```
文件   新建会话 / 打开工作区… / 打开 .code-workspace… / 设置 / 关闭窗口
视图   工作区文件 / 工作区终端 / 工作区变更 / 设备 / 显示隐藏左栏 / 外观（跟随系统·暗色·亮色）
帮助   检查更新 / 打开日志目录 / 连接到 Hub / 重新生成认领链接
```

只有托盘有的：本机状态、设备标识摘要、暂停远程连接、开机自启、退出 GeneHub。这些都是「窗口不在时也得够得着」或者「关于这台机器而不是关于这个窗口」的事。当前摘要不是已验证公钥。

只有菜单有的：外观、显示隐藏左栏。这两个都是这个窗口自己的排版，托盘管不着（外观还是每个客户端各自一份，见 [web-workbench.md](./web-workbench.md) §2.7）。

### 6.2 托盘菜单（MVP）

```
打开主界面
──────────
本机状态：在线 / 离线 / 正在执行 N 个任务
设备标识：ABCD-EFGH-…（点击复制；当前仅用于辨认，不代表公钥核验）
重新生成认领链接        ← 临时用户的恢复入口，必须常驻
检查更新                ← 手动，只在这一刻出网；结果落在设置页的「版本」里
打开日志目录            ← 出问题时要交出去的东西，不该让人自己去翻 %APPDATA%
──────────
暂停远程连接
开机自启 ✓
关闭窗口时保持后台 ✓
──────────
退出 GeneHub
```

「重新生成认领链接」是临时用户丢失身份后唯一的挽救手段，不能藏进二级设置。

「打开日志目录」也在托盘而不只在工作台里：想看日志的时刻，往往正是窗口里看不到有用东西的时刻。它打开 `<data>/logs/`，里面同时有 daemon 的日志和壳自己的启动记录——两半凑在一起才是完整的经过（见 [daemon.md](./daemon.md) §4.4）。

版本区块明确显示：应用内自动下载和安装暂未启用，并只提供代码中固定的官方发布页。daemon 的 `update.check` / `update.download` 与外壳的 `install_update` 都失败关闭，API 不返回 `downloadUrl`；即使旧 daemon 或恶意 Relay 塞入可执行 URL，当前界面也不渲染下载/执行按钮。

原因不是交互取舍，而是信任根尚未完成：发布清单、安装包与 `SHA256SUMS` 都在同一发布权限边界，同源摘要只能发现损坏，不能在发布账号或流水线被攻破时证明发布者意图。自动更新必须等到独立固定、公钥可审计的签名根落地。

### 6.4 手动更新

用户从固定的官方发布页下载对应平台安装包，并通过独立可信渠道核对 `SHA256SUMS` 后手动运行。安装器会停止 App、daemon 和 agent，正在执行的会话因此中断；应先保存工作并选择合适时间。页面或经 Relay 到达的消息都不能触发这个执行过程。

版本区块仍印两个号码：**应用**和 **daemon** 是两个可执行文件，一次发布给它们同一个版本号（`release.yml` 的 version job 会拦住不一致的 tag）；两个号码不同，说明手动安装可能没有完整替换 bundle，应退出后重新运行可信安装包。

---

## 7. 设置项

| Key | 默认 | 文案 |
|-----|------|------|
| `minimize_to_tray_on_close` | `true` | 关闭窗口时最小化到托盘 |
| `launch_at_login` | `true`（可讨论） | 开机时启动 GeneHub |
| `show_window_on_launch` | `true` | 启动时显示主界面 |
| `pause_remote` | `false` | 暂停远程连接 |
| `default_provider` | `genet` | 默认使用的 agent |

---

## 8. 首启之后怎么被别的设备看见

装完就能干活，这一段只解决「换台设备继续」。两条路，桌面端都不必跳出去开系统浏览器：

**只用开源件（无控制面）**  
主界面「设备」页生成一次性配对链接与二维码，另一台设备扫开即换到长期凭证（[web-workbench.md](./web-workbench.md) §设备管理）。要走公网就再挂一台汇合 relay（[self-hosting.md](./self-hosting.md)）。这条路没有账号、没有数据库，机器自己决定谁能进。

**接控制面**  
daemon 提供 `hub.*` 一组调用，对接官方云或任何兼容实现：

| 调用 | 用途 |
|------|------|
| `hub.pair` | 要一个设备码，等人在有浏览器的地方批准 |
| `hub.trial` | 控制面当场建一个临时身份并批准这台机器，省掉批准这一步 |
| `hub.claimLink` | 重新要一条一次性链接，用来在别的设备上打开同一个身份 |
| `hub.machines` | 机主名下还有哪些机器（daemon 凭上行凭证去问） |
| `hub.connect` | 要一张到其中一台的一次性票据 |
| `hub.status` / `hub.unpair` | 现在到哪一步了 / 解绑 |

后两个是账号名下的机器进到切换器里的**唯一**通路。App 里不装账号代码——官方安装包和你自己编译出来的必须是同一份东西，而这个前端是 AGPL 的。凭证是 daemon 的，不经过前端；控制面那边看到的调用方是这台机器，不是某个浏览器。

托盘的「重新生成认领链接」不自己调 daemon：外壳只负责显示窗口并发一个 `genehub://claim`，工作台收到后调 `hub.claimLink` 并把链接和二维码摆在设置页上。**先取到再显示**，否则点了菜单却看到一个没有变化的页面，跟没反应没区别。

桌面端的登录页开在**应用内的 WebView 窗口**里，不跳系统浏览器：跳出去之后回不回得来取决于浏览器，而 App 本来就是浏览器能力的超集。绑定是否完成由 `hub.status` 说了算，不靠拦截回调地址。

落地方式是外壳的 `open_window` 命令（`src-tauri/src/lib.rs`），工作台通过 `Host.openWindow` 用它。要点三条：只开 HTTPS，或自建调试所需的 literal-loopback HTTP；credentials、控制字符、`file:` 与任何自定义 OS protocol 都在 Rust 边界拒绝，Hub 返回的链接还必须与配置的 Hub 同源；同一个窗口复用，按两次是把窗口拉到前面而不是攒一堆半途而废的登录；这个窗口装的是 Hub 的网页，因此不在任何 capability 里，碰不到工作台自己的窗口。`Host.openWindow` 缺席时退回 `openExternal`——浏览器里标签页本来就是"本应用的窗口"。

临时身份没有密码，`hub.claimLink` 是它唯一的挽回手段，所以托盘里那一项「重新生成认领链接」必须常驻（§6）。

同一条链接还负责另一件事：设置页和切换器里的「打开我的账户」。账户页是控制面的页面，不在这个包里，用**系统浏览器**打开 `…/link/{token}?next=/account`。绕认领链接是因为直接开那个地址的话，浏览器在控制面眼里是个陌生人——接着登录会绑出一个新账号，机器全留在旧身份下。

哪些能力属于控制面、控制面自己怎么实现，不在本仓库范围内。

---

## 9. 实现里程碑

**D1（桌面壳骨架）**

- Tauri 2 工程 + Windows/macOS 双平台安装包 target（Linux 仅 daemon/CLI + 浏览器工作台）
- 托盘 + 关窗驻留 + 打开主界面 + 单实例
- sidecar 拉起 daemon（agent 由 daemon 自己按需拉起）；退出时确保整棵子进程树被杀
- 体积方案实测（这一步决定后面所有取舍）

**D2**

- 设备码配对、应用内登录窗口、托盘状态与心跳
- 开机自启、深链 `genehub://`
- 设备标识摘要展示、重新生成认领链接（canonical 公钥身份另列安全里程碑）

**D3**

- 引入独立签名根与签名验证策略后，再重新评估应用内更新；当前入口失败关闭
- lightweight 省内存模式

---

## 10. 参考文件（cc-switch）

- `src-tauri/tauri.conf.json` — bundle / window / deep-link / updater
- `src-tauri/src/tray.rs` — 托盘菜单与 `show_main`
- `src-tauri/src/lightweight.rs` — 无窗口后台
- `src-tauri/src/auto_launch.rs` — 开机自启
- `src-tauri/src/lib.rs` — `CloseRequested` → 托盘；`RunEvent` 退出清理
