# Workflow 去僵化：从 fork 失权到平台交还清单

状态：提案，尚未实施。日期：2026-09-21。
落地分支：`dev-1`（承接已合入的 git-native Workflow 包模型）。

本提案取代 dev-agent 分支的 Activity/CAS/Git 包提案（`cf26126`，该分支上的
`docs/activity-routing-resource-cas-git-pack-proposal.md`）。原提案的三条主线——Activity 回包路由、
通用资源 CAS、Git 迁出平台——全部保留并在本文重新组织；**新增的是它缺的那一层：fork 失权不是一个
独立缺陷，而是一整类僵化的样本，本文给出完整清单和交还判据。**

## 0. 触发点：fork 之后，新 Session 既不可写也不可管理

这是用户指出的触发点，也是本提案的组织原则。先看机械事实（已逐行核对）。

项目管理权是**一个字符串相等判断**（`project_control.rs:587-590`）：

```rust
pub fn is_bound(&self, workspace_id: &str, controller_session_id: &str) -> bool {
    self.load_binding(workspace_id)
        .is_ok_and(|binding| binding.controller_session_id == controller_session_id)
}
```

fork 产生新 session id，于是这个判断**按构造必然为假**。而 `SessionCreate`
（`router.rs:1419-1429`）会在 PM 项目里自动 `rebind` 到新会话：

```rust
Ok(summary) => {
    if let Ok(space) = state.workspaces.agent_space(&workspace_id).await {
        if crate::agent_space::has_enabled_component(&space, COMPONENT_PM) {
            state.project_control.rebind(&workspace_id, &summary.id)
```

**fork 的处理分支里没有任何 `project_control` 调用**（`router.rs:1746-1753`、`1764-1787`），直接
返回 summary。也就是说：

> `genet session new` 继承项目管理权；**从中间 fork 出来的会话不继承**。

后果不止"不能管理"。这一个相等判断是 **7 处授权门**的唯一钥匙：`router.rs:175`（AgentSpace 管理）、
`:227`（注册预备 Space，`"projectControlRequired: only the bound PM registers prepared Spaces"`）、
`:377`（workflow 变更）、`:468`、`:515`、`:2640`（Builder apply）、
`agent_space_builder/management.rs:115`、`workflow/mod.rs:1176`。fork 出来的会话全部撞墙，
错误是 `"当前 Session 没有这个项目的 ProjectControlBinding；请先完成 PM 接管"`。

而"接管"的唯一非用户路径是 `exception_authority`（`mod.rs:744-787`），它的判据是
**项目里已经有 Run 坏掉了**（`blocked`/`failed`/`recoverable`/诊断异常）。也就是：

> **一个 fork 出来的会话要想管理项目，得先等项目出故障。** 一切正常时它永远无权。

再加两处放大：`SessionArchive` **不**移除 binding（只有 `SessionDelete` 移除，
`router.rs:1866-1872`），所以"归档旧会话、在 fork 里继续"会把管理权**搁死在一个已归档的会话上**；
`rebind` 只有一个槽位，语义是"移动"而非"共享"。

这暴露的不是一个 bug，而是**用身份相等冒充授权**。用户的原话——"这暴露了我们 workflow 的僵化"——
是准确的，而且这类僵化远不止这一处。

## 1. 判据：什么叫"僵化"

在提出清单之前先定判据，否则"灵活性"会变成无边界的许愿。本提案采用与 2026-09-20 平台交还路线图
一致的判据，并补足一条：

> **J1（既有）：平台只定义它必须亲自执行的结构。**仅 Workflow 消费的结构应不透明搬运。
>
> **J2（既有）：可执行能力锚定在已批准的源码 digest 上**，不锚定作者、不锚定自声明字段。
>
> **J3（新增）：授权判断必须针对"谁有权"，不得用"是不是同一个 id"替代。**
> 身份相等只能用于**归属**（这条结果属于哪个 operation），不能用于**权限**（谁可以操作）。

