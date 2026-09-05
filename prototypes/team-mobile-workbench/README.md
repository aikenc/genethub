# GeneHub 团队协作工作台：Mobile 交互研究

研究基线：2026-09-05，`dev-agent` 分支 `fd09a7c`。当前两行 Space、紧凑缩进、全局详情弹框和 Executor 信息流已经提交。本文与 [单页交互原型](index.html) 是下一形态的设计研究，不是已部署功能说明。

## 1. 建议：继续以 Session 做事，把人的注意力从执行细节中释放出来

新的团队模式没有让 Session 过时。相反，同一个持久 Session 已经能够承载人类目标、模型对话、机械执行和人在回路的决定。值得改变的是导航和阅读尺度，而不是另建一套 Task 聊天产品。

建议的主路径是：**回到正在做的会话 → 看懂当前状态 → 需要时做决定 → 直接查看产物并反馈。** PM 管理目标；Executor 的结构化消息进入同一阅读界面；Worker 会话可以深入查看；空间关系和配置按需展开。普通会话从始至终是一等入口，不要求经过 PM 或团队初始化。

原型使用三个当前机器内的视图：**会话、待确认、空间**。它们是现有对象的查询和呈现，不是三套数据副本，也不是三种 Session 类型。手机用底部导航切换；桌面用导航栏切换。重新打开正式产品应恢复可解析的最近会话或深链，不能每次强迫用户先经过首页看板。

这里的“团队”专指 AgentSpace 协作，不扩展为多人组织、成员邀请或账号项目同步。

## 2. 先看工程，哪些判断已经有依据

| 核对位置 | 当前事实 | 对设计的约束 |
| --- | --- | --- |
| [Sidebar.tsx](../../packages/workbench/src/shell/Sidebar.tsx) | 最近、状态、项目分组已经存在；跨 Workspace Session 同时可见；列表独立轮询，已读边界在客户端 | 不能把“全机最近会话”当成全新功能；也不能悄悄退回“只见当前项目”。不把已读同步说成已实现 |
| [store.ts](../../packages/workbench/src/session/store.ts)，`selectWorkspace/selectSession/newSession` | 点击 Workspace 地址进入该空间草稿；点击 Session 跟随实际归属；草稿首次发送才创建；关闭标签不删除会话 | Space 浏览、Session 切换、创建会话必须是可区分的操作。切换上下文不能把另一个 Space 的文件带进来 |
| [MobileTitleSwitcher.tsx](../../packages/workbench/src/shell/MobileTitleSwitcher.tsx)、[App.tsx](../../packages/workbench/src/App.tsx) | 手机已有全高抽屉、标题中的标签切换、深链、会话阅读恢复；宽屏支持并排文件/变更 | 新方案要保留接力、返回和上下文能力，不能只把桌面多栏缩小 |
| [domain.rs](../../packages/proto/src/domain.rs)，`Workspace/AgentComponentInfo/ManagedSessionInfo` | Component 可组合；受管 Worker 仍是普通 Session；是否允许操作来自 `userInteraction` | 不按名字、头像或厂商品牌推断权限。不创建 PM/Executor 两种互斥会话类型 |
| [domain.rs](../../packages/proto/src/domain.rs)，`ExecutorFlowStatus/WorkflowRunStatus/FlowMessageStatus` | Run 与 Executor Session 绑定；消息有稳定 ID、关联和时间；Run 当前状态与消息账本分开 | 统一视觉信息流可以做，不能把 FlowMessage 伪装成模型回答或写回模型上下文 |
| [ExecutorFlow.tsx](../../packages/workbench/src/session/ExecutorFlow.tsx)、[workflow/mod.rs](../../apps/daemon/src/workflow/mod.rs)，`record_flow_start/record_flow_completion` | 现阶段持久消息主要是 `run.requested/node.assigned/node.completed/run.completed`；当前快照包含节点与 evidence | 不凭轮询结果补造历史事件；没有进度数据就不显示假百分比或预计结束时间。受阻原因可展示当前快照事实，不伪造“刚刚发来的消息” |
| [architecture.md §3.4](../../docs/architecture.md)、[session/manager.rs](../../apps/daemon/src/session/manager.rs) | 授权请求持久保存后停止 adapter turn；Human 决策落盘后，新 turn 继续同一 Session/业务 round | 等待人时不画 Agent 一直思考的动画。批准仅表示决定已接受，排队与真正执行要分开；关闭页面不等于取消 |
| [pack.json](../../apps/daemon/bootstrap-packs/game-delivery-v1/pack.json)、[WorkflowManager Skill](../../apps/daemon/bootstrap-packs/game-delivery-v1/spaces/workflow-manager/skills/workflow-manager/SKILL.md) | 当前 WorkflowManager 仍是 Executor 子节点，声明 Worker + Executor；改进只产生未激活 Candidate | 建议拓扑还不是现状；不能靠 UI 改父节点来掩盖模型差异。评估通过也不等于已激活 |
| [web-workbench.md §2.4、§2.6、§2.8](../../docs/web-workbench.md) | Workspace 属于当前目标机器；文件按真实根身份寻址；手机有固定 body、16px 输入、键盘避让约束 | 不做跨机假目录；移动端必须显示目标机器；预览需保留真实 workspace/root/path，不能只保留文件标题 |
| [engineering-guidance.md](../../docs/engineering-guidance.md) | 多机、资产归属、Agent 可替换、会话接力和减少人机往返是工程判据 | 评价新 UI 应看用户完成决定和反馈的路径，而不是面板数量 |

