# Agent 导航与共享列表

用户界面以 Agent 命名原 Workspace。协议仍以 `workspaceId` 标识，历史 Session、文件定位、授权和 Component 配置不迁移。Cursor、Codex 等运行时选择标为“执行引擎”。

## 复用与显示

- `AgentList` 复用于 Agent 页和新会话选择器；`WorkspaceRow` 保留统一管理菜单、配置 CAS 和全局详情框。
- `RecentSessions` 复用于主会话列表与 Agent 资料页；两者保留相同重命名、归档、删除和受管会话限制。
- `RuntimeSettings` 继续统一执行引擎、模型和模式选择；Fork/转发仍使用 `MachineCatalogPicker` 的跨机器目录与选择逻辑，不复制模型状态。
- 两类列表提供 `comfortable`、`compact` 和按容器宽度切换的 `auto`。宽列表两行，350px 以下收起辅助行；空间不足不靠多列压缩名称。
- Agent 列表默认仅显示根 Agent，右侧箭头独立展开子 Agent。搜索可找到所有层级，展开不切换会话。
- Agent 详情优先呈现自己的会话和草稿，子 Agent 默认折叠。会话、文件、变更和终端仍绑定当前 Agent；全局工具不混入这些入口。

## 会话筛选

`ConversationFilter` 将归属、状态、归档三个维度分开。默认“主要会话”隐藏受管会话及具有有效父 Agent 的会话；可切换“子 Agent 会话”或“全部会话”，再组合受阻和归档筛选。缺失父记录的普通会话仍可找到。直接链接和 Agent 自己的会话列表不受主列表筛选限制。切换设备时重置筛选，避免把上一设备范围误用于另一设备。

## 添加目录

新增小接口 `workspace.addRoot { workspaceId, root } -> workspace`，使用现有 Settings 能力与 workspace 通道作用域。仅接受已有 `.code-workspace` Agent：目录必须存在，最多32个Root，重复添加幂等。

保存时读取最新文件，保留未知配置字段、原目录顺序、原 Agent ID 和已存在 Root handle。新增目录写入 `.code-workspace` 并更新持久注册表；先完成校验，原子替换文件；注册表保存失败则尝试恢复原文件。若检测到外部编辑则拒绝覆盖。文件与注册表并非跨文件事务，极端崩溃窗口可重新打开同一 `.code-workspace` 对齐目录，不能声称跨文件原子提交。

当前保存会规范化为 JSON，不保留 JSON5 注释与格式；目录选择器在提交前明确提示。现有 Agent 进程不会自动重启，新会话使用新增目录。

其余列表、密度、折叠、名称和筛选均为前端调整。未重构 Session/Flow/Agent adapter 协议。
