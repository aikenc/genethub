# 证据门禁

## 工作包合同

记录 Session 内包 ID、结果、不做事项、输入 commit/产物、能力标签、分支/worktree、验收检查和风险。顺序由 Workflow 图治理，不另建包依赖图。

## 候选记录

- repository、commit SHA、tree SHA；
- Space 源 commit 与 Builder lock；
- 测试/build 命令、退出码和产物摘要；
- 已知限制与接口变化。

## Reviewer 裁决

verdict 必须绑定同一候选和 Intent revision，记录 Reviewer WorkSession、独立 Space、检查、证据、阻断 finding、非阻断风险以及明确 pass/fail。

候选、验收、Skill、Prompt、Workflow 或 Builder lock 变化都会使 verdict 过期。只有当前精确候选的全部门禁通过，Coordinator 才能集成。