研究也对照了槽位中的 PM/DCG 合同与实际 Pack。文档中的目标消息集比当前持久账本更广，不能以提案枚举证明这些事件已可订阅。

## 3. Workspace 与 Session 的矛盾：两个不同维度共享了一个展开动作

Workspace/Parent 表示稳定归属，Session 表示持续增长的工作记录。当前一层展开同时展示子 Space 和本层会话，并在递归顺序里争夺同一段垂直空间。这个问题发生在所有带子空间、子仓库或大量会话的场景，PM 团队只是放大了它。

已有“最近/状态/项目”分组实际上已经有两个观察角度。改进应首先让这个切换可发现，而不是立即删除树或创造新的项目门户。

| 方案 | 能解决什么 | 代价与结论 |
| --- | --- | --- |
| 只保留递归 Space + Session 混排 | 归属关系直观，无导航迁移 | 两行名称能改善可读性，但会话增长仍挤压树；保留为现有基线 |
| 所有用户先进入项目总览，再进入会话 | 单项目归属清楚 | 跨项目切换变慢，普通聊天多一步；不作为默认入口 |
| 默认隐藏 Worker，只给 PM 会话 | 列表短 | 用角色猜用户意图，受管工作难排查，普通场景无收益；不采纳这种强制隐藏 |
| **会话视图与空间视图并列，选择只改变观察范围** | 会话按时间找，结构按归属找，列表可跨空间 | 增加一个视图切换，需要保留路径和返回位置；在原型中验证，尚未决定替换现有导航 |

原型中的规则：

- **会话**：当前机器全部 Session，受管会话也可见；可搜索和筛选状态。所属 Space 在第二行，名字有完整主行。大规模时可以提供“全部/我发起/受管”显式筛选，不能根据角色自动消失。
- **空间**：Parent 树只负责展开空间。名称与展开箭头分离；点名称先显示空间上下文与本层会话，显式“新会话”才进入草稿。这个点击行为是设计提议，和当前 `selectWorkspace → draft` 不同，落地必须单独评估路由兼容。
- **待确认**：同一机器中真实未处理的 Human interaction。不是运行通知、未读消息和失败的混合垃圾桶；失败仍在会话的“受阻”筛选。每项包含来源、目标、影响范围、原会话入口，并调用原授权操作，不另建一份批准按钮状态。
- 进入 Worker、文件或空间详情后，返回原 Session 和阅读位置。机器切换先改变整个范围；远端离线展示那台机器的离线状态，不偷偷显示上一台机器的目录。