J3 正是 fork 问题的根因，也是下面 Category B 全部条目的共同判据。原提案 §2.3 已经把三个职责
（授权/一致性/路由）拆开列出过，但没给出"相等判断不得作授权"这条可机械检查的规则。

## 2. 僵化清单

以下 35 项经实际代码核对（非推断），按"损失多少真实灵活性"排序分组。每项标注是否**本提案范围内**。

### Category A — 硬编码基数（平台替项目决定"只能有一个"）

| # | 位置 | 事实 | 阻塞的正当场景 |
|---|---|---|---|
| A1 | `workspace.rs:828-832` | `matches.len() != 1`，一个 role 恰好一个 Worker Space | `forEach` 并发 8 个 `coder` 无法扇出到 8 个 Space。且在**绑定期**校验全部 flow 的全部 role（`mod.rs:1323`），加一个同名 Worker 会让整个包激活失败 |
| A2 | `mod.rs:1731-1737` | Executor Session 恰好一个 Run 快照 | 一个 Executor 会话不能同时驱动两条 Run（如同一流水线跑两个分支）。存储本身支持 16 个，只有这个检查禁止 |
| A3 | `workspace.rs:712-726` | 项目恰好一个可复用组件子节点 | 纯定义包复用他人载体的场景（`package.rs:134` 明确支持）在未声明 `executorPath` 时无解；两个 diagnostic 载体完全不可能 |
| A4 | `package.rs:136-151`,`160-175` | 一个包最多一个 executor/diagnostic 载体 | 一个包无法同时发布轻量与重型载体，作者被迫拆包，拆完又触发 A3 |
| A5 | `mod.rs:852-856`,`879-883` | 多包/多 flow 一律拒绝，**不允许声明默认值** | 每个多 flow 包的每次调用都必须 `--workflow`，即使包清单是声明默认值的天然位置 |
| A6 | `program.rs:228-237` | `forEach` 累加折叠强制 `maxConcurrency == 1` | "并行 review 20 个文件再汇总"必须整体串行 |
| A7 | `manifest.rs:228-240` | git Skill Provider 必须恰好 branch 或 tag 之一 | 无法钉到 commit SHA——唯一可复现的选择 |
| A8 | `project_control.rs:208-213` | `questions.len() == 1` 决定是否识别为计划卡 | Agent 合理地一次问两个问题，审批路径静默降级为普通提问 |

### Category B — 身份相等冒充授权（违反 J3，**本提案核心**）

| # | 位置 | 事实 | 阻塞的正当场景 |
|---|---|---|---|
| **B1** | `project_control.rs:587-590` + 7 处门 | **项目管理权 = 一个 session id 字符串** | **§0 的 fork 失权**；两个 PM 会话共管一个项目；人与 agent 共管；只委托 build 权限 |
| B2 | `mod.rs:1810-1811` | 节点完成 = `session_id` 相等 | Worker 会话死掉后人类无法接手收尾；主管无法代关卡死节点 |
| B3 | `control.rs:1116-1119`,`request.rs:218-221` | 任务归属 = PM session 相等 | 无法把运行中任务交给另一个 PM 会话；无法重试同事的失败 Run |
| B4 | `mod.rs:737` | Run 通知只投给 `parent_session_id` | 同项目第二个观察者会话收不到任何通知 |
| B5 | `router.rs:1248-1267` | 受管会话控制 = parent id 相等 | 接任的 Executor 无法接管前任派出的 Worker——而这恰恰是前任失败时唯一需要的操作 |

### Category C — 生命周期单向（进得去出不来）

