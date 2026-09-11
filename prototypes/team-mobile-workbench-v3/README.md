# 第三版：沿用现有协议的移动工作台

[打开第三版原型](index.html) · [第二版对照](../team-mobile-workbench/index.html) · [普通 HTML 说明页样例](report.html)

第三版是一个单独新增的静态原型。所有会话、运行和反馈都是演示数据，页面没有连接 daemon，没有执行命令、上传或批准真实请求。第二版文件保持不变。

**设计的必需协议改动为 0。** 复用当前 Open `f84a050`、Cloud `a6a6e8b` 的数据和权限边界，主要改 Workbench 的外壳、导航与既有数据投影。不把第二版的实时 HTML 宿主、集中授权队列、文件版本库或团队迁移作为 UI 改造的前置条件。

## 保留体验，降低实现范围

| 第二版体验 | 第三版实现方式 | 可见差别 |
| --- | --- | --- |
| 手机会话、待确认、空间、工具四个入口 | 会话 / **待回应** / 空间 / 工具；均为现有对象的前端视图 | 待回应展示会话状态，进入原会话才知道具体问题或授权 |
| PM、Executor、Worker 连续查看 | 复用普通 TimelineView、ExecutorFlow 与 selectSession | 不新建聊天、任务或 Agent 事件模型 |
| 一眼看懂项目进展 | 将同一个 `session.flow` 回包的 Run 和节点排成执行概览 | 内置布局；不由项目 HTML 控制实时运行面板 |
| WorkflowManager 修改展示页 | 用现有工具读取运行记录，生成普通 `reports/workflow-review.html` | 可以筛选、展开和改样式；数据是生成时的摘要，不自动刷新 |
| 文件预览后讨论 | 沿用文件链接与 Asset Preview，把反馈追加到来源会话草稿 | 首版不提供任意跨空间改投、文件收藏目录或不可变版本 |
| 查看团队与空间配置 | 两行节点、浅缩进、应用根模态框；读取当前 Parent/Component | 不提前画成已迁移的团队关系 |
| 所有工具在手机可达 | 复用 ToolsMenu、extraTabs 和宿主插槽 | 保留变更、文件、终端、我的电脑、进程、设备、设置、反馈 |

没有为了“零协议改动”模拟一个隐形服务端：浏览器不建立新的调度器、持久授权状态机或全机会话订阅池。

## 建议的体验路径

1. 手机进入“待回应”：有一个普通问题会话和一个项目授权会话。列表只显示标题、归属、Agent、状态和更新时间；点开后再处理具体请求。
2. 从 PM 信息流进入 Executor；切换“执行概览”，选择 Run 015 或 014，查看对应节点与证据；再返回信息流。
3. 从普通 Cursor 会话打开文件，写反馈后回到该来源会话。已有草稿保留，不会自动发送。
4. 从执行概览打开“工作流说明”；筛选验收，展开观察，或打开独立 HTML。点击“请更新这份说明”只把要求带入 WorkflowManager 草稿。
5. 打开全部八个工具，再返回原会话。切换机器或空间后，工具必须显示正确作用域。
6. 空间树和全局详情显示当前 Pack 的真实关系。顶部可模拟断线和受阻。

## 每一块对应什么现有能力

路径相对于 Open 仓根；文中是接口映射，不是声称正式 UI 已完成。

| 页面内容 / 动作 | 已有接口、字段与消费者 | 前端需要做的工作 |
| --- | --- | --- |
| 全机会话与按状态筛选 | `session.list({workspaceId:null,includeArchived:false})`；`SessionSummary.id/workspaceId/title/status/agentId/updatedAtMs/managed`；`session/store.ts::loadSessions`、Sidebar 状态分组 | 复用一个列表，把 `status=waiting` 做成可发现入口。数量是等待的会话数；不冒充全机请求数 |
| 当前问题、计划授权 | `session.get` → `SessionSnapshot.pendingPermissions`；已有订阅与 `session.respondPermission` | 选中后走现有快照/订阅与授权组件；不在列表中并发批准，不为全部等待会话执行 N 次 get |
| 普通 Agent 信息流 | `TimelineView.tsx`、`timeline.ts`、store/client 的 round/trunk 与工具详情 | 保留消息操作、图片、长输出、未知工具兜底、历史加载与阅读位置。只调整外壳，不复制一套渲染器 |
| Executor 信息流与概览 | `session.flow` → `ExecutorFlowStatus.run/messages`；`session/ExecutorFlow.tsx` | 同一个读取 owner 和缓存供两个视图使用。当前节点来自 `run.nodes`，历史来自 `messages`，不相互伪造 |
| 选中项目的最近 Run | `workflow.history({workspaceId,limit:20})` → `WorkflowRunStatus[]`，`workflow.get({workspaceId,runId})` | 按需读一个项目；必要时按 `parentSessionId` 筛选，沿用 `executorSessionId` 进入记录。`limit` 只是返回条数，服务端当前仍扫描有界项目目录；不能宣称新建了增量索引 |
| 空间树、详情与配置 | `workspace.list` 中实际 Parent、Component、health；既有详情管理动作 | 调整布局和 Portal，保留现有 CAS/授权动作。没有空间迁移或目录移动 |
| 文件预览 | `AssetPreviewPage`、`PreviewFloat`、`PreviewPopoutPage` 与既有资源路由 | 复用 `deviceHandle/workspaceHandle/path` 和来源 Session；保留 shared client 的 ownership，关闭预览不关闭工作台连接 |
| 预览采集回原会话 | `session.artifact.begin/chunk/finish/abort`、`uploadSessionArtifact`、`appendComposerDraftLine` | 截图/日志继续作为采集附件包；文字与文件引用可追加草稿。只在成功保存后插入返回的附件引用；失败保留反馈 |
| Workspace / 全局菜单 | `shell/ToolsMenu.tsx`、`MobileToolsDrawer.tsx`、`extraTabs`、宿主 `children` | 一套菜单元数据适配手机与桌面；Cloud 保留“我的电脑”和产品反馈注入，不反向依赖 Cloud |
| 静态工作流说明 | 现有 CLI `workflow history/get`，普通 Agent 写文件工具，Markdown 文件链接 | WorkflowManager 按需读取、写 HTML、返回路径。HTML 只操作内嵌摘要，不访问 daemon |

