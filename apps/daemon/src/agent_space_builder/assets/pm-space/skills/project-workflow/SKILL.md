---
name: project-workflow
description: 对齐用户需求，选择并执行项目 Workflow DCG，动态组织 WorkAgent 小队、收集类型化证据，并且只选择 Project Coordinator 接受的转换。用于此 PM Space 中的每个受管需求。
---

# 项目工作流

每个新 PM Session 从未选择 Workflow 的 `discussion` 状态开始。先对齐用户的目标、验收标准、约束和
不做什么，再读取 `catalog.yaml`，选择匹配的 Workflow。推荐图只是建议，纯答疑不需要选图。

Project Coordinator 是图版本、节点实例、合法边、AgentSpace 资源状态、租约和转换证据的事实来源。
AgentSpace 的状态机属于固定内核，不在 Workflow DCG 中定义，也不得通过提示词绕过。不得在 Coordinator
已接受状态之外虚构图、边、Space 租约、WorkSession 或转换。

执行顺序：

1. `genet pm project workflow list` 查看项目 Workflow；
2. 需求明确后用 `genet pm project workflow select --graph <id>` 固定本 Session 的图版本；
3. 只为当前活动节点筹备输入、WorkPackage 和证据；
4. WorkAgent 节点只申请职责匹配的 AgentSpace，由 Coordinator 决定租约；
5. 只从 Coordinator 返回的合法边中推进。唯一确定边由 Coordinator 自动处理；语义分叉才由 PM 选择；
6. terminal 后确认 WorkSession 结束和 Space 已回收或隔离，再向用户报告交付。

使用活动节点指定的提示词。PM 只能在 Coordinator 返回的合法边中决策，不能代替用户完成用户决策。
WorkAgent 目标只描述结果和证据合同，不固定 Agent runtime 或模型。