| # | 位置 | 事实 | 阻塞的正当场景 |
|---|---|---|---|
| C1 | `mod.rs:2873-2875` | genesis 只能一次且不可逆 | 第一次激活错了，没有"重置重来"，只能手删 daemon 私有状态 |
| C2 | `workspace.rs:584-606` | 包不得 reparent / 改 lifecycle / 改组件 | **包的团队形状在首次 build 时冻结**：v2 包重命名 role 或移动 Space 根本无法应用 |
| C3 | `agent_space.rs:227-229`,`244-246`,`296-298` | 有子节点不可 ephemeral / 不可跨项目移动 | 整个团队搬到新项目必须逐个摘下再挂回，期间树是非法的、包不可 build |
| C4 | `manager.rs:2603-2608` | context seed 第二次应用是致命错误 | Applying→Applied 之间崩溃会永久废掉那个 fork |
| C5 | `control.rs:486-492` | 带写租约的节点**永不**自动重派 | 策略属于平台而非 Workflow：定义无法声明"此节点幂等，可重试"。且 `run.leases.is_empty()` 让**任意**租约毒化无关节点的恢复 |
| C6 | `control.rs:410-416` | cleanup 错误 / 预算耗尽是终态 | 没有"确认并继续"，Run 只能弃掉 |

### Category D — 平台枚举的封闭词表（违反 J1）

| # | 位置 | 事实 | 阻塞的正当场景 |
|---|---|---|---|
| **D1** | `mod.rs:3203-3207`,`1942` | capability 词表硬编码三项，**无注册机制** | 项目无法新增宿主能力，一切都得经 `agent.session` 洗一遍。**这是 Workflow 表达力的最大天花板**，也是 Git 迁出的前提 |
| **D2** | `mod.rs:3252-3255` | verifier 词表硬编码三项 | 项目无法定义完成证明（`value.matches`/`file.exists`/`tests.passed`），任何质量门都退化成"Worker 说了个非空字符串" |
| D3 | `mod.rs:3189-3194`,`3165-3174` | 内置 outcome 名保留且 success 位固定 | 迭代流程里 `changesRequested` 本该算成功的一轮，无法声明；且非 success 的 outcome 不得到达 `result.publish`（`:3299`），迭代流程无法发布中间结果 |
| D4 | `mod.rs:3289-3291` | 非 `agent.session` 只能发 `completed` | `request.budget` 预算耗尽时无法报 `blocked`，流程只能从输出对象里猜 |
| D5 | `agent_space.rs:35-41`,`106-136` | 组件封闭 5 项；role 只能挂 worker；reviewer 必须先挂 worker | 项目无法定义自己的职责（`auditor`/`releaser`）；executor 无法标注 `staging` vs `prod`；独立 reviewer Space 不可能 |
| D6 | `agent_space.rs:53`,`197-201` | lifecycle 封闭 3 项，且 `workspace.rs:688` 把 `!= "ephemeral"` 焊成可复用性判据 | 词表与调度策略被焊在一起 |
| D7 | `manifest.rs:10`,`134-141` | agent 封闭 4 项 | 本地新装的 agent 永远收不到定制 skill 内容 |
| D8 | `mod.rs:3364-3366` | V1 方言**禁止 join** | 无法表达"两个 reviewer 都完成才发布"；改 v2 又禁止 `entry` 与全部 `node.on`（`:3304`），**没有增量迁移路径** |

### Category E — 单写者 / 排他假设

| # | 位置 | 事实 | 阻塞的正当场景 |
|---|---|---|---|
| **E1** | `router.rs:664-668`,`mod.rs:1159-1166` | `activeRunConflict` 的冲突集是 **项目级**（`project_active_run_ids`，`mod.rs:3666`），且 `lock_project_execution` 是**一个**全局锁文件 | A 包有 Run 在跑就不能 build B 包，也不能为 `tester` 加 Worker。**繁忙项目的团队永久不可修改。** 注：精确的按载体检查 `carrier_has_active_run` 曾存在，现已退为 `#[cfg(test)]` 死代码 |
| E2 | `router.rs:644-650` | `running` **或 waiting** 的会话阻塞团队变更 | waiting = 正在等人回答。**恰恰是最想重配的时刻不许重配** |
| E3 | `request.rs:291-298` | 请求组内有 `recoverable` 就拒绝 rework | `recoverable` 是卡住态；必须先显式取消才能重试，而重试正是对卡住的标准反应 |
| E4 | `manager.rs:5108-5117` | 一个会话只允许一个未决 Human 请求，且新的不能替换旧的 | Worker 无法在旧问题未答时追问；daemon 无法用新计划卡覆盖过期提问 |
| E5 | `project_control.rs:463-468`,`183-192` | 同类 action 的挑战会**互删** | 同种类两个独立待批计划无法并存，批准一个会静默销毁另一个 |
| E6 | `planner.rs:498-510` | 生成目标必须字节一致，无优先级/合并策略 | 两个 skill 无法共同贡献同一配置文件；手改生成文件会**阻塞全部后续 build** 而非报告为漂移 |
| E7 | `runtime.rs:288-297` | 引擎 root frame id 固定为字面量 `1` | 结构上排除了恢复进子块、拆分 Run、嫁接修复子树——长流程最自然的恢复动作 |

