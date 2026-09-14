# 四档典型 Workflow

这四份是当前 `genehub.workflow.definition.v2` 的完整配置，不是新语法提案。
它们是供 WM 参考、按项目修改的示例，**不自动加入内置 Pack，也不改变任何项目的 Active**。
正式默认开发方法仍只有 Pack 中的 `game-dev`，这里不是四条新的默认开发入口。

| 档位 | 示例 | 业务闭环 | 主要控制能力 |
| --- | --- | --- | --- |
| 简单 | [只读工程评估](01-simple-assessment.yaml) | 检查 → 报告 | `sequence`、结构化结果传递 |
| 中等 | [单项开发与有限修复](02-medium-repair.yaml) | 开发 → 评审 → 最多一次修复 → 条件交付 | `loop`、局部变量、条件分支 |
| 复杂 | [批量模块迁移](03-complex-batch.yaml) | 规划批次 → 逐项迁移与验收 → 首次拒绝退出 → 汇总 | 动态数组、串行 `forEach`、累积结果、`break` |
| 特别复杂 | [多里程碑完整交付](04-very-complex-delivery.yaml) | 规划 → 逐里程碑交付 → 双路验收与修复 → 必要时重规划 | 嵌套循环、子过程、并行合并、两层局部退出 |

每次派发都由 **一个 Executor Run** 完成相应流程。PM 对齐目标、抽查事实、管理授权和预算；
WM 维护业务配置，Reviewer 做业务判断。示例没有把循环调度移回 PM，也没有要求引擎认识这些业务。

## 1. 简单：只读工程评估

适合“先整体看看项目，有什么风险”，不包含修复授权。

```text
Reviewer 检查工程
  → { findings: [...], evidence: "..." }
  → Reviewer 整理报告
  → { summary: "..." }
```

前一步输出通过 `/results/inspect-project/output` 传给下一步，最终结果直接是报告。
没有 Coder、写租约或交付发布节点；“请看看”不会自动变成“请修改”。

## 2. 中等：单项开发与有限修复

适合目标、范围和验收已经对齐的小功能或缺陷修复。

```text
固定本次合同
  → 开发并提交 → 绑定该 commit 评审
      ├─ approved=true  → 返回已验收结果，发布本地 Run 结果
      └─ approved=false → 还可尝试？修复并复审 : 返回未通过及现场
```

`vars = { attempt, approved, feedback, artifact }` 只属于当前修复循环。
`update` 将本轮评审和提交传到下一轮；`attempt < 2` 表示首次开发加最多一次修复。

两次都未通过时，循环正常结束并返回 `approved: false`，不执行发布节点。
这是一个明确的业务结论，不冒充系统故障，也不冒充成功交付。
系统故障、取消或请求预算耗尽仍由运行控制层处理，不能通过 `approved` 吞掉。

## 3. 复杂：动态批次、遇错退出、保留结果

适合按顺序迁移多个模块，遇到不兼容后必须先停下检查的任务。

```text
Reviewer 生成 1–8 个模块合同（不是固定槽位）
  → forEach 按合同 id 串行处理
      → Coder 迁移并提交 → Reviewer 验收
          ├─ 通过：累积合同与提交
          └─ 拒绝：break { 已验收项, 本次失败合同/提交/评审 }
  → 汇总完整计划、已接受项和失败现场
```

`break` 只结束 `batch`，外层报告仍执行；后续模块不会启动。
没有执行的项目仍在返回的完整 `plan` 中，不能把它们当成通过。
失败项已经产生的提交保留下来供检查；退出不是 Git 回滚。

两个值得看清的配置细节：

- `initial` 建立累积值，`update` 消费本项最终结果；不是多个 Worker 共享可变全局变量。
- `break` 会跳过本项的 `update`，所以它必须显式返回已接受数据和本次失败现场。

## 4. 特别复杂：单 Run 内完整规划—交付—重规划

适合需要拆阶段、每阶段验收，并可能重规划的大功能或工程重构。

```text
planning（最多 3 次规划）
  → 需求评审：go / noGo / needsAuthorization
  → go 且计划非空：按里程碑串行处理
      ├─ 合同与已验收合同完全相同 → 复用结果
      └─ 调用 deliver-milestone(contract, deliveries)
          → repair（最多 2 次开发尝试）
              → Coder 开发并提交
              → parallel
                  ├─ 串行逐项验收并累积结论
                  └─ 独立回归检查同一提交
              → 两路均通过才批准；否则带两路反馈修复
          → 子过程返回结果
          → 未通过：break 当前里程碑遍历，保留成果与失败合同
  → 需要重规划则继续外层 planning
  → 全部通过才发布本地 Run 结果
```

变量和作用域如下：