## 4. 信息流是主要工作表面

### 一条阅读路径，保留不同消息的来源

| 内容 | 呈现 | 点开后 |
| --- | --- | --- |
| 用户/PM 的自然语言 | 可阅读的正文，作者与时间明确 | 普通消息操作 |
| 运行摘要 | 紧凑 Run 卡：目标、当前步骤、最近事实、结果入口 | 同一 Run 的 Executor Session |
| Executor 的机械消息 | 有连接线的流程记录，明确标识“流程记录”，按持久顺序显示 | 输入、输出、evidence、关联 Worker 会话；未知 kind 保留原类型和详情 |
| 工具输出 | 一行摘要，错误展开优先；长输出按需查看 | 现有工具详情，不把每行终端输出都变成卡片 |
| Human 决定 | 会话中保留请求与决定；底部只放当前决策动作 | 范围、后果、有效性与提交状态。处理完保留记录 |
| 可查看产物 | 路径与版本明确的产物卡 | 全屏预览、可编辑的反馈草稿 |

PM 看目标和少量 Run 摘要；Executor 看详细事件；Worker 看普通工具/LLM 时间线。三者的视觉语法一致，信息密度不同。跨来源事件在没有统一序列前，不按浏览器到达时间假造一条严格全序：PM 内嵌关联 Run 摘要，Executor 保留自己的消息序列，点击进入细节。

“当前状态”与“历史记录”分开：节点现在受阻可以在顶端说明，但缺少持久事件时，不能在历史里凭空插入 `node.failed`。显示“最近更新于…”让人判断是否需要干预，不把模型安静的时间直接判为崩溃。

Composer 也按真实能力变化：普通/PM Session 可发送；受管只读 Session 给出清晰说明和返回发起会话入口。Executor 的机械控制不能让用户通过聊天文本任意跳节点；控制按钮必须来自声明能力与当前状态。

### 授权状态必须说实话

请求已保存且等待 Human → 提交决定 → 已批准、等待调度 → 新 turn 已开始 → 完成或明确失败。

点击后显示提交中，只有持久 Ack 才显示已批准。请求失效时展示失效原因和回原会话重新计划的入口；拒绝不会启动执行。断线期间保留最后快照、显示未同步，不能批准一个尚未重新核实的旧卡。重连后同一 requestId 已处理则更新结果，而不是再次弹卡。

本原型用本地演示状态和时间模拟这条链，仅用于看交互。它没有调用任何真实授权 API，也不构成 daemon crash 恢复验证。

## 5. 手机是完整的工作终端

重点场景不是在手机上读数百行 diff，而是：接到决定、看够上下文、确认或纠正、查看产物、回到自己的生活。深度阅读、普通对话、文件和团队仍然可达。

| 屏幕 | 布局 | 保持一致的语义 |
| --- | --- | --- |
| 小于 700px | 一次一层：列表或会话；三个底部入口；会话内信息流/产物/空间；返回恢复原位置 | 机器、空间、会话身份和草稿不变 |
| 700–1199px | 列表与会话两栏；上下文用全局面板打开 | 同一选中项、同一来源记录 |
| 至少 1200px | 导航、列表、会话、轻量上下文并排 | 上下文是辅助，不另建一套事实 |

这些断点是本原型的布局选择，不冒充平台标准。切换原型顶端“手机”时使用同一 DOM 与同一状态，能直接检查桌面选中会话在手机上如何继续。

交互系统约束：