## 3. 本提案的范围与顺序

35 项不可能一次做完，也不该。按**根因收敛**而非逐条修：

### P0 — fork 失权（B1）：把授权从会话身份迁到项目授权

这是触发点，也是唯一有用户明确诉求的一项，优先做。

1. **拆分三职责**（原提案 §2.3 的主张，现给出落点）：
   - **授权**：用户对该 Project 是否有权 → 新的项目级授权记录，不含 session id；
   - **归属**：某 operation 的事件投给谁 → 保留 session id，这是 J3 允许的用途；
   - **一致性**：目标是否仍在预期 revision → 已有 CAS，不变。
2. **`is_bound` 的 7 处调用改为查授权**，而不是比 id。`has_binding`（项目级，
   `router.rs:1121` 已在用）是现成的正确形状——**注意这两个函数已经并存，语义不一致本身就是证据**。
3. **fork 继承授权**：`SessionCreate` 已经 `rebind`，fork 走同一条路径。
   **一致即正确**——旧代码没有在 fork 分支里调用过 `project_control`（当时的
   `router.rs:1746`、`1764`），这处不一致没有任何设计理由存在。
4. **归档不得搁死授权**：`SessionArchive` 与 `SessionDelete` 同样释放或转移。
5. 保留 `exception_authority` 作为**故障恢复**通道，但它不再是 fork 的唯一出路。

验收：从中间 fork、归档原会话、在 fork 里继续 build/dispatch/管理，全程无需项目先出故障。

**落地状态（2026-09-21）：第 3 项已合入**——`router.rs` 新增 `rebind_project_control_if_pm`，
`SessionFork`、其定向变体和 `SessionForkImport` 三个入口现在都调用它，与 `SessionCreate` 走同一条
路径。单测 `a_forked_session_inherits_project_control_the_same_way_a_fresh_one_does` 与
`rebinding_a_non_pm_workspace_is_a_no_op` 覆盖了机制本身；`testctl` 重跑
`specialty.agent.fork-load` 及既有 workflow 包специalties 未见回归。

**第 1/2/4 项尚未落地**：把 `is_bound` 的 7 处调用改造成真正的项目级授权查询，以及让
`SessionArchive` 释放/转移绑定，是对授权模型本身的改动，范围明显大于"让 fork 和 create 一致"，
需要单独设计和验收，不应和这次最小修复混在一起仓促做。当前的修复只保证了**已有绑定能正确转移**，
没有改变"绑定是什么"这件事——`is_bound` 仍然是会话身份相等，J3 尚未在这 7 处真正生效。

### P1 — capability 与 verifier 注册表（D1 + D2）：Git 迁出的前提

用户决策"Git 从平台剔除、放到 workflow 管理层"要求先有 D1。顺序不可颠倒。

- **D1 `uses` 注册表**：新增唯一一个 `uses: pack.script`，宿主契约为：路径在已批准包内、
  argv 传参（不经 shell）、cwd 限定已授权 Workspace、超时与输出上限、进程树取消、
  stdout 必须有界结构化 JSON、`idempotencyKey` 透传。平台不理解语义。
- **D2 verifier 注册表**：**仅纯判定式声明谓词**。2026-09-20 已否决可执行 verifier
  （理由：破坏审计链可复算性），本提案不推翻。
