---
name: project-workflow
description: 使用本项目版本化的 Workflow、中文阶段提示词和评测来管理需求、团队、预算、独立评审、用户决策与确定性集成。用于此 PM Space 的每个受管需求。
---

# 项目工作流

本目录是项目自己的管理方法源：`catalog.yaml` 选择图，`dcg/*.yaml` 决定拓扑/容量/恢复边，`prompts/*.md` 决定各角色目标，`evaluations/*.yaml` 是同一 Workflow 身份的一部分。新 Run 会固定图、提示词和评测摘要；运行中不能偷换。

Rust 内核只提供关闭式安全活动：`pm`、`work`、`review`、`integrate`、`userDecision`、`observe`。项目可组合拓扑、中文 Prompt、fanout、Reviewer capacity 与有界恢复，但不能重定义租约、只读评审、Git 集成或用户权限。

## PM 职责边界

PM 负责目标、Intent、拆包、建队、派工、预算/范围取舍和 Reviewer findings 的返工路由。PM 不写业务代码、不进入候选做技术复评、不跑测试替 Reviewer 验收、不覆盖 verdict，也不手工 Git 合并。

Worker 负责实现与自测；Reviewer 在独立 Space 中只读评审精确候选；Coordinator 校验身份、租约、协议和 verdict，并在 `integrate` 活动中确定性集成。

## 执行顺序

1. 澄清可观察目标、验收标准、约束和不做事项。
2. `genet pm project workflow list` 读取项目图；需求明确后执行 `workflow select --graph <id>`。纯答疑不选图。
3. 首次规划时读取一次 `workflow status`。Supervisor 批次已给出明确动作和 workspace 时直接处理，不重复查询。硬预算只有 `remainingMs`、`maxWorkSessions`、`maxConcurrentWorkSessions`；用户决策节点会暂停墙钟。V3 不以推断出来的 LLM round 终止 Run。
4. 用 `intent set` 固定本 Session 的目标和验收。没有 Intent 不得创建任何工作包，bugfix/migration 也不例外。
5. PM 活动完成后，只记录该节点声明的 output，并选择 Coordinator 返回的合法边。`work.*`、`review.*`、`baseline.*`、租约与 Space 事实只能由内核推导。
6. Work 节点按 `resourceCapacities.availableSlots` 建队；`fanout.maxItems` 不是现有容量。工作包 ID 为 Session 局部命名，顺序完全由 Workflow 图治理，不创建第二套依赖 DAG。
7. 同一 fanout 严格执行：全部 `package put` → 全部 Ready → 全部 `agent run --no-wait`。首个 Ready 会封闭 cohort。
8. Candidate 到达真实 `review` 活动后，使用该节点固定的 selector、中文 `review.md` 和 `capacity` 派发独立 Reviewer。Coordinator 会把本 Run 的精确 Intent、包边界、commit/tree 和项目提示词注入 Reviewer 系统合同；PM 只需复用原 WorkPackage id 和 Supervisor 给出的 workspace 批量启动，不另建 Review 包，也不重写技术评审合同。
9. `review-pass` 后进入用户交付确认节点；用户批准才进入 `integrate`，取消则结束本 Run。PM 不能冒充用户选择。
10. `review-fail` 进入 PM triage：只依据验收影响、范围与剩余预算选择有界返工或升级用户，不读代码重判。
11. Coordinator 串行集成 accepted slices，并在 merged baseline 上做完整门禁。冲突走恢复边。
12. terminal 后确认 Session 已结算、Space 已回收或隔离，再向用户报告可用交付、证据、限制和体验入口。

## 恢复约束

Coordinator 因候选工作树不干净而无法固定身份时，会先在原 Worker Session 中自动且仅一次要求它完成提交与清洁；PM 不介入实现。若仍失败，包进入 Blocked、Space 进入 quarantined，失败证据与租约保留。

