# Agent Space 合同

## 磁盘归属

```text
<project-root>/
  spaces/<name>/                 外层管理仓库中的人类源文件
    pipespace.json
    <name>.code-workspace        Space 根目录必须排第一
    .pipebuilder/                本地锁、缓存和生成状态
  repositories/<repo>/          独立业务仓库
  worktrees/<space>/<repo>/      隔离的可写业务 worktree
```

多个 Space 共享一个外层管理仓库。`.genethub/`、业务仓库/worktree、Builder 状态和生成 Agent 文件不得提交。

## Runtime 与 Session

- AgentSpace 池属于项目，兄弟 PM Session 通过 Coordinator 复用，不重新登记或夺取删除权限。
- `pipespace.json.agents` 是 Builder target，不是绑定 runtime；运行时从 daemon 的 Agent catalog 选择。
- 每个 Space 明确为 `implementation` 或 `review`；角色属于拓扑，不属于模型。
- daemon 只允许在活动、持久 WorkPackage 的精确 worktree 中创建 WorkSession。
- 一个可写 worktree 同时只有一个租约。dirty 返回会隔离 Space，修复并复验后才能复用。
- WorkSession 不得编辑 PM 状态文件、兄弟 worktree 或生成的 Agent 配置。

## Git 证据

Space 源 commit/Builder lock、包 branch/worktree、候选 commit/tree 和 Reviewer verdict 必须逐层绑定。任何身份变化都会使下游证据失效；不要用路径或自然语言替代不可变 Git 身份。
