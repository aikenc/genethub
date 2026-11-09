# 系统权限：一次申请、更新保留、统一管理（提案）

- 状态：**评审意见已纳入，P0–P2 已在 dev-access 槽位实现（提交 `0d98dc25`），未合入主干、未发布 Beta**；第 0 节记录评审结论与落地差异，其余章节保留原调研与方案文字，以第 0 节为准
- 日期：2026-11-09
- 范围：macOS 为主；Windows、WSL 给出统一做法；Linux 只列出已知项
- 事实基线：源码为 `origin/main` `f1119b28`；现场为 Mac mini（macOS 26.4.1，Apple Silicon，Beta 渠道）和 WSL-4090-1（WSL2）。Windows 原生机器调研时离线，**只有源码/文档依据，没有现场数据**。
- 本文所在槽位：dev-4（工作区干净；它已有 2 个未入主干的提交 `d9ebc9ed`、`63a7b471`，与本提案无关）

## 0. 评审结论与落地（2026-11-09）

| 评审意见 | 结论与落地 |
| --- | --- |
| 完全磁盘访问交给用户，作为默认路径，也允许细粒度 | 一键申请只处理“推荐项”：稳定身份、允许运行、**完全磁盘访问**；桌面/文稿/下载/外接盘/其他 App 数据作为逐项申请保留，开启完全磁盘访问后它们显示“已由其覆盖” |
| 没有 Apple ID 也应能签名并解决反复授权 | **已验证可行**。在 Mac mini 上用本机自签证书（沿用 Capture 的本机钥匙串）签名后，指定要求为 `identifier "com.genehub.<名字>" and certificate leaf = H"…"`，不含内容哈希；不同内容的另一个构建以同名签出后，经 `codesign -R` 由系统自己的评估器判定与旧要求互相满足。仍未做的是“有人在场点一次允许、更新、再确认不弹窗”的整机验收（见第 9 节） |
| genet-beta 还是 genehub-host-beta，代码里不能分析出来吗 | **能，已确定：是 `genet-beta`（责任进程）。** `genet daemon run` 通过 `exec` 变成 host（`apps/cli/src/wasm.rs` `become_daemon → exec_binary`），launchd 任务的责任进程保持为最初的程序；Mac mini 的 TCC 日志同一条记录写着 `responsible_path=…/genet-beta, binary_path=…/genehub-host-beta`。所以授权要加给 CLI（程序列表里两者都列出更稳妥），Agent 派生的子进程继承同一责任进程 |
| 不需要麦克风和摄像头；只要可执行、磁盘、网络 | 登记表只有这三类（`identity`=运行、`disk`、`network`）；没有麦克风/摄像头/通知项。屏幕录制与辅助功能因远程桌面 Capture 已存在，保留为**可选**组，不在默认一键范围内 |
| 先更新到最新主干并做完，给 dev 与 Mac mini 的可体验槽位 | 新建槽位 `dev-access`（dev-4 上有他人未合入的凭据功能提交，rebase 会冲突，故不占用），基于 `origin/main` `7b412993`；Mac mini 加入该槽，见交付说明 |

落地与第 6 节方案的差异：登记表只有“一个持久记录文件 + 实时检查”；签名工具是内置的 Python 助手（沿用 `apps/capture/macos_signing.py` 的本机证书约定，不新增钥匙串）；原生更新器在替换前对暂存程序用同一标识符重签（`apps/cli/src/update/install.rs`，缺证书或助手时原样更新）。因本机没有 macOS 编译环境，这条原生钩子只在 Linux 编译通过，**尚未在真实 macOS 更新里跑过**。

## 1. 先回答三个问题

**体验影响。** Mac 用户每次更新后，会在几天内陆续遇到系统弹窗：访问“可移动卷”、访问“其他 App 的数据”、录屏、辅助功能……而且往往正好弹在 Agent 正在干活、人不在电脑前的时候。屏幕锁定时弹窗没人点，访问外置盘的进程会一直卡在 `open()`（见 `docs/remote-interactive-preview-proposal.md` §5.2.1 的 UE 事件）。手机用户看到的只是“任务不动了”。

**怎么解决（均为待实施）。**

