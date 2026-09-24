> **Workflow 要让目标一路有人负责：Executor 推进工作，异常由 WR 查明并交回 PM 解决；只有必须由人授权、提供信息或亲自验收时，才停下来等人。**
>
> 这是产品目标，不表示当前实现已覆盖所有异常和故障恢复。执行状态仍须如实显示；一次 Run 的 `blocked` 不能自动等同于用户请求无人负责或已经结束。

GeneHub 的 Workflow 能力从人的意图出发：PM 理解目标，交给 Workflow Manager（WM）创建或改进 Workflow，由 Executor 承载运行，再用代表任务验证，最后根据 Workflow Reviewer（WR）的证据决定采用或继续调整。目标态中，原始目标的后续责任由 PM 承担；平台保存执行事实和交接义务，让异常不会因通知已读、进程重启或单次 Run 结束而消失。

Workflow 是被创建、验证和采用的执行方案。Executor 是使这个方案能够运行的载体。测试项目提供输入、仓库、数据和产物，用来观察方案的行为。一个测试项目完成，只能提供本次运行的证据；Workflow 的有效性还要对照原始意图、验收范围和成本判断。

| 概念 | 含义 | 当前实现 |
| --- | --- | --- |
| Workflow 包 | 一个含 `workflow.md` 的普通目录，靠 `git clone` 获得；身份即它相对 `.genethub/workflows/` 的路径 | `<project>/.genethub/workflows/<id>/` 下的 `flows/`、`roles/`、`prompts/`、`skills/` 与 `spaces/` 源 |
| Workflow（流程） | 步骤、角色协作、条件、验收与异常处理的定义 | 包内 `flows/<id>.yaml`；文件名即 id，没有登记表 |
| Executor | Workflow 的运行载体，调度自己直接拥有的 Worker | 挂载 executor Component 的 AgentSpace |
| Candidate | 一份可固定身份的候选配置 | 包含从包目录推导的事实（包 id、executor 载体、诊断载体）、各条流程及相关源文件 |
| Run | 使用固定候选、载体与输入执行一次任务 | daemon 创建，Executor 会话保存权威运行快照 |
| 测试项目 | 验证 Workflow 的材料 | 普通任务目录；按案例需要包含零个、一个或多个 Git 仓库 |

产品中选择某个 Executor 可以表示选择一套可运行的 Workflow 方案。实现中仍应保留定义、载体和运行身份：一个包可以包含多条流程，同一个 Executor 承载该包的全部流程。一个项目可以同时安装多个包，各自绑定自己的 Executor，因此派发时包与流程都要能被点名。

源与产物严格分离：包目录是纯源（手写、可 git 管理），`workflow build` 把其中的 Space 源物化到 `<project>/spaces/<扁平包id>--<space>/`，产物全部可重建。升级就是在包目录里 `git pull` 再 build——平台不实现三方合并，daemon 也不联网。

| 数据 | 位置与责任 |
| --- | --- |
| 可编辑 Workflow 源 | 包目录 `.genethub/workflows/<id>/`；它自带 git 检出，WM 在其中维护版本 |
| 执行绑定 | 由包推导：声明顶层 `executor` 组件的 Space 对应产物目录即该包的 Executor；任务目录默认项目根，由 Run 输入覆盖 |
| Candidate、激活指针及 Run 索引 | daemon 管理，当前在 `<data>/workflow-runtime/<本机 workspace id>/`；激活指针按包分文件，一个包的重建不会改写另一个包的指向 |
| Executor 所属 Run 快照 | Executor 会话的 executor 组件实例 `snapshots`；由 daemon 更新 |
| Space 的 Skill 与配置 | 各 AgentSpace 的 Builder 源及其验证身份；不能假设一个 Candidate digest 已覆盖全部 Skill 内容 |

上表中的 Candidate、激活指针、Run 索引及快照是已知偏离。前者违反 `L13`，后者让一个请求的多个 Run 分散在不同会话里。目标位置见 [storage-layout.md](./storage-layout.md) §5；新代码不得扩大这些偏离。

相关实现见 [Workflow 宿主](../apps/daemon/src/workflow/mod.rs)的 `compile_candidate`、`resolve_execution_binding`、`executor_snapshot_relative` 与 `save_run`，[包发现与物化](../apps/daemon/src/workflow/package.rs)、[构建与授权](../apps/daemon/src/workflow/build.rs)，以及随产品发布的[内置包](../apps/daemon/workflow-packages/game-delivery/workflow.md)。

