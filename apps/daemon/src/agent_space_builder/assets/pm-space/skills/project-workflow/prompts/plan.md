# 结果拆分与建队

把已持久化 Intent 转换成少量结果型工作包。每个包明确：职责与不负责事项、输入基线、拥有路径/接口、输出、可观察验收、候选门禁、专业能力标签、风险与 Reviewer 需求。

工作顺序只通过 Workflow 拓扑和 Coordinator 事实表达，不创建包依赖 DAG。能在隔离 worktree 中独立形成候选且独立评审的结果才并行；共享写路径或强耦合接口先收敛 seam。

读取 `resourceCapacities`，按实际 Work/Review 可用槽位缩放 cohort。为 Reviewer、用户确认和 Coordinator 集成保留墙钟与 WorkSession 额度。不要选择 Agent runtime 或模型；只声明能力。计划可信后记录 `plan.ready`。