| 问题 | 改什么 | 状态 |
| --- | --- | --- |
| 更新后权限丢失 | 给 macOS 上所有需要权限的可执行文件一个**稳定代码身份**（含固定标识符），更新前比较新旧身份，会失效就提前告诉用户 | 待评审 |
| 权限看不见、要靠弹窗碰 | 设置里新增“权限”页 + `genet access` 命令：列出每项权限的状态、谁持有、怎么申请 | 待评审 |
| 一项项被动授权 | “一键申请”按固定顺序逐项触发，遇到人不在/锁屏/只能手动的项就停下并说明 | 待评审 |
| Windows / WSL | 同一个注册表和页面，各平台只换检测和申请的实现；Windows 的“稳定身份”是 Authenticode 签名 | 待评审 |

**如何避免再发生。** 用一条固定的回归：同一台 Mac 上先授权，再用“真实更新路径”替换两个不同内容的可执行文件，授权必须保留；任何发布前都要跑（§8）。更新流程在发现新旧代码身份不兼容时必须在应用前提示，而不是应用后让用户撞弹窗。

**一个必须先讲清楚的事实：macOS 不允许任何程序（包括我们）代替用户授予这些权限。** 能做到的是：把所有弹窗集中到一次引导里按顺序触发；之后因为身份稳定而不再弹。要做到“静默预授权”只有企业 MDM 的 PPPC 配置描述文件一条路，它不能预授权录屏，个人 Mac 也用不上，本提案不采用。

## 2. 场景：改前改后

- **改前**：周一更新了 Beta。周二 Agent 在外置盘 `/Volumes/SDD` 上跑任务，macOS 弹“genet-beta 想访问可移动卷”，Mac 锁屏，任务卡死；周三另一个 Agent 读取别的 App 的数据又弹一次；周四想看远程桌面，Capture 提示没有录屏权限。每次更新循环一遍。
- **改后**：首次安装结束时，设置页“权限”显示 6 项，用户点一次“一键申请”，在机器前依次点“允许”（Capture 的录屏/辅助功能、文件夹、可选的完全磁盘访问）。之后更新 Beta：更新前页面显示“此更新保持现有权限”；若身份确实不兼容，更新前就写明“会重置：文件与文件夹”，用户可以选择时机。手机端打开权限页能看到每项状态和“需要在这台机器前确认”的提示，而不是任务无声卡住。

## 3. 现状与证据

证据等级：**[现场]** 在真实机器上读到；**[源码]** 读代码/文档；**[推断]** 由前两者推出，尚未实机验证。

### 3.1 “版本更新后不需要重新申请”做到哪了

| 对象 | 现状 | 等级 |
| --- | --- | --- |
| `GeneHub Capture.app`（录屏、辅助功能） | 用机器本地自签证书“GeneHub Capture Local Development”签名，指定要求（DR）为 `identifier "com.genehub.capture" and certificate leaf = H"c395d83d…"`，**不绑定内容哈希**；`apps/capture/macos_signing.py install` 在替换前用 macOS 自己的 requirement 评估器做新旧双向兼容校验。Mac mini 上已装的包 `codesign --verify --deep --strict` 通过（装于 10-30） | [现场] + [源码] |
| `genet` / `genet-beta` / `genehub-host` / `genehub-host-beta` | 全部是 `flags=0x20002(adhoc,linker-signed)`，DR 是 `cdhash H"…"`，**内容一变就是另一个身份**；标识符还带内容哈希（`genet_beta-<hash>`） | [现场] |
| 桌面 App（Tauri） | `tauri.conf.json` 没有 `signingIdentity`；发布流水线写明 macOS 等签名与公证；`Info.plist` 只声明了麦克风用途 | [源码] |
| 实际落地结论 | **只有 Capture 做了稳定身份，且“更新后权限仍保留”从未做过实机验收**——`remote-interactive-preview-proposal.md` 多处记载该项“仍待验证”，并有一次因另一份旧 cdhash 校验失败导致新进程仍不获准的记录 | [源码] |
| Mac mini 的守护进程 | 由 LaunchAgent `com.genethub.beta.daemon` 直接运行 `genet-beta daemon run`，所以 **macOS 把文件类弹窗归到 `genet-beta` 这个 ad-hoc 可执行文件**；同一个 pid 在 `ps` 里显示为 `genehub-host-beta`（启动后换成 host），**最终以哪个身份计入需要 P0 确认**，两者都是 ad-hoc | [现场] |

### 3.2 现场：更新当天确实在重新弹窗

Mac mini 的 TCC 统一日志（保留期较短，只取到当天）里，来自 GeneHub 的“正在弹窗”请求共 3 条：

