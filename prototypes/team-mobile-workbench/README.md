# GeneHub 团队工作台：第二版原型与落地提案

[打开交互原型](index.html)

状态：设计提案与静态交互样例；不是已经接入 daemon 的新 Workbench。所有会话、执行、文件和授权均为演示数据。页面无需服务器，可作为本地 HTML 或通过 GeneHub Asset Preview 打开。没有发起模型调用、批准真实计划、执行命令或上传反馈。

本次先将 Open `origin/main 5f13211`、Cloud `origin/main 93de30d` 合入本地 `dev-agent` 槽位，再以合并候选核对实现。没有推送、修改主干或替换正在使用的 dev 服务。精确提交与验证结果见本文末尾。

## 这版纠正什么

1. **工作区与全局菜单完整保留。** 桌面侧栏和会话标题区、手机底部都有“工具”。工作区保留变更、文件、终端以及宿主注入的“我的电脑”；全局保留当前机器后台进程、设备、设置、反馈问题。工具打开时明确机器与空间，关闭后返回原会话。
2. **普通 Agent 继续使用现有信息流。** Cursor、Codex、Claude Code、Genet 共用已有 TimelineView、工作过程、工具详情与历史恢复。原型中的普通信息流只是样例外观；正式开发不复制这套渲染器。Executor 继续显示持久 FlowMessage，项目 HTML 是可选的另一个观察面。
3. **用公共“文件与预览”，不预设新的产物实体。** 普通阅读笔记、界面实验室、小游戏都可以打开文件预览，再选择可写会话带入反馈草稿。PM 只是其中一个使用者。没有“只有交付成功后才允许预览”的依赖。
4. **允许项目拥有展示 HTML。** Pack 提供起点，WorkflowManager 按用户要求修改页面并生成候选。布局、业务文案、卡片、图表和交互可以变化；运行状态、原生记录、权限确认和执行入口仍由 GeneHub 提供。

## 建议先体验这些路径

| 路径 | 可以验证的交互 |
| --- | --- |
| 手机 → 工具 | 八个现有入口完整可达；工具页面可以返回；工具范围跟随当前机器和空间 |
| 普通 Cursor 会话“调整移动端的工具栏” → 文件卡 | 展开既有风格的工具过程，打开一个与 PM 无关的交互页面 |
| 文件预览 → 写反馈 → 选择会话 | 文件来源与观察版本带入草稿；未自动发送，也不会强制回 PM |
| PM → 执行记录 → Worker → 返回 | Executor 保留流程信息流；受管 Worker 沿用普通 Agent 时间线，查看不变成直接派发 |
| 项目视图 → WorkflowManager 改版 | 同一组 Run 事实从默认列表变成验收优先看板，候选明确未激活 |
| 项目视图 → 模拟页面失败 | 原生状态与执行记录入口仍可用 |
| 待确认 → 批准 → 断线/重连 | 区分保存决定、等待调度和执行；底部输入框与授权操作区互斥 |
| 空间 → 详情 | 全局模态框；不受会话列宽度限制 |

“我的电脑”、设置和终端均是入口与布局演示。演示命令仅响应 `pwd`，其他文本不运行。示例中的 `builds/v0.2` 是项目自行建立的目录，不是平台自动生成或持久保存的产物版本。

## 当前工程的真实基础

以下路径相对于 Open 仓根；Cloud 路径单独注明。基于合并后的源码，而非仅据截图推测。

