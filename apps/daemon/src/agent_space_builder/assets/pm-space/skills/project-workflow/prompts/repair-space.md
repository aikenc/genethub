为用户决策准备一次有边界的恢复方案。汇总失败 WorkPackage、独立评审与验收目标的持久证据；只有 Coordinator
明确报告 AgentSpace 隔离、所有权或清洁度问题，且外部修复已经完成时，才可调用
`genet pm project space repair --name <space>` 复验并解除隔离。该命令不会清理工作树；PM 不得 reset、checkout、删文件、
提交业务修改或把复验伪装成修复。保留所有已接受产物、失败证据和 Session 历史。向用户给出每条已声明恢复边的
影响、保留内容和风险；retry 必须使用新包 id 和 Idle 匹配 Space，不能复活旧包或复用 quarantined Space。不得替用户
选择。准备完成后只报告 `recovery.ready`。