- **执行与判定分离**：`pack.script` **产生**事实并进入 Run 记录，纯判定谓词**检查**事实。
  任何人拿 Run 记录都能重跑判定而不必重跑副作用——审计链依旧可复算。
- **能力锚定（J2）**：可执行能力绑定到被批准的 `source_digest`。
  **必须同批堵住的洞**：包升级方式是 `git pull`，pull 完 digest 就变而不过任何挑战；
  若不处理，J2 退化成"批准一次之后作者随意改脚本"。机制几乎白送——`workflow list` 已经在算
  `source_digest` 与 `drifted`（`mod.rs:1060`、`1065`），只需把漂移从**展示字段**升级为
  **执行前置条件**，漂移返回 `capabilityRevoked` 而非崩溃。

关于"未知作者的脚本凭什么可信"：用户的决策是"可以信任 WM 编写的 workflow，平台层无需假设所有人
都无法信任"。**落地时不要实现成一个 trusted 标志位**——那是包可自声明的字段，等于没有门。正确的
锚点已经存在：`workflow build --apply` 必须过人类挑战（`router.rs:406`），卡片写明包 id、源
digest、产物目录和**被授予的组件权限**，并绑定 `plan_digest + expected_revision`。用户批准一次
build，已经是在批准"这份源码获得调度 Worker 和取得写租约的权力"；让同一次批准额外覆盖脚本执行，
**是在同一个门上多说一句话，不是开新门**。WM 因此天然被信任——不因为它叫 WM，而因为它的产出要进
项目必须过同一道批准。PM 小团队的灵活性（自批自包、无需外部审核）与可核对边界同时保住。

### P2 — Git 迁出平台（原提案 §8，按当前代码重算）

`workflow-engine` **已经完全干净**（0 处 Git 引用），耦合全在 daemon 的 workflow 层。

原提案 §8 已失效的四条（dev-1 包化重构提前消化）：`BootstrapGitPlan`/`bootstrapCommit` 已 0 引用；
`bootstrap_pack.rs` 已删除，§8.3 前提消失；§12.4 兼容映射无对象；§7.1 的 `pack.json` 清单形态已变为
`workflow.md` 两字段 frontmatter + 平台自算 digest。

仍需迁移的 9 处调用点：

| 位置 | 用途 | 去向 |
|---|---|---|
| `mod.rs:2429` `status` | 取租约前检查工作区干净 | → 包脚本 `observe` |
| `mod.rs:2434` `current_ref` | 解析 `targetRef: "current"` | → 包脚本 `observe` |
| `mod.rs:2441` `resolve_ref` | 记录 `base_commit` 基线 | → 包脚本返回 opaque revision |
| `mod.rs:2366` `resolve_ref` | `git.commitOnTarget` 读当前提交 | → 包脚本 + 声明式判定 |
| `mod.rs:2378` `is_ancestor` | 祖先关系验证 | → 包脚本产出布尔证据 |
| `mod.rs:2393` `repository_directories` | 实验隔离的仓库边界 | → 通用 Workspace 路径包含判定 |
| `structured.rs:317` `current_ref` | 结构化流程读 ref | → 包脚本 `observe` |

对应移除：`with.writeLease.targetRef`、`LeaseRecord` 的 `repository`/`target_ref`/`base_commit`、
`git.commitOnTarget` verifier。

**原提案没料到的新矛盾**：dev-1 这次重构把 kernel 的 Git 调用点**从 6 增加到 9**——
`mod.rs:1086-1088` 的 `package_provenance` 新增 `resolve_ref`/`remote_url`/`status`，用于报告包来源。
这是有意设计（注释："a receipt would be a second copy of a fact Git already owns"），但与
"core 不直接执行 git"冲突。**取舍：provenance 保留但降级为展示性可选事实**——允许失败并返回
`None`，不进入任何授权、验证或一致性路径；信任依据是平台自算的 digest，不是 git remote。
因此 layer lint 按"**core 的正确性不得依赖 git**"写，而不是"core 不得出现 git 字样"——后者会把
一个无害展示功能判红。

