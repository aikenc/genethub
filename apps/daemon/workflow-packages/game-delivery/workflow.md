---
description: 项目自有的单 Run 开发、有限重规划与证据驱动的 PM 自省；面向可交付的小游戏与其 Feature
---

# Game Delivery

一条从需求到可玩交付的游戏管线，外加一条评审自己的流程改进管线。

## 做什么

`flows/` 下有八条流程：`game-dev` 做单 Run 实现，`game-review` 与
`game-review-and-improve` 做独立评审与返工，`game-assessment` 只评估不实施，
`parallel-features` 把互不相关的需求分支并行开发后各自合入，
`quality-parallel` 将多分支迭代、三路独立验收与主线质量门禁放在一个 Run 中，
`workflow-review` 与 `workflow-improvement` 评审并改进流程本身。

## 何时用

要做一个 15 分钟内可交付的可玩小游戏、给现有游戏加一个复杂 Feature、
在实施前评估玩法改动是否可行、或者在反复返工后判断问题出在执行还是流程时使用。
纯前端静态站点或非游戏项目请换用别的包。

## 载体

`spaces/` 声明六个 Space：`executor` 承担派发，`coder` 与 `reviewer` 是实现与评审
Worker，`owner` 拆解需求验收项，`workflow-manager` 分析并改进流程本身，`workflow-reviewer` 兼任平台自动诊断的
载体。`workflow build` 会把它们物化到 `spaces/game-delivery--<name>/` 并请求人类授权。

## 怎么算验收

每条流程的验收由它自己的 `completion` 门定义；`reviewer` 的
`references/review-contract.md` 说明评审要求的证据形态。流程只接受机械证据，
不接受"已完成"这类自述。

## 观测与优化

从平台任务详情或执行会话打开构建内 `views/progress/index.html`。视图用 `workflow.profile` 读真实 Run、节点时钟、预算与按实际 LLM 请求次数计价的人民币估算；清单、门禁和依赖图由本包维护，平台不解释质量规范。

有额外脚本依赖或排队时，可把 JSON 送给 `python3 scripts/observe.py`，记录 runId、id/nodeId、startMs/endMs、dependsOn 与 waits（startMs/endMs/reason）。一实体一文件，可重放去重，视图经已有文件 API 读取。该记录可表达脚本子步骤与主干写锁等等待；WM 要为修改后的流程同步维护视图与记录契约。

quality-parallel 在发布前通过包内 quality-summary.py 汇总最终门禁报告：规范异议写入 Run 结果和独立报告，明确为有异议交付，由 PM 转交 WM。无需验证不等于通过；未通过或未完成验证不能发布。

发布前等待所有功能线收敛，冻结干净主线的最终提交，再按交付单元执行三路并行复验。包脚本校验所有最终报告都覆盖同一提交且没有 failed/unverified；即使某功能线曾通过，中间合入记录也不能替代最终交付门禁。最终拒绝保留报告交 PM；WM 可在包中扩展最终修复循环，平台不解释门禁政策。
