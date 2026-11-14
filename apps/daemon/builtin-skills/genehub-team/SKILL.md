---
name: genehub-team
description: GeneHub 团队：简单需求前台直接处理，一般交付交合适 Owner，长期目标由 Owner 自主迭代；用于建队、接入、协作、岗位定制及从原语重写团队。
---

# 团队

平台提供 Space、身份编译、timer、会话控制、档位与跨机原语；1+N 团队是一份可改写的样板，不是内核调度器。正本见源码仓 `docs/teams.md`。

| 当前需要 | 读哪里 |
| --- | --- |
| 建队、接入共享团队 | 机器管理员 `../genehub/references/team-admin-skill/team-admin/SKILL.md`，不手搓目录 |
| 已在团队会话内 | 本队 `skills/genet_builtin/team-core` 与岗位 Skill，以本队版本为准 |
| 理解样板接力 | [template.md](references/template.md) |
| 改岗位、流程、脚本或样板 | [customize.md](references/customize.md) |
| 从平台原语重写 | [primitives.md](references/primitives.md) |

样板在 `../genehub/references/team-template/`，入口 `tools/run.py`，内置实现在 `tools/genet_builtin/`；公开扩展见模板 team-core 的 `references/extensions.md`。

- 按怎样完成分流：答复本身就是结果的小事前台直接做；一次交付给合适 Owner，可同时指挥多个独立 Owner；持续质量目标开局由长期目标 Owner 负责迭代。
- 长期目标 Owner 规划、并行派发、检查、总结并续下一轮，未达且授权有效就继续；前台传人的意图、按需查进展，不逐轮审批或转派。未完成条件的原任务跨轮、换人仍累计，不以新 SID 清零。
- `task start/support/send` 都是异步，派出后立即结束本轮，不 sleep、不轮询；结果回精确原请求方，结论用 `task finish`，接收不等于完成，未知沿原编号查回执。
- 重大风险经前台合并同步，Owner 在原授权内继续取舍；后台不挂起等人。用户明确暂停/取消、整体预算/期限和权限边界仍保留，不借自主推进越界。
- 对用户只说真实进展与结论，不提内部类别、目录、脚本和工位；交付实际存在的文件入口，遵守 genehub-preview。
- 改源文件，经 `run.py sync-identity` 或 `spacebuilder.py build` 重编，重开会话读新身份；不手改 AGENTS.md、.agents/skills 或 .genethub/hooks 生成物。
- 反思先提升用户满意度，再改团队工作质量，并约束自己空转：同一事实只处理一次，自己的提交不是新信号，无动作不写报告；交付由 Owner 修。
- 用户不满意先 `run.py note --kind unhappy`，流程改进用 `run.py reflect now`；新样板用 `feedback add/ls/verify` 在本队平台归因通道留线索，尽量绕行、不等回应。旧 docs/platform-issues.md 留历史，发布不等于团队修复。
- 团队可改自己的身份、Skill 与业务策略；内置 Skill 和 daemon 归平台包，重装会覆盖。退役 Workflow（PM/Executor）不用来建队或派单。

## 查询、计时与升级

已知任务沿账本 SID 用 `session get`；当前义务用 `session list --workspace ID --active --include-archived`。历史分页保持原机器和条件，按 nextCursor 直到 complete:true，读取失败是未知，不按空目录重建。

timer 默认 fixed-delay：一次命令及收尾结束后再等 every，不重入、不积压。显式 interval 仅适合短命令，期限为 min(timeout,every×15%)，亚秒不向上取整。修改 hook 源并重编，不提高频率/超时绕错。

unboundedQueryDisabled 要修读取方式，不原样重试；保留原任务、会话、派单、输入、回传和写锁。timer 无待办不查前台历史，有原请求方引用直接使用。正常升级合并定制、构建完整制品并核验实际采用，冲突保留原维护项，不替团队重写业务。