核对过的协议定义：`packages/proto/src/domain.rs` 的 `SessionSummary`、`ManagedSessionInfo`、`WorkflowRunStatus`、`FlowMessageStatus`、`ExecutorFlowStatus`、`SessionSnapshot`；请求位于 `packages/proto/src/rpc.rs`，真实读取入口位于 `apps/daemon/src/router.rs`。这不是仅依赖前端类型推断接口存在。

## 四个容易再次扩大范围的地方

### 1. “待回应”是会话筛选，不是新 Inbox

`SessionSummary.status` 已有 waiting。当前 Sidebar 本就有“等待交互”分组，第三版提升的是入口可发现性。

列表不展示它没有的计划正文、请求类型、影响范围或“一键全部批准”。进入选中会话再读取 `pendingPermissions`；列表可能滞后，应以新快照决定现在是否仍有可操作请求。普通提问和项目授权共用这个入口，各自沿用已有组件。

点击后可以马上显示本地“提交中”。只有收到现有回应/permissionResolved 才显示“决定已接受，等待会话更新”；只有 turnStarted 才显示执行开始。**现有公开快照没有一个完整的 durable queued projection**，因此不画可跨重连恢复的“已入调度队列”阶段。刷新后按服务端当前状态展示，不能拿本地计时器补造这个结论。

原型用时间推进模拟这几次响应，以便体验；正式前端按事件/快照推进，不照搬演示计时器。

### 2. 运行看板只是已有快照的另一种排版

`WorkflowNodeRunStatus` 提供 id、uses、status、sessionId、evidence，没有每条边、业务百分比或节点实际耗时。第三版只画节点卡，不画可编辑 DCG、依赖箭头、预计完成时间或假进度百分比。标签优先用真实 node.id / uses，完整详情可展开。

消息时间来自 createdAtMs；派发消息的 Worker 入口来自 recipientSessionId，完成消息来自 senderSessionId。原型为可读性使用的 time/worker 是演示视图字段，不新增到协议。

已存在的四类消息是 `run.requested`、`node.assigned`、`node.completed`、`run.completed`。未知 kind 保留详情。没有新的“失败消息”就只展示当前受阻状态，不向历史插入一条浏览器推测的事件。

沿用 ExecutorFlow 的串行刷新方式，仅刷新当前可见 Run；切换 Session、机器或 Run 时丢弃旧 owner 的迟到结果。多个视图不能各起一个轮询。进入终态后停止定时更新，保留手动刷新；页面不可见时暂停前端刷新即可，不涉及 daemon 调度变更。读取失败保留上次内容并标记，可重试。

PM 中的 Run 摘要按当前项目有限历史和 parentSessionId 关联，不从 LLM 文本里猜 runId，不全机扫每个 Workflow。旧 Run 没有 executorSessionId 时，可读 `workflow.get` 展示已有快照并说明没有独立执行信息流入口。

### 3. HTML 先做项目文件，不做实时运行宿主

用户仍可以说“把说明改成验收优先看板”。WorkflowManager 读取现有运行事实，生成或修改 HTML/CSS/JS，并在消息中给出文件链接。页面可以有交互筛选、折叠、图表和自己的样式；页面数据来自文件内嵌的读取结果。

第三版的两个表面各有用途：内置执行概览回答“现在到哪一步”，HTML 说明回答“怎么理解和改进这套工作”。更新说明通过普通会话要求 Agent 重新生成，刷新预览读取当前文件。文件写错时沿用 Git 或用户已有文件恢复方式，不引入展示版本库。

HTML 不进入 Workflow Candidate/dcgDigest，不自动跟历史 Run 固定，不获得 Run 数据订阅、RPC client、批准或激活能力。正文标明 Run ID、读取时间和静态性质。实际流程候选与激活仍沿用现有工作流能力，说明文件的布局修改不必激活流程。