| 所在位置 | 自己持有的数据 | 如何跨边界传递 |
| --- | --- | --- |
| `planning` | 已验收合同、交付记录、上次失败、是否完成 | `initial/update` |
| `milestones` | 本计划的累积交付结果 | 返回累积值；失败 `break` 返回明确的新值 |
| `deliver-milestone` 子过程 | 当前合同、既有交付记录 | `call.input` 显式传入，不捕获调用方变量 |
| `repair` | 尝试次数、批准状态、两路反馈、提交 | 局部 `vars`；正常返回最终值 |
| 并行验收分支 | 同一提交的独立检查结果 | 由 `parallel` 返回按分支 ID 命名的结果 |
| 逐项验收 | 本分支批准状态、逐条记录、固定提交 | 串行累积；不修改修复循环或另一分支的变量 |

`break` 的两个落点有意不同：

- 里程碑子过程返回未通过后，在**调用方**退出最近的 `milestones`，进入外层重规划。
- 需求评审拒绝、需要新授权或给出空计划时，退出最近的 `planning`，返回 `done: false`。

不跨子过程或并行边界 `break`，也不从 Worker 结果伪造控制跳转。
第三次规划之后仍未完成会触发外层 `maxRounds`，Run 明确 `blocked`，不会继续或发布。
已验收合同按**完整对象**比较；同 ID 但目标或验收改变时必须重新交付。

## 使用前提与边界

这些是 Workflow 定义文件，不是独立的 Executor 安装包。导入需要：

1. 有项目、Executor、`coder` / `reviewer` 角色绑定及其 Prompt/Skill。
   可以在隔离项目使用现有 `game-delivery-v1` Pack 准备这些载体；非游戏项目由 WM 映射合适的角色方法。
2. WM 根据真实需求修改 `structure.input` 的示例目标或合同，并保留原始需求与验收。
   `structure.input` 是定义中的初始数据，派发消息不会自动重写它。
3. 将文件纳入项目的 `.genethub/workflow/workflows/`，在 `catalog.yaml` 增加条目，例如：

   ```yaml
   - id: example-complex-batch
     path: 03-complex-batch.yaml
   ```

4. 用现有 `workflow inspect` 检查候选；由有权限的 PM 按现有候选试验/激活规则派发。
   不覆盖定制配置，不为了演示改变正式默认入口，不绕过候选隔离要求。

例如在具备正确项目上下文的 PM 会话里，既有入口仍是：

```sh
"$GENEHUB_CLI" workflow inspect
# 明确选择已经准备好的候选快照；不是隐式激活。
"$GENEHUB_CLI" workflow inspect --candidate <candidate-digest>
# 下面正式派发使用 Active，前提是该示例已按正常授权程序进入 Active。
"$GENEHUB_CLI" workflow dispatch --workflow example-complex-batch --task migration-demo --no-wait --message "执行已对齐的迁移合同"
```

Worker 用已有 `workflow complete --output '<JSON>'` 提交业务结果；Coder 提交 `commit` / `checks` 证据。
`completion.output` 是有限结构合同，不是完整 JSON Schema：对象声明字段全部必填，额外字段被拒绝。
JSON 结构合法不证明检查实际执行，更不证明业务质量；角色方法、真实工具证据和独立评审仍然必要。

其他边界：

- 角色 ID 只表示绑定。只读策略和具体检查方法必须落实在所绑定角色的能力、Prompt/Skill 与授权中。
- 重规划不得删除未完成目标来换取 `done: true`。是否覆盖原目标仍需要需求评审和 PM 抽查，当前形状校验不证明语义覆盖。
- `maxOperations/maxConcurrency/maxFrames` 是图的上界，不授予资源；请求预算可能先耗尽。
  `needsAuthorization` 在这里返回待决事实，不自行加额，也不声称实现了图内审批等待节点。
- `result.publish` 只发布本地 Run 结果，不代表上线、推送代码或对外发布。
- 成功、业务拒绝和系统阻塞必须分别读取；单看 Run 的 `completed` 不足以判断交付成功。
- 示例复用现有持久化，不增加恢复机制；不承诺未知外部副作用自动重放或断电绝不丢失。

控制语义详见 [引擎说明](../../../packages/workflow-engine/README.md)。

## 可执行验证

[专项源码](../../../testing/specialties/workflow/examples.specialty.ts) 直接读取这四份 YAML 原文，
通过真实 Pack 安装、候选编译/激活、CLI 派发、Worker 提交和公开 Run 状态检验配置；不另造影子调度器。
测试只脚本化 LLM endpoint，开发确实产生 Git 提交，评审确实读取对应提交内容。

`specialty.workflow.examples.*` 共 10 个场景：

- `simple`：只读诊断、证据传到报告、没有代码改动或发布。
- `medium-repair` / `medium-rejected`：两次尝试后通过 / 拒绝，拒绝不发布。
- `complex-success` / `complex-break`：动态四项全部通过 / 第二项拒绝后不启动第三项，外层汇总仍执行。
- `very-complex-replan`：逐条验收通过但回归拒绝两次，单 Run 重规划并保留第一项成果。
- `very-complex-exhausted`：三轮规划仍失败则阻塞，不启动后续项或发布。
- `very-complex-no-go` / `very-complex-authorization` / `very-complex-empty-plan`：只返回评审事实，不开发、不发布。

这些用例检验配置与执行机制，不构成真实模型自主规划、自省或业务交付质量的验收。