1. 核心操作目标至少 44×44 CSS px；正文 15–16px，输入 16px，Space 主名称 15px，标签独占第二行。树缩进每层 8px，深层结构可以进入该分支，不无限压缩名字。
2. 底部导航负责去哪里，当前会话的底部操作区负责做什么，二者不混为一条工具栏。授权占用操作区时 Composer 不渲染；长计划在主体滚动，按钮留在可达范围。
3. 手机打开产物为全屏工作表面；长详情为全局可滚动面板。桌面可以并排。不能为了好看，把长授权或 Component 配置塞进只能露出两行的矮 Sheet。
4. 键盘出现时给内容和输入区真实让位，保留足够的消息区域；处理 visualViewport 与 safe-area。不禁止缩放，不依赖 hover 或滑动手势才可操作。
5. 搜索、返回、刷新、关闭都可点击且有名称；模态有焦点范围、Escape 与恢复焦点；状态有文字，不只依赖颜色。减少动态效果设置应生效。
6. 离线时保留缓存阅读并明确更新时间。可保存本地草稿，执行/授权/变更不可伪装成功。原型会模拟这个区别；正式版需要从当前连接 owner 读取状态。

外部交互依据是对这些选择的支持，不替代工程事实：Apple 将 Tab Bar 用于稳定的顶层入口并保留各自导航状态；因此原型三个入口不随 PM/普通会话变动。[Apple HIG](https://developer.apple.com/design/human-interface-guidelines/tab-bars)

Android 的 list-detail 布局按可用空间从单层切换到并列，支持在形态变化时保持选中内容；这里借用布局原则，不引入 Android 专用技术栈。[Android 官方布局指南](https://developer.android.com/develop/adaptive-apps/guides/list-detail)

WCAG 2.2 AA 的目标尺寸下限为 24×24 CSS px，含间距等例外；本方案主动采用更宽松的 44px 操作目标，不能说“WCAG AA 要求 44px”。[W3C 解释](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)

## 6. 团队关系和 WorkflowManager

建议拓扑：PM 下的 WorkflowManager 与 Executor 同级；Coder/Reviewer 在交付 Executor 下。这里的 WorkflowManager 是项目角色，不发明一个新的内核 Component。

角色信息应说明负责什么、当前在做什么、能否接受用户操作，而不只是把 Component ID 排成彩色标签。配置依然在全局 Space 详情里；当前 Run 的 Worker 卡只表示本次分工，不能拿它代替 Parent 树。

**原型展示建议关系，现有 Pack 仍是旧关系。** 真正迁移涉及 Pack 版本、直接 Worker 角色解析、WorkflowManager Skill、DCG evaluation 和 Parent CAS；需在没有活跃冲突时经授权迁移。不能把它作为这一轮原型工作顺手改掉，也不放宽“Executor 只调度直属 Worker”的边界。

WorkflowManager 的输出是带 Run 依据、变更与评估的 Candidate。界面明确“未激活”；查看评估和向 PM 讨论是下一步。在途 Run 保持原快照。激活权限与具体协议就绪前，不画一个点了就生效的开关。

## 7. 产物进入协作，而不止是一个附件

原型把营地小游戏的预览放在会话产物视图中，支持昼夜切换、点击移动和填写反馈。反馈先带着产物名称/版本进入 PM 草稿，人检查后发送。预览和体验数据均为本页绘制的样例。

第一阶段可以复用已有 Asset Preview 和普通文本草稿，不需要新协议。正式路径应携带 `machine + workspace + rootHandle + relativePath + 可用的版本身份`，避免把旧产物的评论套在最新文件上。历史文件不可读时明确说明，不用同名最新文件替换。

在预览中点选对象、录制试玩、结构化反馈回传是后续能力：目前不能把按钮画出来就说产品已经支持。要先定义不可信内容标记、schema、大小/频率限额和 Human 提交边界；作品里的任意脚本不能自动批准、发消息或扩大权限。

## 8. 实施切片与数据缺口

| 切片 | 可复用工程 | 必须补齐的部分 | 验收 |
| --- | --- | --- | --- |
| A. 导航可发现性 | Sidebar 已有三种分组、Space tree、session.list、稳定 Session 路由 | 先让分组切换可见；评估原型双视图是否值得替换；移动列表/详情返回状态；Space 浏览与草稿入口区分 | 普通多空间、父子仓、PM 团队都能找回会话；不隐藏受管 Session；跨机切换不串数据 |
| B. 统一信息流呈现 | TimelineView、ExecutorFlow、session.flow、managed 绑定 | 复用卡片语法和 Run 导航；把快照与历史分开；未知类型兜底 | 不启动 LLM 也能读懂 Executor；进入 Worker 再返回原位置；乱序/重复响应不污染别的会话 |
| C. 当前机器的待确认视图 | 持久 interaction 和 Human response | session.list 没有完整授权摘要；需要有权限的轻量投影/索引，避免轮询订阅所有会话；requestId 与当前 revision 核验 | 普通提问和项目授权都可见；处理状态同源；失效、重复、拒绝、断线明确 |
| D. 产物反馈 | Asset Preview、文件身份、普通草稿 | 先做文件引用与版本提示；结构化对象选择需独立协议 | 手机查看→反馈→原会话不迷路；不自动发送；旧版本不会冒充新版本 |
| E. 团队与方法改进 | AgentSpace/Parent/Component、Candidate/evaluation | WorkflowManager 合同迁移；Capability 声明决定动作 | 团队展示和真实授权关系一致；在途 Run 不变 |

不把跨机器待确认汇总、OS Push、人工组织协作、跨机调度、耗时预测、完整 B7 故障恢复写成这一轮现成功能。当前原型仅切换独立机器目录，不聚合它们。

## 9. 原型评估方式

先用原型验证下面的行为，再决定正式产品改造范围，不能因为页面做完就默认导航方案通过。

- 手机打开，进入“待确认”，读懂星轨项目的影响范围并批准；观察“等待调度”与“执行中”的区别。
- 打开微光营地 PM 会话 → Executor 运行 → Coder 会话 → 返回。查看受管只读提示和上下文。
- 普通笔记 Space 新建/发送，确认它不需要 PM；列表可以同时看到普通与受管会话。
- 空间树展开与选择分别点击；选择子空间后名字与会话归属都能读清。
- 进入产物，切换昼夜、点击移动，写反馈；返回 PM 草稿并自行发送。
- 切换手机/桌面，切换机器、模拟断线、恢复连接；检查没有身份串用或离线成功提示。
- 查看 WorkflowManager 的评估 Candidate，始终明确未激活。

观察指标建议：从打开到定位待确认请求的操作数；是否能复述影响范围；从 Run 到 Worker 再返回的迷路次数；产物反馈的完成动作数；错发到另一 Space 的次数。它们目前是需要测量的指标，没有用户研究数据，不能宣称本方案已降低某个百分比的成本。

### 本轮方案门

引导 blob `e154bb077060507b793b6f14d51c8425ebd8e78d`；律法 blob `7cd41fa9eda236154ba813ed1f2c9b7be1420561`。交付模式为 `guest-only` 范围中的独立静态设计资产，不构建或替换 guest/host，不改协议/正式 UI。

G01/G05 适用：各机器独立目录，资产本地，Session 持久语义保持；G02 适用：普通会话与组合组件团队是两个真实形状，不增加生产抽象；G03 适用：映射已有协议，缺口显式列出；G04 适用：静态文件，无 native 变化；G06 适用：按决定/反馈路径评估；G07 适用：只读 Worker 和授权状态约束动作；G08 适用：演示输入仅转义文本、不请求外部数据、每条输入限制 2000 字；G09 适用：列出行为指标，本页不上传遥测；G10 适用：只交付原型及研究，无部署/迁移；G11 适用：用真实浏览器打开静态文件、操作状态并测量布局，所有业务数据为模拟，不声称生产旅程通过。

验证覆盖静态脚本语法、依赖/外链检查、手机/桌面布局、关键交互、模态键盘、离线与恢复及重新打开的演示状态。无生产路径变动，因此不重跑跨仓全量产品门禁。浏览器验证结果在完成检查后记录于任务证据；真实 Safari 键盘/手势、实体机和用户可用性尚需后续实测。