如果希望 Pack 提供默认说明模板，可以把普通模板作为项目资产拷贝；初版也可直接由已有 Skill 引导生成。无需为此修改 Candidate 编译器或 daemon。已有项目不自动覆盖用户说明文件。

### 4. 公共预览保留既有来源，先收紧反馈范围

普通会话里的 Markdown/HTML 文件链接已经可以预览。第三版“文件”页是当前会话已知文件引用的前端整理，不是自动提取、扫描或注册所有“交付物”。无引用就展示空态与文件入口。

反馈先回到预览上下文携带的来源 Session，用已有 `appendComposerDraftLine` 追加，避免覆盖草稿。来源只读、关闭、缺失或无法确认写入资格时，不提供发送成功假象；可以复制文字再自行选择会话。权限以 `managed.userInteraction` 与既有状态/能力声明判断，不以 Coder/Reviewer 名称推断。

未从会话打开的文件，允许预览；缺少来源 Session 时，不自动创建会话或替用户选 PM。没有来源的截图采集按现有可用能力降级，不制造附件上传的目标身份。

第一阶段不用“观察版本”保证历史可重放；文件内容就是这次读取的内容。对于稳定留存，使用项目自建版本目录或已有 Git。跨空间改投、公共资源目录、版本保留等都可以以后独立评估，此版不依赖。

## Mobile 布局与能力保全

- 手机仍是列表/详情单列，底部四个入口；桌面并列列表与详情。两种宽度使用相同 Session store/client，切换视图不重建连接、清空草稿或终端。
- Space 名称主行，Component 第二行小字，缩进减小；展开箭头与进入空间独立。浏览 Space 与发送新 Session 分开，实际改造时保留现有深链和 `selectWorkspace` 的草稿行为，不把原型里的“浏览空间”当成静默替换。
- 全局空间详情放应用根 Portal，手机接近全屏。授权卡与 Composer 互斥；长内容可滚动，按钮可达，正文与输入不依赖 hover。
- 工具打开时固定当前机器/Workspace 作用域。设备、全局设置、宿主工具都保留；返回时恢复原会话和滚动位置。
- 原型的流程节点列表只表示 Run 分工；空间树仍按真实 Parent。当前 Pack 的 WorkflowManager 仍在 Executor 下，这个已知团队设计问题单独处理，不要求 UI 先改 daemon 或伪造同级。

## 允许的协议微调预算

本版不需要微调。若后续一定要在待回应列表区分“问题 / 计划授权”，可评估给 `SessionSummary` 增加一个**可选的交互类型提示**，从已经保存的 pending interaction 推导。旧端仍显示普通 waiting；新字段不承载决定，也不授予操作权限。

这应是独立的小改动：定义进 `packages/proto`、补兼容序列化验证；无需新增队列、数据库、索引、状态机或广播通道。不把该提示变成第三版交付依赖。需要多个请求明细、精确全机计数、跨机聚合时，已经超过本轮微调范围。

## 按现有工程落地

| 顺序 | 改动包 / 组件 | 验收与回退 |
| --- | --- | --- |
| A 导航外壳 | App、Sidebar、MobileTitleSwitcher、ToolsMenu、MobileToolsDrawer、空间详情 Portal | 普通/受管会话都可达，八个菜单可达，返回与多机作用域正确；保留旧布局切换，底层 store 不迁移 |
| B 等待筛选与流程概览 | Sidebar 现有 status 分组；复用 TimelineView；拆出 ExecutorFlow 的读取 owner 供信息流与节点概览共用 | 列表无隐藏 N 次 get；只读当前 Run；一份数据、一次刷新；未知消息/空态/断线/失败可理解 |
| C 文件与说明 | Markdown 文件入口、PreviewFloat/AssetPreviewPage、既有草稿追加；WorkflowManager 普通会话 | 非 PM 文件可预览；反馈保留原草稿与来源；HTML 说明明确静态且不影响真实 Run |

不增加生产协议字段即可先交 A/B/C。少量 React 状态重组仍需要实施和验证，“不改协议”不等于把静态页面直接替换进正式 Workbench。

本轮只验证设计资产：脚本语法、相对依赖、实际浏览器交互与手机/桌面布局。正式实施再跑受影响 Workbench 测试及真实 dev 路径；按照快速迭代约定，不为静态原型重复执行跨仓全量门禁。原型不能证明真实 Safari 软键盘、跨端续接或后台恢复已经验收。

## 本轮验证

- Chromium 真实打开入口 HTML 与独立说明页：34/34 交互检查通过，无 pageerror 或缺失资源。覆盖 360/390/414px 布局、普通问题与计划授权、当前/历史 Run、来源草稿追加、真实 Parent 和全部工具入口。
- JavaScript 语法检查通过，HTML 相对资源与文档链接均指向存在的普通文件；每个文件远小于 Preview 的 64 MiB 上限。
- 手机和桌面截图已人工检查。第二版文件无变化；正式协议、daemon、Workbench 源码、Cloud 及 dev 运行环境均未改动。
- 这些检查只证明静态交互原型可使用，不等于新 Workbench 已部署或真实后端旅程已通过。