| 当前能力 | 工程位置与事实 | 对重构的约束 |
| --- | --- | --- |
| 工具菜单 | `packages/workbench/src/shell/ToolsMenu.tsx`：工作区工具、`extraTabs`、全局工具和 `children` 注入；`MobileToolsDrawer.tsx` 已复用同一菜单 | 不另建一份手机菜单清单。`我的电脑` 是宿主扩展，反馈来自宿主插槽，不能直接写死成 PM 菜单 |
| 会话信息流 | `packages/workbench/src/session/TimelineView.tsx`、`session/store.ts`、`protocol/client.ts` | 继续消费 TimelineItem、round/trunk 和原始详情；外壳移动不重建 Agent 订阅，不重放已发送的 prompt |
| Executor 信息流 | `session.flow` 与 Workbench `ExecutorFlow` | 直接读取现有四类消息及 Run 快照；快照表示当前状态，不能凭快照伪造一条历史消息 |
| 预览 | `packages/workbench/src/preview/AssetPreviewPage.tsx` 与现有静态资源装载器 | 已支持工作区 HTML、相对资源、交互、截图和诊断；使用源机器/Workspace/Root/Path，不依赖 Workflow |
| 预览反馈 | `PreviewPopoutPage` 注册继承的诊断 client；主干修复了预览反馈的来源 Session 选择；Cloud `FeedbackLauncher` / `FeedbackPage` | 重用已有 client 和来源会话，不创建第二条连接挤掉原 Fabric，不让重构丢掉刚合入的功能 |
| 截图附件 | `session.artifact.begin/chunk/finish/abort`、预览提交元数据 `genehub.preview-runtime.v3` | 这里的 artifact 是截图/日志等采集附件包，不等于跨项目的“交付产物注册表” |
| Workflow 版本 | `apps/daemon/src/workflow/mod.rs`：编译 DCG，收集 catalog、workflow、role、prompt，生成 Candidate/snapshot | 任意 HTML 目前不会自动进入 source_files 和 digest；要与流程版本一致，必须显式扩展快照收集 |
| 授权恢复 | Session pending interaction、持久 HumanContinuation、project_control broker | UI 不能依赖旧 turn 或旧工具调用仍存活。批准后也不能立即宣称正在执行 |
| 团队关系 | `apps/daemon/bootstrap-packs/game-delivery-v1/pack.json` | 现有 Pack 仍有 WorkflowManager 在 Executor 下的旧配置。原型的 PM 直属关系是待实施迁移，不是已修好的数据 |

### 菜单与导航不应被团队模式吞掉

机器是访问边界，Space 是工作位置和能力配置，Session 是持续任务记录。普通 Space 和团队子 Space 都服从同一套导航规则。团队不是拥有另一套文件系统、设置或工具的应用。

桌面采用可伸缩的列表与内容区；手机同一时刻显示列表或详情，保留返回链与滚动位置。底部“会话 / 待确认 / 空间 / 工具”只是入口，切换入口不销毁对应 Session 或终端。列表允许按普通/受管筛选，默认仍能找到所有有记录的会话。树节点两行：名称为主，Component 小字在第二行，缩进减小；展开子空间与进入空间分成独立动作。

工具抽屉打开时捕获 `{machine, workspace}`，不能一边浏览 A 空间，一边因为后台仍选着 B 会话而展示 B 的 Git 或终端。全局工具明确“当前目标机器”，并保留宿主菜单注入。空间详情用应用根 Portal，手机接近全屏、桌面有足够宽度，处理 Escape、焦点返回、滚动锁和软键盘。

这些是外壳与交互状态修改，不要求更换信息流协议。

## 公共文件引用与预览

### 第一步不新增 Artifact 业务对象

入口来自现有 Markdown 文件链接、文件树、最近打开与用户固定的文件引用。Agent 在消息中提供路径即可；任意普通 Session 都能使用。原型“文件”页展示已知引用，不宣称平台已经自动识别全部交付物。

前端可整理一个内部 FileReference，字段沿用既有文件/预览上下文：

```ts
// 前端概念模型，不是要求新增这些名字的 RPC。
type FileReference = {
  deviceHandle: string;
  workspaceHandle: string;
  rootHandle?: string;
  path: string;
  originSessionId?: string;
  observedVersion?: string;
};
```

实际接入须复用工程已有类型并校验 path/root 关系，避免再造平行身份。外部 URL 仍按外部链接处理，不伪装为当前工作区文件。

`observedVersion` 是本次读取的指纹，不能拿它承诺“任意历史版本都能重开”。希望保留历史作品时，先使用用户已有 Git 或明确的版本目录。只有后续确实需要不可变作品版本、跨会话检索与发布时，才单独设计公共资源目录与保留策略；该系统也不依赖 PM。