```
11:16:04  SystemPolicyRemovableVolumes  genet-beta  标识符 genet_beta-01db15ac962979fa  pid 46820
11:16:06  SystemPolicyRemovableVolumes  genet-beta  标识符 genet_beta-830ed41c8aae8efb  pid 2197
13:36:22  SystemPolicyAppData           genet-beta  标识符 genet_beta-830ed41c8aae8efb  pid 99086
```

同一路径在两秒内换了两个标识符（可执行文件被替换），随后各弹一次（弹窗主体写的是 `genet-beta` 路径）；下午又为“其他 App 的数据”弹一次。触发 AppData 的具体路径日志里没有，**未知**（§9）。这与“更新后要陆续开权限”的用户描述一致，但我们没有读到 TCC 授权库本身，所以“旧授权因身份变化而失效”是**[推断]**，不是读库所得。

### 3.3 其他现场事实

- 从守护进程派生的 shell 里读 `~/Library/Application Support/com.apple.TCC/TCC.db`，返回 `authorization denied`：该进程链**没有完全磁盘访问**。同时说明 **GeneHub 读不到授权库，状态只能靠各 API 探测或自己的记录**。[现场]
- 同一份 Capture，`--probe` 的结果取决于**怎么启动**：从 shell 里直接执行，得到“Screen Recording is not granted to this program”（被归到启动它的进程链）；经 LaunchServices 启动则归 Capture 自己，当时得到 `desktop_unavailable`，因为会话锁屏（`CGSSessionScreenIsLocked=true`）。所以这次**没能读到 Capture 的真实录屏授权状态**。[现场] 结论：任何“申请/检测”都必须以正确的身份启动，直接在守护进程里 exec 会得到错误答案。
- 报错文案里还残留上游名字 “MoonlightWeb”，它来自 Capture 引入的上游原生库（`apps/capture/native` 的 vendored 代码），不是 GeneHub 自己的文案；用户会看到一个陌生产品名。[现场]
- WSL-4090-1：WSL2、`networkingMode=nat`、systemd 开启、Windows 防火墙三个配置文件均开启，Hyper-V 防火墙对 WSL 虚拟机 `DefaultInboundAction=Block`；`Get-MpPreference` 因权限报错，**受控文件夹访问状态未知**。[现场]
- Windows 安装器：`installer.nsi` 同时支持 `perUser/perMachine/both`，实际用哪种取决于构建参数，未核对；`desktop-client.md` §3 记载“全新未签名的可执行文件要被杀软扫，防火墙可能还在问其中一个”。[源码]

### 3.4 已有可复用的部件

- Capture 的 `--probe`（只读，不弹窗）和 `--request-permission screen|input`（经 LaunchServices，最多等待 120 秒，不重复请求）；README 明确写着“GeneHub 设置到该原生入口的接线尚未接入”。
- 设置页 `packages/workbench/src/settings/`（`SettingsPanel.tsx` 有“这台机器”分区，`FileAccessSettings.tsx` 是同类的机器级设置，可直接照抄结构）；`client.call` 通道。
- 工作流已有的需求：`remote-interactive-preview-proposal.md` §5.2 要求“权限一次预置”“等待 TCC 时必须报告具体服务名和请求方”，本提案是它的通用化落地。

## 4. 目标与范围

目标（可观察）：
1. 首次安装后，用户在**一次引导**里处理完所有“已知需要”的系统权限；引导不会在锁屏/无人时空转。
2. 之后任何常规更新，授权保留；不能保留时更新前已告知。
3. 设置页能看全部权限的状态和持有者，能逐项申请，能一键批量申请。
4. Windows、WSL 使用同一页面、同一接口。

本期不做：MDM/PPPC；Apple Developer ID 之外的分发渠道；把 `genet`、`host`、Capture 合并成一个 App 包（§6.5 作为后续选项）；Linux 的 portal/uinput 授权；自动化（AppleScript 控制某个 App）这类**按目标应用而定**的权限，只在被需要时按次申请，不进入批量。

## 5. 方案总览

三层，每层可独立交付：

```
 L1 稳定身份       让“更新”不再等于“换了一个程序”         （解决：每次更新重弹）
 L2 权限登记表     每项权限：谁持有、怎么查、怎么申请       （解决：看不见、靠碰）
 L3 引导与设置页   一键批量 / 逐项申请 / 更新前提示          （解决：一次性、可操作）
```