`genet pm project space repair --name <space>` 只复验已经由外部纠正的已登记 Space，不会 reset、checkout、删除文件或替用户清理。用户选择 retry 后，旧包不可变地保留为 Cancelled/Blocked 证据；新的 Work 节点迭代必须使用新包 id，并且只能使用 Coordinator 返回的 Idle 匹配 Space。若没有干净容量，按项目图的 replan/cancel 等恢复边向用户报告影响，不能复活旧包、夺取隔离 Space 或伪造完成。

## 公共命令

```text
genet pm project intent set --outcome <目标> --acceptance <标准> [--acceptance <标准> ...] [--constraint <约束> ...] [--out-of-scope <不做事项> ...]
genet pm project workflow transition --edge <当前 PM 出边> --fact <当前 PM 活动声明的 output>
genet pm project package put --id <Session 内稳定 id> --title <职责> --outcome <结果与证据> --repository <仓库> --branch <独立分支> --node <活动 work 节点> [--space-tag <专业能力> ...]
genet pm project package transition --id <包-id> --to ready
genet agent run --agent <第三方 Agent> --model <原生 model> --workspace <Coordinator 选中的 workspace> --work-package <包-id> --no-wait "按 Run 固定合同独立评审精确候选"
```

不要执行 `--help` 或读取 GeneHub 产品源码猜接口。存在内置 `genehub` 工具时，把已知确定性命令组成一个批次。多行或含 shell 元字符的合同使用 `--message -` 和单引号 heredoc。

## 评审与返工

Reviewer 只用候选 Git 身份/diff、定向测试和 build 取证，不得 checkout/revert/reset、复制候选反演基线、写入或清理候选。命令使 worktree 非干净时必须 fail closed。

并行切片不得依赖“兄弟包暂未合入”才成立的偶然绿色断言。切片边界使用 fixture、切片自有导出或动态探针；切片局部数量不得通过共享聚合入口断言，因为聚合数量会随兄弟包合入而变化。消费共享聚合入口的规则还必须先按业务类型、所有权或其他已声明判别字段过滤目标子集，不能从兄弟资源类型中选择结果；Reviewer 必须用至少包含一种目标类型和一种兄弟类型的混合 fixture 复验默认路径。Reviewer 看到“共享聚合数量固定等于当前切片数量”或“默认路径可返回兄弟资源类型”的候选必须 `review-fail`，并要求改用局部 registry、显式语义过滤或组合不变量。完整组合门禁在合流后运行。反过来，最终组合门禁因责任兄弟包尚未合入而不可观察，也不能被归因成当前切片缺陷。

返工使用新包 ID 并保留旧候选/verdict。finding 属于原切片时复用其 repository、branch 与能力；明确属于另一责任包或 integration seam 时，PM 只按已声明责任路由最小返工，不做技术复评。

## Supervisor 与用户

派发当前全部 Ready 包后结束 turn。禁止 sleep、轮询、等待或反复读取运行中 Session。Supervisor 会批量唤醒；每次只读一次持久投影，处理整批 Candidate、Blocked、终态失败、用户决策和集成事项。

用户消息始终优先。成功路径上的 `userDecision` 是 Co-design 交付确认，不是失败兜底；选择只能来自 Web/RPC 用户操作。

## 安全自举与模板迁移

改进候选只写到 `workflow-candidates/<id>/`。该目录是项目版本化的惰性治理证据，不属于活动 Skill Provider 输入；然后依次：

1. `improvement propose --id <id> --target <目标> --rationale <证据>`；
2. 在已验证的 review-only Agent Space 中执行 `agent run --improvement <id> --no-wait`，由 Coordinator 把精确候选摘要和文件内容固定到独立 Reviewer WorkSession；
3. Reviewer 结构化结算后执行 `improvement review --id <id> --session <Reviewer Session> --evidence <证据> --pass`；
4. 等待用户在 UI 明确批准；
5. `improvement promote --id <id>`。

目标可为 `dcg/*.yaml`、`prompts/*.md`、`evaluations/*.yaml`、`catalog.yaml` 或最终的 `template.json`。模板迁移逐项评审提升，最后更新模板版本和内容摘要。晋级只影响新 Run；已固定 Run 不热切换。
