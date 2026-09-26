---
description: 项目自有的单 Run 开发、有限重规划与证据驱动的 PM 自省；面向可交付的小游戏与其 Feature
---

# Game Delivery

一条从需求到可玩交付的游戏管线，外加一条评审自己的流程改进管线。

## 做什么

`flows/` 下有七条流程：`game-dev` 做单 Run 实现，`game-review` 与
`game-review-and-improve` 做独立评审与返工，`game-assessment` 只评估不实施，
`parallel-features` 把互不相关的需求分支并行开发后各自合入，
`workflow-review` 与 `workflow-improvement` 评审并改进流程本身。

## 何时用

要做一个 15 分钟内可交付的可玩小游戏、给现有游戏加一个复杂 Feature、
在实施前评估玩法改动是否可行、或者在反复返工后判断问题出在执行还是流程时使用。
纯前端静态站点或非游戏项目请换用别的包。

## 载体

`spaces/` 声明五个 Space：`executor` 承担派发，`coder` 与 `reviewer` 是实现与评审
Worker，`workflow-manager` 分析并改进流程本身，`workflow-reviewer` 兼任平台自动诊断的
载体。`workflow build` 会把它们物化到 `spaces/game-delivery--<name>/` 并请求人类授权。

## 怎么算验收

每条流程的验收由它自己的 `completion` 门定义；`reviewer` 的
`references/review-contract.md` 说明评审要求的证据形态。流程只接受机械证据，
不接受"已完成"这类自述。