## 6. 具体方案

### 6.1 L1 稳定身份（macOS）

原则：**TCC 记住的是“代码身份（DR）”，不是文件内容。** 只要新旧版本满足同一条 DR，授权就保留。

1. **所有会触发或持有权限的 macOS 可执行文件使用同一个签名者，并固定标识符。** 包括 `genet`、`genet-beta`、`genehub-host`、`genehub-host-beta`、Capture。标识符用 `codesign -i com.genehub.<角色>[.beta]` 固定，不使用默认的“文件名-内容哈希”（它每次构建都变，会让 DR 变）。
2. **签名者有两个选项，评审时需决定：**
   | 选项 | 做法 | 代价 |
   | --- | --- | --- |
   | A. Developer ID（推荐，长期） | CI 签名并公证；所有机器 DR 相同 | 需要 Apple Developer 账号与证书托管；同时解决桌面 App 的 Gatekeeper/公证（`desktop-client.md` 已列为发布前提） |
   | B. 本机自签（过渡） | 沿用 `macos_signing.py` 的“每台机器一份证书”，安装/更新时在本机用固定标识符重签 | 要多一次系统信任确认；下载的二进制被改写，需处理哈希校验（§6.1.4）；证书/钥匙串由本机保管 |
3. **更新守卫：** 在替换前对新旧可执行文件做 `codesign` 的双向 requirement 评估（沿用 `macos_signing.py install` 的逻辑，抽成 `genet` 更新流程的一步）。结果写进更新状态：`保持权限` / `将重置：<权限列表>` / `未签名，无法判断`。不兼容时**不阻断安全更新**，但更新提示必须先展示。
4. **哈希校验：** 若采用选项 B，重签会改变落盘文件的哈希。现有更新/自检里凡是比较“落盘哈希 == 发布哈希”的地方，要改为记录“重签前的发布哈希”并比较它。这是实施前必须核对的风险（§9）。
5. **渠道隔离：** Beta 与 Stable 使用不同标识符（如 `com.genehub.host.beta`），各自一份授权，不共享；同时装两个渠道的用户会看到两套条目，这是预期行为。

### 6.2 L2 权限登记表（daemon，跨平台）

一张表，每行描述一项系统权限：

```
id            稳定标识，如 mac.screen-recording、mac.files-user-folders、win.firewall-inbound
label         用户看得懂的名字
purpose       开启后能做什么（哪个功能会用到）
holder        持有该授权的代码身份与路径（让用户知道系统设置里该勾哪个）
platforms     适用平台
check         怎么无提示地查询（见下）
request       怎么触发（见下）；kind = prompt | settingsPane | manual
```

状态值：`granted` / `denied` / `notDetermined` / `unknown` / `notApplicable` / `needsRecheck`。

**检测的真实约束（macOS）** ——这决定了为什么需要“自己的记录”：

| 权限 | 无提示查询 | 申请方式 |
| --- | --- | --- |
| 录屏、输入控制 | 有（Capture `--probe`，即 `CGPreflight*`） | 经 LaunchServices 调 `--request-permission` |
| 麦克风/摄像头/通知 | 有（持有者进程内的系统 API），桌面 App 存在时由它回答 | 持有者进程内触发 |
| 完全磁盘访问（FDA） | 有（尝试只读打开受保护文件，被拒即未授予；本文 §3.3 的 TCC.db 就是这类探测） | **只能手动**：打开系统设置并显示要勾选的可执行文件 |
| 桌面/文稿/下载、可移动卷、网络卷 | **没有**；不查就只能“访问时才知道” | 由持有者去读对应目录（触发系统弹窗），按结果记录 |
| 其他 App 的数据 | 没有 | 同上；触发路径待确认（§9） |
| 本地网络 | 没有 | 由 Capture 发起一次本地连接触发 |

因此引入一份**授权记录**（daemon 自己的状态文件）：`(权限 id, 持有者 DR, 结果, 时间)`。规则：
- 能查询的以查询为准，记录只做缓存；
- 不能查询的以记录为准，**当持有者的 DR 变化（例如更新后身份不兼容）时，记录自动变为 `needsRecheck`**，页面据此提示重新确认。这样即便读不到 TCC 库，也能在“更新让授权失效”的当天把事情摆在用户面前；
- 记录不含任何路径内容或私密数据，只含权限 id、结果和时间。

