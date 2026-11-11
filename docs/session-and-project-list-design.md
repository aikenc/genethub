# 会话与项目列表：交互与排序

- 状态：已实施并在 dev-5 验证；作为合入主干候选
- 日期：2026-11-11
- 适用范围：`packages/workbench` 的 `MachineDirectoryLists`（会话页 / 项目页）、`SessionHeading`、`NewSessionPanel`
- 代码基线：Open `41f652f8` + 本候选改动；Cloud `e7dd53e`（不涉及）
- 相关既有设计：[conversation-filter-design.md](conversation-filter-design.md)、[conversation-organization-multidevice.md](conversation-organization-multidevice.md)、[machine-connections.md](machine-connections.md)

## 先回答三问

**体验影响。** 会话与项目行右侧原本各有 ⋯ 菜单和「打开项目」箭头，横向占用明显；项目展开显示的是会话，在项目面板里点会话会跳到会话页，体验割裂。改动后行内没有 ⋯ 与右侧箭头，操作移到页内菜单；项目行整行点击直接打开项目，左侧箭头只展开成员。范围：dev-5 控制台的两个列表及会话/项目页菜单；daemon 数据、协议与其他槽位不变。

**怎么解决。** 已完成：会话置顶进入会话页右上角菜单、项目置顶沿用项目页菜单；项目展开只列成员（名称/机器/状态/活动图标），点成员打开该成员 Space 页；会话页保持一会话一行、逐会话按自身最新活动时间排序，项目与机器只是行内归属信息。会话视图与项目视图各自持有 `query` / `filter` / `includeArchived`，切页不串台；项目名次在一次目录快照内用 `rankCache` 冻结，不受展开或内部成员活动影响。本文描述的是已落地的实现，不代表额外提案或发布。

**如何避免复发。** 组件测试断言「行内无 ⋯ 菜单、团队行只有展开箭头＋整行按钮、普通项目行只有一个按钮、整行点击调到 `onOpen(target, undefined, workspaceId)`、展开区只有成员按钮且无会话标题、点成员调到成员 workspaceId」；会话页菜单断言置顶与重命名/归档都在页内。目录订阅相关回归由 `testing/specialties/connectivity/directory-subscription-lifecycle.specialty.ts` 覆盖。通过标准是组件用例、完整 merge policy 门禁与 dev-5 smoke 同时绿。

## 具体行为

| 位置 | 交互 | 结果 |
| --- | --- | --- |
| 会话行 | 点击整行 | 打开该会话 |
| 会话行右侧 | 无 ⋯ 菜单 | 「置顶会话 / 取消置顶」在会话页菜单；标为已读、重命名、标签、归档、删除、后台进程、反馈问题也在那里 |
| 项目行 | 点击整行 | 直接打开项目详情 / Space 页 |
| 项目行左侧 | 小箭头，仅团队项目有 | 展开/折叠成员列表，不显示会话、不改 URL |
| 展开的成页行 | 点击成员 | 打开该成员 Space 页 |
| 项目行右侧 | 无独立打开箭头 | 「置顶项目 / 取消置顶」在项目页菜单 |
| 列表级 | 保留「列表选项」菜单 | 刷新列表、查看已归档 |

只读迁移会话（`historyOnly` / `unsupported`）按设计隐藏重命名、标签、归档、删除；可写会话的菜单由 `SessionHeading.test.tsx` 覆盖。项目详情页里出现的「前台」小标签来自 daemon 会话 `labels`，不是本层文案。

内置管理员项目不再因 `projectPinned(..., builtin=true)` 强制置顶；`project-preferences.ts` 的第三个参数保留默认值以兼容既有调用方。

## 会话视图排序与包含

- 一行一条会话，顺序只由该会话自己的 `messagePreview.atMs ?? updatedAtMs` 决定，同时间用 `id` 稳定打破平局；`session-order.ts` 提供 `orderSessionRows()` 与 `splitPinnedSessions()`。
- 默认包含规则集中在 `conversationFilters.ts` 的 `isDefaultConversationSession()`：位于项目根 Space 且不带 `系统发起` 标签。内部成员会话和子 Space 会话不进入默认会话视图。
- 置顶是本地偏好（`session-pinned:${machine}:${sessionId}`，见 `session-preferences.ts`），只把会话移入独立「置顶」区块，不改变其余会话的相对顺序；跨设备/账号同步不在本期。
- 项目搜索由 `project-view.ts` 的 `projectSearchMatches()` 覆盖项目名、根路径、成员名与会话标题；`projectFrontTime()` 只用项目自身前台会话时间，不把成员活动算进名次。

## 与目录订阅的关系

本实现重放于包含 `c98e7d5f`、`2beda9ed`、`41f652f8` 的主干之上，保留以下机制，不得在后续维护中删除：

- `MachineDirectoryLists.tsx` 的 `pendingRefresh`：刷新期间到达的刷新请求合并为一次后续刷新，不被丢弃。
- `prefer()` 接线：把用户正在看的机器（选中的 `machineId`、本机来源、展开项目里的成员来源）传给 `MachineSummaryDirectory.prefer()`，让这些源优先读取、立即重试、最后被置换。项目展开在此处按「成员可见」口径计算，等价于主干里按 `internals` 展开组的口径。
- `setCatalogVersion()`：一次目录刷新完成后递增，`rankCache` 按版本冻结项目名次；与上面的合并刷新循环共用同一个 `try` 块。
- `WorkbenchApp.tsx` 的连接池上限与 `PreviewEntryStrip`、`store.ts` 的 `sessionsFailedAtMs` / `initialMode` 均沿用主干。

## 验收

- `packages/workbench` typecheck 与完整 Vitest；新增 `MachineDirectoryLists.test.tsx`（4 例）、`SessionHeading.test.tsx`（2 例）、`project-view.test.ts`（11 例）、`session-order.test.ts`、`session-preferences.test.ts`。
- 完整 merge policy：`npm --prefix <open>/testing run testctl -- plan|run --gate merge ...`，不按 `--case` / `--tags` 过滤；额外跑未由 testctl 用例覆盖的 JS 构建。
- dev-5 重新构建并用脱离启动会话的 supervisor 启动，核对 `build-identity.json`、`runtime-identity.json`、网关/control/relay 探针与浏览器 smoke。
- 已知基线：`src/session/store.test.ts` 的「removing a workspace registration」与 `src/e2e/journey.test.ts` 的「opens a multi-root workspace and previews a file from either root」在干净主干 `41f652f8` 上同样失败，与本候选无关，需单独决定修复或记录豁免。

## 未决与边界

- 旧版本机侧栏 `shell/ConversationRows.tsx` / `app/ConversationList.tsx` 仍带 ⋯ 行菜单，但未被控制台导出或引用（仅 `shell.test.tsx` 渲染）；本期未删除，避免扩大改动范围。
- 真实可写会话的页内菜单尚未在 dev-5 现场验证（dev-5 的迁移会话均为只读）；组件级断言已覆盖。
- 本文不授权提交、合并或发布；这些动作需另行明确授权。