### P3 — Activity Event Router（原提案 §4/§5，完整保留）

与 P0 是**同一个根因的两半**：P0 修"授权不该绑会话"，P3 修"归属不该靠猜"。证据经复核全部成立：

- `FlowMessageStatus`（`domain.rs:1320`）已有 `run_id`/`node_id`/`attempt`/`causation_id`/`expected_revision`——结构化路由地基真的在；
- `causation_id` 实际基本未填：全仓 3 处写入，2 处硬编码 `None`，仅 1 处透传（`mod.rs:4159`）；
- `inbox.rs:444` 仍把 Human 消息与 Workflow notice 拼成一段文本交给同一次 turn，把"哪条是当前
  要求、哪条是旧 Run 通知"留给模型判断——**这是用提示词兜正确性的边界**。

保留原提案 §4.3 接纳规则、§4.4 三条 lane（`human`/`activity`/`recovery`）、逐事件 ACK、
§4.5 确定性 snapshot、§5 fork 语义。交点：`pack.script` 的 `idempotencyKey` 由 Operation 身份派生
（`run.id:node.id:attempt`）。

### P4 — 排他性收窄（E1、E2、E3）

- **E1 把项目级冲突集收窄到载体级**：精确检查曾经存在（`carrier_has_active_run`，现为死代码），
  恢复它并把 `lock_project_execution` 按包分片；
- **E2 waiting 不应阻塞**：等人回答的会话不是在写，改为只阻塞 `running`；
- **E3 `recoverable` 允许直接 rework**，不强制先取消。

### 暂不在本提案范围（记录理由）

- **A1 role↔Worker 1:1**：路线图第 6 项，明确"最后做，需实例身份与租约模型设计，先设计后实现"。
- **D5/D6/D7 封闭词表**、**C2/C3 树形变更**、**E6/E7 引擎与 planner**：均需独立设计，
  且不阻塞 P0-P3。列入清单是为了让它们**可见**，不是承诺本轮交付。
- **地基（前置）**：去掉 role/project 定义的 `deny_unknown_fields`，让平台不消费的字段透明搬运。
  零风险，是 D1-D4 的共同前提，应在 P1 之前先合。

## 4. 不变量

1. **J1**：平台只定义它必须亲自执行的结构。
2. **J2**：可执行能力锚定已批准的 `source_digest`；漂移即失效。
3. **J3**：授权判断针对"谁有权"；身份相等只用于归属，不用于权限。
4. `unmanaged` 诚实声明（原提案 §6.4，保留）：平台、UI、测试都不得把它描述为"已原子提交"；
   脚本必须能区分 `applied`/`not-applied`/`indeterminate`，恢复先 `observe`，
   **不得靠重跑可能非幂等的脚本"试试看"**。
5. 不放开可执行 Skill Provider——`PB006` 维持拒绝。`pack.script` 是 Workflow 节点能力，
   与 Skill Provider 是两条路径，不得互相借道。
6. 不引入包可自声明的 trusted 标志位。

## 5. 完成定义

1. 从中间 fork、归档原会话、在 fork 中继续管理项目，全程不需要项目先出故障；
2. `is_bound` 不再作为授权判据存在于任何路径；
3. `uses` 与 verifier 有注册机制，且 fake/directory 参考实现证明契约不依赖任何仓库工具；
4. 脚本执行能力绑定已批准 digest，漂移有结构化错误；
5. kernel 与 Workflow schema 不再出现 Git 专有类型；平台核心的**正确性**不依赖 `git`，
   provenance 失败降级为未知；
6. Human 输入与异步 Activity 事件不再混为一轮命令；
7. 团队变更不再被无关包的 Run 或等待回答的会话阻塞；
8. Git 项目、纯目录项目分别通过独立端到端验收；
9. `journey.workflow.pm-builds-game-with-team`（包模型回归 oracle）全程持续通过。