**必须以正确身份运行：** Capture 类项目一律经 LaunchServices 启动 Capture；文件类项目由持有守护进程的那个可执行文件自己去读目录（即 guest 通过 host 打开目录），不要在 shell 子进程里测。该约束写进实现和测试。

### 6.3 L3 接口、设置页与批量申请

**接口（拟议）：**

```
genet access status [--json]          # 列出所有项目及状态、持有者、是否需要在机器前操作
genet access request <id>             # 申请单项；返回 requested|granted|denied|needsUser|unavailable
genet access setup                    # 批量：按顺序申请全部缺失的“推荐项”
```

对应 daemon RPC：`access.list`、`access.request`、`access.setup`（只在本机动作，由设置页和 CLI 共用）。新增协议字段放在 `packages/proto`；不新增 WIT 接口、不需要替换 host，所以按现有兼容门可以走 Live（实施时仍须核对）。

**批量顺序与停止条件：**

1. 跳过已 `granted` 的项；
2. 屏幕锁定或无图形会话：**不发起**任何会弹窗的申请，直接返回 `needsUser`（原因“需要在这台机器前解锁”）；这条保护锁屏下的无人机器和远程调用者；
3. 逐项触发并等待结果（沿用 Capture 的 120 秒上限和“不重复请求”），拒绝后不再自动重试，只给“打开系统设置”；
4. `manual` 类（完全磁盘访问）：打开系统设置并显示需要勾选的可执行文件路径，标记 `needsUser`，批量继续处理其他项；
5. 最终返回清单：已授权 / 被拒绝 / 需要手动 / 不适用，不把“已派发”当作“已授权”。

**完全磁盘访问的取舍（需评审）：** 一次授予即覆盖桌面/文稿/下载/可移动卷/网络卷等文件类弹窗，是“无人值守 Agent”最有效的一次性手段，也避免锁屏卡死。代价是持有者可读更多用户数据。产品契约本身是“已认证的连接等价目标 OS 用户权限”（工作区 Skill `genethub-agent-workflow/references/product-authority.md`），所以它没有扩大已认证连接的实际能力，但仍应显式征得同意，默认**推荐但不强制**，并在页面写明范围。FDA 是否同时覆盖“其他 App 的数据”需实机验证（§9）。

**设置页（`packages/workbench/src/settings/AccessSettings.tsx`，入口放 `SettingsPanel` 的“这台机器”之后，参照 `FileAccessSettings.tsx`）：**

- 顶部一行摘要：`6 项已授权 · 2 项待确认`，右侧“一键申请”按钮（有缺失项时可点）；
- 每行：名称、用途、状态标签、持有者（路径可复制）、按钮（`申请` / `打开系统设置` / `重新检测`）；
- 更新后若出现 `needsRecheck`，页面顶部显示一条明确的提示，指向受影响项；
- 当工作台是**远程**连接这台机器时，所有状态可看；会弹窗的按钮旁固定提示“需要在这台机器前点击系统弹窗”，锁屏时按钮置灰并说明原因；
- 不做拖拽式向导、不做动画；只复用设置页现有组件与文案风格。

**Agent 侧：** `genet access status --json` 让 Agent 在启动 UE/Blender、访问外置盘前自查；任务因权限等待时，错误里带 `id` 与持有者（兑现 `remote-interactive-preview-proposal.md` §5.2 第 2 条）。这一步放最后一期。

### 6.4 Windows 与 WSL

**Windows 有类似问题，但形态不同。** 没有“按应用记住的隐私授权库”；对应的是：

| 现象 | 与 macOS 的对应 | 稳定做法 |
| --- | --- | --- |
| SmartScreen / 杀软对未签名新二进制反复拦截与扫描 | 稳定代码身份 | Authenticode 签名（含时间戳）；信誉按证书累积 |
| 防火墙入站弹窗（Capture 的媒体端口等） | 一次性权限 | 防火墙规则按**程序路径**保存，更新不换路径就保留；安装器（管理员权限）一次性创建规则；非管理员安装则登记表标 `needsUser` 并给出命令 |
| 麦克风隐私开关（“允许桌面应用访问麦克风”） | 麦克风 | 只读检测注册表/系统设置，申请方式是打开 `ms-settings:privacy-microphone` |
| Defender 受控文件夹访问拦截写入 | 文件夹授权 | 只读检测；加白名单需管理员，登记表给出命令/设置入口 |
| 提权窗口收不到输入（UIPI）、锁屏/UAC 安全桌面不可采集 | 输入控制/锁屏保护 | 作为 `notApplicable`/`unavailable` 的明确原因报告；Capture 已有“会话锁定返回 `desktop_unavailable`” |
| 开机启动项被禁用 | 登录项 | 只读检测启动项状态 |