### 两种反馈路径共用已有采集能力

- 对作品/文档提修改：附文件引用与观察信息，选择当前授权范围内的可写 Session，先进入草稿；只读 Worker 或没有写入资格的 Session 不可选。
- 对 GeneHub 报问题：保留全局反馈入口，复用截图、日志、来源 Session 与诊断 client；从独立预览打开时也有正确来源。

截图与日志继续走已有分块附件上传和 daemon 返回的附件引用。文件变化后重新预览应提示“当前内容已变化”，不把旧截图和新文件当成同一版本。跨 Workspace 反馈不能仅凭字符串路径授予读取能力；宿主先检查源文件授权，再决定能携带哪些引用或截图。

## 项目 HTML：可自由改展示，有明确宿主边界

用户的方向可行，但应区分两种页面：普通文件预览现在已存在；“读取实时 Run 事实并能发起产品交互的项目视图”需要额外的数据桥和版本合同。后者不能仅把一个网页放进 iframe 就称为接入完成。

### 源文件与版本

建议项目可选地声明一份展示清单，例如：

```text
.genethub/workflow/
  catalog.yaml
  …现有 workflow / roles / prompts…
  views/
    overview/
      view.json
      index.html
      styles.css
```

```json
{
  "schema": "genehub.project-view.v1",
  "entry": "index.html",
  "assets": ["styles.css"],
  "reads": ["selectedRun.summary", "selectedRun.nodes"],
  "intents": ["openSession", "openFile", "composeDraft"]
}
```

以上目录与字段是提议，须在实现时加入 schema，不能当作今天可用的配置。以显式资产清单形成有界 bundle：检查路径逃逸、符号链接、体积、文件数与不支持的资源；不得静默把整个仓库递归塞进快照。HTML 引用未声明的资源应在 Candidate 检查中报错或清晰拒绝加载。

Pack 提供可工作的默认页，安装到项目后成为用户项目文件。WorkflowManager 可按指令调整 HTML/CSS/JS、文案和布局，检查移动端后产出未激活 Candidate。Pack 升级不得无声覆盖定制内容。

编译器显式把展示清单及资产纳入 Candidate digest 和快照；激活沿用现有授权与 revision/CAS；新 Run 固定流程与展示版本。历史 Run 展示它启动时的版本，在途 Run 不随目录里的 HTML 热切换。候选预览使用明确选中的历史 Run 只读事实，标题必须显示“候选预览”，不能冒充它当时使用的页面。无展示配置、旧格式、资源丢失或不支持版本时回退原生执行记录。

### 工作流事实与可定制内容

| 由项目页面决定 | 由 GeneHub 宿主提供 |
| --- | --- |
| 页面布局、业务术语、节点分组、图表、筛选、展开、主题、移动端编排 | 当前机器、空间、Session、Run、固定版本和连接状态 |
| 以不同视角展示同一份已授权 Run 事实 | 事实读取、订阅/重连、去重、顺序与访问检查 |
| 请求打开关联会话、文件，或生成一段指令草稿 | 校验目标与权限；导航或进入草稿，发送前由用户确认 |
| 引导用户提出 Workflow 改进需求 | 原生 Human 授权卡、执行控制、候选激活与审计 |

页面也可绘制自己的时间线，但原生信息流始终可达。不能把 HTML 输出当作执行事实，不能用页面里自称“已批准”产生 grant。第一版数据桥不开放任意 RPC、终端命令、文件写入或直接 approve/activate。

### 复用 Preview 的装载基础，单独定义带数据的宿主模式

当前 Asset Preview 已采用 `sandbox="allow-scripts"` 并核对 `event.source`。这是可复用基础，不代表完整的私有数据隔离方案。

建议增加通用 ViewHost 的受限配置：仍装载标准静态 HTML，使用版本化消息、严格 schema、来源 frame 校验，以及一次装载专用 MessageChannel/随机标识。页面重载、切换机器/Run/快照、关闭视图或撤权后，旧通道立即失效。检查请求大小、频率和目标引用，不把整个 daemon client、令牌或任意调用能力交给页面。