项目、Executor 和目录有三种不同关系。

| 关系 | 约束 |
| --- | --- |
| AgentSpace → 任务目录 | 可配置的文件夹引用。Agent 在自己的 `session_cwd` 启动，节点在 `task_cwd` 工作。 |
| 项目 AgentSpace → Executor → Worker | 单父级归属和调度权限。一个项目可以有多个 Executor，每个 Executor 调度自己的直接 Worker。 |
| Run → Candidate、Executor、任务目录 | 启动时冻结，后续激活不重新解释已有 Run。 |

“目录和 Executor 是弱关系”指任务目录可以配置，不表示归属和权限任意。当前 Builder 仍要求受管 Space 位于项目根或直接的 `spaces/<name>` 下，工作区引用也受项目边界约束。多 Executor 已由 `reusable_component_space_at` 的显式路径选择支持；缺少选择且匹配多个载体时应报告歧义，不能任意挑一个。参见 [Workspace 归属与选择](../apps/daemon/src/workspace.rs)及 [Builder 边界](../apps/daemon/src/agent_space_builder/mod.rs)。

创建或改进 Workflow 时，各角色按下面的产物协作。

| 角色 | 责任 |
| --- | --- |
| 用户 | 表达意图、验收目标、预算和授权范围，补充需要真人完成的验证 |
| PM | 理解并传递完整意图，协调准备和运行，在授权内决定采用、继续或停止 |
| WM | 产出 Workflow 及必要的 Skill、提示词、模型和角色配置变更，设计验证案例 |
| Executor / Worker | 承载方案，执行真实任务并产生可核验结果；业务 Reviewer 评价产物 |
| WR | 评估 Workflow 是否实现人的意图，比较效果、成本和适用范围，明确缺证 |
| 内核与宿主 | 执行通用控制流，校验权限、版本与资源，保存和恢复事实 |

普通业务请求可直接复用已有 Workflow；不必每次调用 WM。受管 WM 返回候选和准备方案，PM 负责管理及派发。WR 维持只读评估。新 Workflow 的实验不需要独立的内核实验注册中心或专用生命周期，现有 [结构化流程引擎](../packages/workflow-engine/README.md)提供控制流，技能包负责实验方法。

测试材料的默认约定是 `spaces/<候选 executor>/.genethub/temp/exp/<testname>/`（`temp/` 是登记在 [storage-layout.md](./storage-layout.md) 的普通可编辑目录）。这只是材料位置，不构成 Workflow 身份，也不规定必须采用 Git。需要 Git 时，案例可以准备独立于正式仓库的一个或多个仓库，并保留工作流依赖的分支、历史和标签；实验仓库可以使用自己的 worktree。Git 节点要明确绑定实际实验仓库，不能让 Git 从普通子目录向上找到正式仓库。Worker 只挂载需要的材料目录，不挂载整个 Executor 私有会话目录。

同一 Workflow 可以在多个案例上验证。比较旧、新方案时应从等价的初始材料分别运行，记录流程内容、执行配置、案例与 Run 的对应关系。运行完成、逐项报告完整和检查实际执行是不同证据；`value.nonEmpty` 并不能证明报告中每项检查都真实通过。缺少真人样本或可靠输出时，结果保持未验证。

采用的是通过验证的 Workflow 与执行配置。可以保留候选 Executor 承担正式任务；若迁回旧 Executor，应核对 Skill、提示词、模型和角色等配置的一致性并补足验证。更改测试目录为正式任务目录会改变当前 Candidate 的执行绑定及 digest，应重新校验后激活。旧 Run 保留快照，回滚需核对旧完整配置。清理测试材料不等于删除 Workflow，采用 Workflow 也不依赖将测试项目合入正式项目。

本模型说明产品语义与当前源码事实。目录准入、PM 的 Builder 管理入口和自动准备旅程的交付状态以对应实现及测试记录为准；不能由上述方法约定推断所有路径已经可用。现有旅程入口见 [PM 与 Workflow 旅程](../testing/journeys/workflow/pm-game-delivery.journey.ts)，运行控制见 [PM input and workflow control](./pm-workflow-control.md)。