**WSL：** 没有自己的授权库，所依赖的授权在 Windows 侧，所以页面只显示适用项并说明归属：

- 运行环境：WSL2、网络模式（本机为 nat）、是否 systemd；
- Hyper-V 防火墙入站策略（本机 `Block`）：影响点对点连接的可达性，提示而非修改；
- WSLg 麦克风依赖 Windows 麦克风隐私开关；
- `/mnt/c` 访问受 Windows 权限与受控文件夹访问约束；
- **WSL 内无法采集 Windows 桌面**，Capture 类项目一律 `notApplicable`，指向“同一台电脑上的 Windows 原生 daemon”；
- 常驻性（WSL 虚拟机空闲回收、daemon 是否由 systemd 托管）作为一项“可用性”检查列出——这是 WSL 上真正反复坑用户的“权限”，与 TCC 无关。

登记表的 `platforms`、`check`、`request` 按平台实现，页面和 CLI 完全共用；新增一个平台不用改页面。

### 6.5 后续选项：合并为一个 App 包

把 `genet`、`host`、Capture 放进同一个已签名的 `.app`（或至少共享一个持有者），系统设置里只出现一条目，也让“守护进程由谁启动、责任进程是谁”更可控。收益大、打包与更新改动也大，**不放进本期**；本期的稳定身份与登记表是它的前置。

## 7. 取舍与替代方案

| 方案 | 结论 |
| --- | --- |
| 只写文档，教用户更新后重新开权限 | 现状。成本最低，但把问题原样留给用户，且 Agent 在锁屏时仍会卡死 |
| 直接写 TCC 数据库/重置后补写 | 不可行（系统保护）；`remote-interactive-preview-proposal.md` 已明确拒绝这条路 |
| MDM/PPPC 描述文件 | 不能预授权录屏，个人 Mac 无法使用；拒绝 |
| 只给 Capture 做稳定身份（现状） | 覆盖录屏/辅助功能，但文件类弹窗恰恰归 `genet` / `host`，反复出现的就是这类 |
| 本提案：稳定身份 + 登记表 + 引导 | 复用 Capture 现成的探测/申请入口与签名脚本；新增的只有登记表、授权记录和设置页 |
| 合并成一个 App | 更干净，但改动大，列为后续 |

风险：选项 B 的本机重签会改写下载的二进制；开发者证书（选项 A）需要组织决策；FDA 是敏感授权；macOS 小版本可能改变弹窗行为，所以每个 macOS 大版本要重跑 §8。

## 8. 验收

| 目标 | 输入条件 | 可观察结果 |
| --- | --- | --- |
| 更新后授权保留（核心） | 真实机器；用**测试夹具**可执行文件（不动 GeneHub 自己的授权）先授权，再用真实更新路径替换为内容不同、同身份的版本 | 夹具再次访问受保护目录**不弹窗**；对照组（ad-hoc 身份）**会弹窗** |
| GeneHub 自身 | 对 `genet`、`host`、Capture 各做两个不同构建之间的真实更新 | 更新前后 `codesign -d -r-` 的 DR 一致；文件类、录屏、辅助功能访问不再弹窗 |
| 不兼容时的提示 | 故意用不同证书的构建更新 | 更新状态在应用前给出“将重置：…”，更新后登记表为 `needsRecheck` |
| 登记表准确 | 逐项授权/撤销 | 可查询项状态与系统设置一致；不可查询项只显示记录结果和时间，不伪装成已确认 |
| 批量申请 | 屏幕解锁、人在场 | 按顺序出现弹窗，最终清单与实际一致，`manual` 项不阻塞其他项 |
| 锁屏保护 | 屏幕锁定时调用 `access request/setup`（本地与远程各一次） | 不产生任何弹窗，返回 `needsUser` 与原因 |
| 正确身份 | 在 shell 子进程里与经 LaunchServices 各查一次 Capture | 状态只取后者；前者不用于判断 |
| 设置页 | 桌面窗口与手机浏览器各一次 | 状态、持有者、按钮与 `genet access status` 一致；远程时有“需在机器前操作”提示 |
| Windows/WSL | 一台 Windows 原生机、一台 WSL | 适用项正确，不适用项带原因；WSL 页不出现 Windows 采集类项目 |

