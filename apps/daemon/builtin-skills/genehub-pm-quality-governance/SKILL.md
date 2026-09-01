---
name: genehub-pm-quality-governance
description: 通过精确候选、机械证据、独立 Reviewer 和受控集成治理 PM 交付质量。用于接受、集成、发布、返工或改进项目 Workflow/Prompt 之前。
---

# 交付质量治理

通过合同、角色分离和证据管理质量。自信、篇幅和“看起来没问题”都不是证据。详细字段见 [references/evidence-gates.md](references/evidence-gates.md)。

## 候选门禁

1. 重述当前 Intent 的用户可见验收标准和包边界。
2. 固定 repository、commit、tree、Builder lock、测试/build 和产物摘要；dirty 或移动候选直接拒绝。
3. Worker 只提交一份紧凑证据：命令与退出码、候选身份、产物、限制和接口变化。
4. 按风险选择行为、回归、集成、安全、性能、兼容、许可和可运维性检查。
5. 使用不同的 `review` Space 启动独立 Reviewer。Reviewer 只读精确候选，不得 checkout、revert、reset、复制候选反演基线、写入或清理 worktree。
6. Reviewer 用结构化结果结束：

```text
GENEHUB_WORK_RESULT {"status":"review-pass","summary":"精确候选的全部门禁通过"}
GENEHUB_WORK_RESULT {"status":"review-fail","summary":"仍有验收缺陷","findings":[{"severity":"blocking|high|medium|low","title":"...","acceptanceImpact":"...","recommendedAction":"...","estimatedRequests":1}]}
```

7. `review-fail` 必须指出绑定候选自身或明确 integration seam 的验收缺陷。兄弟切片尚未合入导致最终组合门禁暂不可观察，不是当前切片缺陷；用 fixture/动态探针评审本包边界，完整组合门禁留到 merged baseline。
8. PM 不读代码复评。它只依据 findings 的验收影响、范围和剩余预算决定有限返工或升级用户。
9. 返工生成新候选并重新运行受影响测试和独立 Review；旧 verdict 不复用。
10. 多切片集成后，在派发下游包前运行完整 merged baseline。冲突属于对应 seam 的独立修复包。

公共命令形态：

```text
"$GENEHUB_CLI" pm project package transition --id <id> --to candidate \
  --repository <repo> --commit <full-commit> --tree <full-tree> --evidence <证据>
"$GENEHUB_CLI" agent run --agent <agent> --model <model> \
  --workspace <独立-review-space> --work-package <同一-id> --no-wait "按 Run 固定合同独立评审精确候选"
"$GENEHUB_CLI" pm project package integrate --id <id>
```

成功的 Review `agent run --work-package` 会原子绑定候选和 Review WorkSession；不要额外执行 `--to review`。Coordinator 只允许一次有界结果协议修复；仍失败时包进入 Blocked，PM 不合成 verdict。

Integration 是 Coordinator 的确定性 Git 操作：重新证明候选身份、独立通过 verdict、干净 main、合并结果和祖先关系。冲突或脏基线走 Workflow 恢复边，不得由 PM 手工合并。

## 改进 Workflow 与 Prompt

只有可复现、可复用的问题才进入项目候选。候选放在 `workflow-candidates/<id>/`；该目录位于活动 Skill Provider 之外，避免惰性候选被 Builder 当成当前输入。然后依次 `improvement propose`、在 review-only Agent Space 中用 `agent run --improvement <id> --no-wait` 派发摘要绑定的独立 Reviewer、登记结构化 review、用户 approve、`promote`。不得复用评审其他 WorkPackage 的 Session。晋级只影响新 Run；已固定 Run 不热切换。模板迁移也走同一链，并以 `template.json` 的版本与内容摘要收口。