不可信 iframe 通常具有不透明 origin；不能只比较 `event.origin`，也不能用页面传入的 workspaceId 决定权限。使用已绑定的宿主上下文和具体 frame 身份。协议依据：[HTML sandbox 规范](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)、[postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)、[MessageChannel](https://developer.mozilla.org/en-US/docs/Web/API/MessageChannel)。

尤其要区分网络策略：**普通 Preview 能访问网络，不等于可以把私有 Run 数据直接交给任意联网 HTML**。第一版连接运行数据的视图使用受限资源/网络策略，只放行 bundle 与受控数据桥，禁用外部请求、表单、弹窗和顶层导航；不传密钥。必须验证图片、CSS、导入、WebSocket、跳转等旁路。iframe 自身导航与 CPU 占用并非单靠 sandbox 就完全消失，因此不要声称“无法外传”或“硬资源隔离”已由浏览器自动保证：实现阶段需完成威胁评估与真实浏览器负向验证，必要时收紧为可信模板或最小数据集。外部网络授权不进入第一版。

ViewHost 的装载、文件引用、草稿意图应是公共能力；Workflow 只提供一个受限的 Run 数据源。以“普通交互阅读页”和“项目 Run 视图”两种真实用途验收公共边界，暂不建立大型插件市场或任意后台应用平台。

## 协议到底需要改什么

| 切片 | 现有接口可直接支持 | 需要调整的部分 |
| --- | --- | --- |
| 菜单、移动布局、空间详情、Agent 信息流复用 | Workspace / Session / Settings / 终端 / 文件 / 既有 Timeline | 前端路由与宿主插槽；不新增 daemon RPC |
| 公共文件卡、预览与反馈 | 文件资源路由、AssetPreviewPage、已有分块附件、反馈上下文 | 整理前端文件引用和草稿上下文；先不增加 Artifact 注册协议 |
| 初版 Executor 与 Run 视图 | `session.flow`、`workflow.get`、`workflow.history` | 先接现有全量结果；禁止每两秒为所有会话全量拉历史 |
| 大量会话的集中待确认 | `session.get.pendingPermissions`、事件用于选中会话 | `session.list` 目前没有足够的完整投影。需要有界查询/投影待确认及已批准待调度/失败状态，不能长期 N 次 get 扫描 |
| 大型 Run 与实时自定义 HTML | Run 事实已存在 | 后续需要有界快照/游标或订阅合同；必须覆盖断线恢复与过期游标 |
| HTML 与流程同版本 | 当前 Candidate 与 Run digest | 可选 presentation schema、资产快照收集/读取和兼容处理；这是明确的后端/协议改动 |
| HTML 产品交互 | 原有宿主导航、草稿与授权动作 | 版本化、限权的 frame 消息桥；按需要增加受限快照读取，不开放原始 RPC |

“新增界面”不能作为重建 Agent 协议或 timeline 存储的理由。协议演进使用可选字段、能力声明与旧版本回退；旧工作区没有视图仍正常使用，旧客户端遇到新配置也不能静默丢弃配置。

## 实施切片与验收

### A. 保全现有能力的响应式外壳

范围：App/shell、ToolsMenu、MobileToolsDrawer、空间详情 Portal、导航与滚动/草稿状态。保留全部工具和宿主注入。现有 TimelineView、Session store、client 与终端组件继续工作。当前 Space 两行行高与浅缩进保持。

验收：360/390/414px 和桌面；每个菜单可达；切换 Workspace 不串用文件/终端；跨机器切换不串 Session；浏览器返回正确；软键盘与授权卡不重叠；查看 Worker 再返回不丢阅读位置；普通 Cursor 工具、长文本、图片、未知工具和历史 round 展示与旧 UI 一致。手机设置、反馈、设备管理不得遗漏。

### B. 公共文件与反馈闭环

范围：复用预览入口、文件卡与来源上下文；反馈目标选择与草稿注入。Cloud 继续拥有产品反馈业务，Open 不反向依赖 Cloud 包。

验收：普通非 PM 目录中的 Markdown、HTML、多文件相对资源都能打开；同一文件被多会话引用时仍有明确来源；预览断开/关闭不破坏原会话 client；修改文件后版本提示准确；截图/日志上传失败可重试；只读与跨空间拒绝路径有效。

### C. 项目视图的最小只读版本

范围：在现有 Candidate 编译器增加可选展示配置与有界资源 bundle，复用 Preview 装载；第一版只读选中 Run，开放关联导航和草稿意图；默认 Pack 与原生回退。

验收：默认与定制视图消费同一 Run；刷新/断线/旧游标可恢复；旧 Run 展示固定版本；Candidate 未激活时不改变当前 Run；页面异常、缺文件、未知 schema 都可回原生信息流；伪造消息、过期 frame、跨空间引用、未声明文件与网络旁路被拒绝。不能只测截图像不像。

### D. WorkflowManager 引导改版及团队迁移

范围：Skill 引导修改项目 HTML、评估移动体验、生成未激活候选；将 WorkflowManager 迁到 PM 直属，与 Executor 同级，清理将其当交付 Worker 的假设。

新 Pack 使用新拓扑。已有项目先检查活跃 Run、文件归属、revision、用户定制与授权，再生成迁移计划；保留历史 Run/Session 身份，不移动物理目录，不放宽 Executor 只能调度直属 Worker 的约束。迁移失败可保留旧配置使用原生页面。

验收：用户要求“改成验收优先看板”→ WorkflowManager 修改项目文件 → 编译/评估 → 候选预览 → 明确激活 → 下一个 Run 使用新版本；历史与在途 Run 不改变。流程图和展示文件都可追溯，不靠聊天文本猜成功。

### 迭代与回退

A/B 可以先交付，不被自定义 HTML 数据桥阻塞。每个切片做精确复现、受影响模块验证和真实浏览器检查；跨仓合并、阶段检查点再跑一次完整门禁，沿用快速迭代约定。C 默认可选，加载失败回原生记录；A 的导航开关应保留旧外壳回退，底层 Session 与文件身份不迁移。

本轮只提供原型和提案；没有把上述协议、团队迁移或正式 UI 重构当成已实现。

## 本轮提交与验证

- Open 合并提交：`5fa1e0c175c914bfe22fec01177a1f00b6ca7eff`，父提交包含主干 `5f1321110385b246b9c6b434e96b81bf2ae4abf5`。
- Cloud 合并提交：`a6a6e8bbc4c3ac6ad4fb1c1c4a9d5eae71d4fc61`，父提交包含主干 `93de30ddaff787ca74b8fd9f1f387be1fa657cb9`。
- 合并候选门禁：`260906-0031-team-ui-v2-main-merge-1f84`，403/403 passed，0 failed / blocked / unstable / interrupted，qualified，残留进程组 0。门禁绑定提交前的精确双仓候选；受控提交后的 tree 与封印一致。
- 编译与静态验证：daemon library check、Workbench production build、Cloud Console typecheck、差异空白检查通过。Cloud 新增的 React 回归用例已审查，本轮未单独运行它，不能把类型检查写成组件测试通过。
- 原型：真实 Chromium 打开静态 HTML，29/29 交互检查通过；包括手机八个工具入口、普通 Agent 工具详情、非 PM 文件交互、反馈选择/草稿恢复、授权状态、全局详情及项目视图回退。零 pageerror。桌面与手机截图已人工查看。
- 测试记录保留：前两次定向运行的 native-plan 用例曾在外层 30 秒期限处被中断；同一候选随后两次专项和最终完整门禁通过。早期超时的原因尚未证实，不宣称已彻底排除偶发超时；失败记录没有被覆盖或计为通过。
- Open / Cloud 合并分别完成 8 批 / 1 批提交前审查，0 warning。原型与本文作为随后独立的设计提交保存在槽位，提交可从该目录的 Git 历史查看。

完整门禁覆盖的是合并后的产品代码。29 项浏览器检查覆盖的是静态原型；它们不能证明尚未实现的实时 ViewHost、移动外壳或新协议已经通过产品验收。