覆盖不到、需要人参与的：系统弹窗必须有人点“允许”，所以“更新后不弹窗”这条验收**需要一次有人在场的实机会话**，不能由无人值守的自动化给出通过结论。

## 9. 未决问题与实施前必须关闭的条件

1. **签名者决策**（选项 A 还是 B）：影响 L1 全部实现；若短期无 Developer ID，先走 B，且 B 的哈希校验影响（§6.1.4）必须先核对更新/自检代码。
2. **实机验证 L1 假设**（阻塞实现）：用夹具验证“固定标识符 + 同证书”的更新后确实不再弹窗；并验证 Capture 现有“证书绑定 DR”的更新保留（目前只有签名层证据，没有授权保留证据）。
3. **FDA 覆盖范围**：是否同时覆盖“其他 App 的数据”“可移动卷”；决定默认推荐文案。
4. ~~持有者到底是 `genet-beta` 还是 `genehub-host-beta`~~ 已确定为 `genet-beta`（见第 0 节）。**AppData 弹窗的触发路径**：11:16/13:36 的日志没有路径；实施前用带路径的日志或 `fs_usage` 在 Mac mini 上定位（只读观察）。
5. **桌面 App（Tauri）的身份**：Mac mini 未安装桌面 App；需要在装有桌面 App 的机器上核对其 Bundle ID（`com.genethub.desktop.local`）是否按渠道区分。麦克风/摄像头已确定不需要，不再列入。
6. **LaunchAgent 的“后台项目”提示**（macOS 13+ 系统设置“登录项”）：用户关闭后 daemon 不会起来；本次没有条件读取登录项数据库，未验证，实施时核对。
7. **Windows 原生**：PC-4090-1 离线，防火墙规则、Defender 受控文件夹访问、安装模式、麦克风隐私开关均为源码推断；实施前需要一台在线机器做只读盘点。
8. **新增 RPC 的兼容门**：确认只改 guest 与 proto 即可，不涉及 WIT/host 变化。

## 10. 分期

| 期 | 独立交付内容 | 此时仍不能开放 |
| --- | --- | --- |
| P0 | 实机验证（§9.2–9.4），产出夹具和结论；评估是否在 Capture 的补丁里替换“MoonlightWeb”文案 | 一切对外承诺 |
| P1 | L1：稳定身份 + 更新守卫 + 更新状态里的“保持/重置”提示 | 设置页、批量申请 |
| P2 | L2 + L3：登记表、授权记录、`genet access`、设置页、一键申请（macOS） | Windows/WSL 页面项、Agent 侧权限等待报告 |
| P3 | Windows/WSL 适配、安装器防火墙规则、首次安装引导（`install.sh` 在无图形会话下只提示稍后在设置页完成） | App 合并 |
| P4 | Agent 侧：权限等待错误带 `id` 与持有者；评估 §6.5 | — |

## 11. 兼容、迁移与恢复

- 旧版本没有登记表：首次启动只做只读检测，不触发任何弹窗；
- 已装的 ad-hoc 二进制第一次换成稳定身份时，**这一次**仍会让已有授权失效（无法迁移，Capture 文档同样记载）；更新状态要明确这一点，之后的更新才保留；
- 本机自签证书与钥匙串（选项 B）沿用 `macos_signing.py` 的规则：不得每次构建重建，缺失/不完整时不静默换新；
- 任一步失败回到现状：不签名/不检测时行为与现在相同；批量申请失败不影响已授权项。

## 12. 完整性评审：本稿的缺项

- 没有读到任何一台机器的 TCC 授权库，也没有做更新前后授权对比，L1 的有效性是**[推断]**，P0 才能转成事实；
- Capture 的真实录屏授权状态未能取得（锁屏）；
- Windows 原生只有源码依据；
- 未估算工作量，也未给出精确工期（没有原型或测量依据）；
- 设置页只描述结构，没有交互稿；
- 参考：`docs/desktop-client.md`、`docs/remote-interactive-preview-proposal.md`（§5.2 及签名/权限各段）、`apps/capture/README.md`、`apps/capture/macos_signing.py`、`apps/desktop/src-tauri/{tauri.conf.json,Info.plist,installer.nsi}`、`.github/workflows/release.yml`、`packages/workbench/src/settings/`。
