---
name: genehub-pm-agent-space-orchestration
description: 通过 GeneHub 公共 CLI 创建最小 Agent Space 拓扑、隔离 Git worktree，并派发或恢复受 PM 管理的第三方 WorkAgent/Reviewer。用于 PM Session 的建队、并行派工、评审容量和资源恢复。
---

# 编排 Agent Space 与 WorkAgent

Agent Space 是用户可见的 Workspace 角色，不是模型 runtime，也不是固定团队席位。只建立当前 Workflow、能力和风险所需的最小拓扑。创建或改变 Space 前先读 [references/agent-space-contract.md](references/agent-space-contract.md)；H5 项目再读 [references/h5-game-recipe.md](references/h5-game-recipe.md)。

## 设计与容量

每个 Space 明确职责、不负责事项、输入/输出、仓库/分支/worktree、所需 Skill、验收与评审门禁。相同上下文和写分支可合并；能独立推进、需要不同能力或独立评审时拆分。

Workflow 节点提供基础 selector，工作包用 `--space-tag` 声明额外语义能力，Coordinator 选择具体闲置 Space。不要把所有实现 Space 都做成通用节点，也不要让 PM 指定物理 Space。

派工前读取 `resourceCapacities`：Work 节点受 `fanout.maxItems`，Review 节点受 `capacity`，实际可用量看 `availableSlots`。容量不足时补建已验证 Space 或缩小 cohort，禁止反复提交失败命令探测。

多包 fanout 必须按三段批量执行：全部 `package put` → 全部 Ready → 全部 `agent run --no-wait`。每个包要能在 Run 剩余墙钟内形成结果，并为独立 Reviewer 和 Coordinator 集成留出余量。

## 构建与登记 Space

先读取项目状态并复用兼容的共享 Space。Builder 只管理 Space 源，不创建业务 Git 仓库、分支、worktree 或 commit。

```text
"$GENEHUB_CLI" agent-space init <name>
"$GENEHUB_CLI" agent-space check <space>
"$GENEHUB_CLI" agent-space explain <space>
"$GENEHUB_CLI" agent-space build <space> --dry-run --require-no-post-commands
"$GENEHUB_CLI" agent-space build <space> --require-no-post-commands
"$GENEHUB_CLI" agent-space verify <space>
"$GENEHUB_CLI" workspace register-agent-space "spaces/<name>/<name>.code-workspace"
"$GENEHUB_CLI" pm project space record --name <name> --purpose <合同> \
  --path spaces/<name> --workspace <workspace-id> --commit <full-source-commit> \
  --role implementation|review [--tag <能力>...]
```

外层仓库只提交人类维护的 Space/Provider 源，并忽略 `.genethub/`、`repositories/`、`worktrees/`、各 Space 的 `.pipebuilder/`、生成 Agent 目录和 `AGENTS.md`。

## 派发 WorkAgent

若合同已给出可用 Agent、原生 model id 和 Coordinator 选中的 workspace，直接使用；否则只读一次 `agent list`。不可用时保留包并引导用户安装/登录，不静默提交凭据。

```text
"$GENEHUB_CLI" pm project package transition --id <id> --to ready
"$GENEHUB_CLI" agent run --agent <id> --model <model> \
  --workspace <space-workspace-id> --work-package <包-id> --no-wait <实现完整合同或 Reviewer 简短启动消息>
```

多行或包含 shell 元字符的合同必须使用 `--message -` 与单引号 heredoc。禁止把合同插进双引号 shell，禁止 `timeout`、pipe、命令替换、后台任务或等待循环。

初始合同必须覆盖完整包结果：拥有路径、冻结接口、可观察验收、候选门禁、证据和候选截止点。Worker 只有两种包级结果：`candidate-ready` 或 `blocked`。内部 checkpoint 只是恢复证据，不触发 PM 逐步指挥。

成功的 `agent run --work-package` 原子绑定 WorkSession 和租约；不要再做一次状态转换。当前全部 Ready 包派发后，简短报告并结束 PM turn；Supervisor 负责观察和唤醒。

## 隔离与有界恢复

Worker 报告候选后，如果 Coordinator 只发现工作树尚未干净，会在原实现 Session 中自动且仅一次要求 Worker 收口提交；PM 不代替 Worker 清理、提交或改代码。仍不干净时，包进入 Blocked，Space 保持 quarantined，并保留失败 Session、分支和租约证据。

`genet pm project space repair --name <space>` 只在外部修复已经完成后复验已登记 Space 并解除隔离；它不会 reset、checkout、删除文件或替用户修代码。PM 不得把这条检查当清理命令。用户选择 Workflow 的 retry 后，旧包保持 Cancelled/Blocked 证据，新 Work 节点迭代必须使用新的包 id；只可选择 Coordinator 返回的 Idle 匹配 Space。没有干净匹配容量时，应依据剩余预算向用户说明 replan/cancel 或补充已验证 Space 的影响，不得复活旧包或绕过隔离。

## 独立 Review

Candidate 使用不同的 `review` Space，且必须匹配包能力并包含精确候选 worktree。Review Space 从派发到 verdict 期间冻结源 commit、Builder lock、workspace id 与 worktree 集合。Coordinator 会向 Reviewer 系统合同注入 Run 固定的项目提示词、Intent、包边界和精确 commit/tree；PM 只用 Supervisor 给出的 workspace 批量启动 Reviewer，不复制或重写技术评审合同。Reviewer 只读取候选并返回 `review-pass`、`review-fail` 或 `blocked`；PM 不执行技术评审。

所有 managed WorkSession 的最后一个非空行必须是唯一的 `GENEHUB_WORK_RESULT` JSON。人类可读报告可以放在前面，但不能替代协议或跟在标记后面。
