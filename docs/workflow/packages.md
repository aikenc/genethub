# 包、候选与执行载体

[文档入口](README.md) · [角色模型](model.md) · [编写规范](authoring.md)

## 源、产物与选择

项目在 `.genethub/workflows/` 下安装普通目录或 Git 检出的 Workflow 包。含 `workflow.md` 的目录就是一个包，ID 是它相对该根的路径；命中包后不继续向下发现包。一个包可以有多条 `flows/<id>.yaml`，文件名是流程 ID。

| 内容 | 作用 |
| --- | --- |
| `workflow.md` | 发现标记；frontmatter 的 `description`、`dev`、`recovery` 有机械消费者，正文供 PM 理解用途 |
| `flows/`、`procedures/` | 流程定义与可复用过程库 |
| `roles/`、`prompts/` | 编译引用的角色意图和提示词 |
| `spaces/<name>/space.json.src` | Space 生命周期、组件、目录等源 |
| `spaces/<name>/pipespace.json.src` | Builder 源；可引用 `$workflow`、`$collection`、`$project` |
| `skills/`、Space 自身的 `skills/` | 包提供的 Skill 源，按显式 Provider/选择物化 |

`workflow list` 返回发现、编译、载体构建/授权及漂移事实。多个包或多条流程没有唯一选择时必须用 `--package` / `--workflow` 点名，不能依赖历史 `--kind/--complexity` 路由。

`workflow build <package>` 将源物化到 `<project>/spaces/<flat-package-id>--<space>/`，再经 Builder 生成 Agent 配置。包源可编辑，产物应重建；不要直接修改已生成 `.agents/skills` 或 AGENTS 投影。Space 的本地 `skills/` 被放在 Provider 优先级前面。

首次项目接管及所需授权通过实际计划和 Human 决定完成。已授权 PM 的日常管理沿用已有项目权限并校验精确计划；不能把每次 build 都描述为必然再问人。daemon 不替项目联网拉取包。

## Candidate、Active 与 Run

Candidate 固定编译后的流程、角色、提示词和纳入摘要的源内容，以及包派生的执行绑定。Active 是按包保存、受 revision 校验的候选指针。修改源产生候选，不等于激活；结构检查通过也不等于载体准备完成或方法有效。

`workflow check --draft` 读取当前源并检查，不创建 Worker、不激活、不保存 Candidate。`workflow activate --candidate <digest> --revision <current>` 采用已保存的候选；省略 digest 则从当前源编译并固定。激活影响后续 Run，已启动 Run 保留原定义和输入。回滚使用上一候选与当前 revision。

Candidate 摘要不能被解读为覆盖团队所有外部 Skill 和环境。共享 Skill/团队构建需核对受影响活跃执行和 Builder 身份；纯定义激活与共享载体改动的安全边界不同。修改恢复定义的激活还需其专门的 Human 授权。

候选和激活指针存放在包对应 executor 组件的 Space 级目录；没有独立载体时使用项目下的对应组件目录。Run 和需求的权威快照属于 PM 的需求存储。具体路径查[存储规范](../storage-layout.md)，不要按会话目录猜测。

## 载体与 Worker 准备

包顶层 executor Space 负责调度直接 Worker。每个被引用 role 都需要唯一、启用且真实登记的直接 Worker；一个 `roles/*.yaml` 不会自动创建 Worker。带 worker 的 Space 也可挂 executor，但不因此成为包的顶层载体。

PM 可通过 `space open` 登记已构建的直接 `spaces/` 子目录或 `.code-workspace`，然后通过 Parent/Component 的 revision 计划配置归属。Builder 写操作先取得 `--plan`，核对 `managementPlan`，再带 `--plan-digest`、`--expected-revision` 和稳定 `--action-id` 应用。重放已完成 action 返回回执，事实变化需要新计划。

针对已登记目标使用 `--target-workspace` 明确选择。活跃执行会阻止修改其注册源；check/explain/verify 是检查，初始化、清理和跨项目管理有各自权限要求。WM 默认返回具体准备方案，PM 完成授权范围内的载体准备。

## 验证方法与采用

Workflow 及 Executor 配置是被验证的方案；任务目录、仓库、数据与产物是验证材料。材料可以没有 Git，也可以有多个独立仓库，不能把“试验”定义成“另建一个 Git 根目录”。

PM/WM 固定目标、基线、候选、团队配置、材料、预算、比较标准和停止条件。试验材料可放在候选 Executor 的 `.genethub/temp/exp/<testname>/`；这只是包中准备方法的约定，不是 Workflow 身份。

显式候选派发需要不同于正式载体的 Executor 和任务目录，保留 experimental 及绑定事实。也可用独立包准备另一套载体并显式指定材料根；这不是绕过正式目录和资源边界的办法。Git 写节点须使用材料自身的 Git 元数据，不得向上借用正式仓库、共享正式 worktree 元数据或对象 alternates。

WR 对照相同目标和输入，比较验收覆盖、失败/返工、时间、已观察模型/工具成本及人类投入，披露模型和环境差异。编译通过只证明结构，报告完整不证明检查实际发生，一次试跑完成也不能证明普遍收益。

PM 根据证据决定保留、修订、采用或回滚。采用应明确正式任务目录与载体，不默认把临时材料目录作为正式目录，也不因材料清理删除仍有价值的执行方案。

## 项目更新与兼容

更新包源与重新 build 是显式管理动作；保留定制、检查源与产物摘要，并处理活跃执行冲突。不能把 daemon 升级或重启说成已经升级了用户项目的 Skill，也不能通过手改安装版本伪装完整升级成功。

内置 `game-delivery` 包的业务方法以当前 [workflow.md](../../apps/daemon/workflow-packages/game-delivery/workflow.md)、YAML 与 Skill 为准。旧 Pack 版本和历史实施文档仅解释迁移来源。开发期只接受当前 v2 结构化定义与 v3 标签角色，不保留 v1 图或旧角色格式的读取、执行和迁移分支；具体语法由 `schema workflow.definition` 和生产编译器提供。

实现：[包发现](../../apps/daemon/src/workflow/package.rs)、[源物化](../../apps/daemon/src/workflow/build.rs)、[候选及执行绑定](../../apps/daemon/src/workflow/mod.rs)。
