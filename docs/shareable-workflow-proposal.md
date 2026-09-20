# 可分享 Workflow 包设计提案

> 状态：已实现。设计与决策记录保留在本文；当前实现见 [package.rs](../apps/daemon/src/workflow/package.rs)、
> [build.rs](../apps/daemon/src/workflow/build.rs) 与随产品发布的内置包
> [game-delivery](../apps/daemon/workflow-packages/game-delivery/workflow.md)。<br>
> 落地时相对本文的两处修正：`$project` 解析为 `.genethub/`（因此项目公共 Skill 写作 `$project/skills`，
> 与 `$workflow/skills` 同形）；包的 executor 载体判定为「声明 executor 且不同时是 worker 的 Space」——
> WorkflowManager 既是 Worker 又挂 executor 以拥有自己的子团队，按组件存在与否判定会把它误判成第二个载体。<br>
> 上游事实：[architecture.md](./architecture.md) B1–B5、[workflow-executor-model.md](./workflow-executor-model.md)、[workflow-authoring.md](./workflow-authoring.md)。<br>
> 取代对象：`genehub.bootstrap-pack.v1` 的编译期内嵌 Pack 形态（[bootstrap_pack.rs](../apps/daemon/src/bootstrap_pack.rs)）。

## 1. 要解决的问题

Workflow 现在是产品的内部资产：唯一一个 Pack 用 `include!(concat!(env!("OUT_DIR"), "/bootstrap_packs.rs"))`
（`bootstrap_pack.rs:32`）编进 daemon 二进制，升级靠 `pack.json` 里手写的 `upgradeSources[].fileDigests`
表（`apps/daemon/bootstrap-packs/game-delivery-v1/pack.json` 共 532 行，其中绝大部分是那张 digest 表）。
社区作者既无法产出这样的包，也无法分发它。

目标是让 Workflow 变成**普通 git 仓库里的普通目录**，满足四条用户旅程：

| 旅程 | 要求 |
| --- | --- |
| J1 拿链接复现 | 给任意 Agent 一个仓库链接即可搭建；已有项目里 Agent 先报匹配度事实，再建议就地装或新开项目 |
| J2 上传分享 | 跑稳的 Workflow 用 `git push` / PR 发布，不需要导出命令、打包格式或中心注册表 |
| J3 多包并存 | 一个项目可同时装多个 Workflow（中大型游戏的不同管线），平台只做分类提示，不做准入限制 |
| J4 git 原生 | 包在仓库里的目录结构就是它被消费时的结构；一个仓库可存一个包，也可存一个包集 |

## 2. 现状事实

以下都是当前源码的事实，设计基于它们，不基于推断。

| 事实 | 位置 |
| --- | --- |
| Workflow 源在**项目根**，不在 executor 目录 | `workflow/mod.rs:40` `SOURCE_DIR = ".genethub/workflow"`，`source_root()` 的入参是 project root |
| executor 是项目根的子目录，由执行绑定选择 | `workflow/mod.rs:82` `executor_path`、`:938` `resolve_execution_binding` |
| Run 快照在 executor 会话的组件实例下，且强制留在项目根内 | `workflow/mod.rs` 的 `executor_snapshot_relative`、`save_run` |
| AgentSpace 与 Workspace 是同一 `workspace_id` 上的叠加层，1:1 | `config.rs` 的 `WorkspaceEntry` / `AgentSpaceEntry`，`parent_workspace_id` 为 `None` 者即项目 |
| 受管 Space 只能位于 `<project>` 或 `<project>/spaces/<name>` | `agent_space_builder/mod.rs:500-522` `validate_space_root`（`PB011`） |
| Builder 已实现四平台 Skill 投影 | `agent_space_builder/planner.rs:322-325`：`codex→.agents/skills`、`cursor→.cursor/skills`、`codebuddy→.codebuddy/skills`、`claude-code→.claude/skills` |
| Skill Provider 的边界是**项目根**，不是 space 根 | `agent_space_builder/manifest.rs:550` `provider_root.starts_with(project_root)` |
| `.pipebuilder/skills` 自动插入为最高优先级 Provider | `manifest.rs:495-509` |
| git Provider 与可执行 Provider builder 均被拒绝 | `manifest.rs:520-523`、`agent_space_builder/mod.rs:206-209`（均为 `PB006`） |
| 产物 Space 被改动即失效 | `workspace.rs:697-704`：`verify_pipe_space` 与 `builder_lock_digest` 不一致直接拒绝 dispatch |
| 一个项目当前只能有一个可选 executor | `workspace.rs:681-684` `exactly one reusable {component_id} child` |
| 激活指针是项目级单文件 | `workflow/mod.rs:2637` `activation_path` → `<runtime>/activation.json` |
| 自动诊断的触发条件、配额、提示词、只读与证据边界全部由平台硬编码 | `workflow/supervision.rs:5-8`、`:192-213`、`:380-395`；项目配置只提供载体与 agent/model |
| 组件 id 是封闭清单，未知 id 直接拒绝 | `agent_space.rs:31-37` `COMPONENT_IDS`（`pm`/`executor`/`worker`/`reviewer`） |
| daemon 的 git 能力**只有本地操作**：init、commit、status、diff、resolve-ref，没有 clone/fetch/remote | `git.rs:22-556` |
| 今天有**两条**获得 Workflow 的路径 | Pack 安装（`bootstrap_pack::apply`，`router.rs:2587`）与直接初始化（`workflow::initialize_and_activate`，`router.rs:801`，资产来自 `bootstrap_pack::direct_workflow_files`） |
| `.genethub/.gitignore` 目前只白名单 `workflow/` | `workflow/mod.rs:3021` 要求 `*`、`!.gitignore`、`!workflow/`、`!workflow/**` |

两个由此得到的结论：

1. **共享 Skill 的机制早就存在，是现有 Pack 没用。** `game-delivery-v1` 五个 space 全部是
   `skillProviders: [{"type":"folder","path":"skills"}]`，`game-reviewer` 与 `workflow-reviewer`
   各写一份评审契约。跨 space 复用只需要把 Provider 路径指向项目内的共享目录，schema 不用动。
2. **executor 从来不持有 Workflow 源**，它持有产物与运行期快照，而且这一点由 digest 强制，不靠约定。
   所以「Agent 改进自己的流程该去哪改」没有歧义：改源再 rebuild。

## 3. 术语与归属

- **Workflow 包**：一个目录，含 `workflow.md`。身份 = 目录名，不写进任何配置文件。
- **Workflow 包集**：一个目录，不含 `workflow.md`，其子目录里含。
- **Flow**：包内的一条流程定义，沿用现有 `genehub.workflow.definition.v1`。一个包可以有多条 Flow
  （`game-delivery-v1` 现在就有 6 条），它们共享同一个 executor。
- **源 / 产物**：`.genethub/` 下的手写内容是源；`<project>/spaces/` 下的一切是 `workflow build` 的产物，
  全部可重建。

Workspace 与 AgentSpace 不是两个东西：AgentSpace 是挂在同一个 `workspace_id` 上的组件叠加层。
「Workspace 在哪由 Workflow 定义」这句成立的方式是：包的 `space.json.src` 声明 `folders[]`，
build 把它物化到产物 Space；**不是**让包决定受管 Space 的落盘位置——那个位置仍由
`validate_space_root` 固定在 `<project>/spaces/<name>`。

## 4. 设计决策

### D1 包 = git 仓库里的原样目录，身份 = 目录名

发现规则（整个设计的支点）：从 `<project>/.genethub/workflows/` 向下递归扫描，**含 `workflow.md`
的目录就是一个包，id = 它相对 `.genethub/workflows/` 的路径**，命中后不再向下。标记文件与 `SKILL.md`
同构——一份带 frontmatter 的说明文档既是给人看的入口，也是给扫描用的锚点（见 D9）。

于是「一个仓库存一个包还是一个包集」完全由用户 clone 到哪决定，平台零配置：

```
git clone <单包仓库> .genethub/workflows/game-build      → id = game-build
git clone <包集仓库> .genethub/workflows/studio          → id = studio/game-build
                                                          id = studio/film-edit
```

不需要打包格式、不需要 release、不需要中心注册表、不需要导出命令。发现靠 GitHub topic 与社区列表。
这正面解决了 Skill 生态的痛点：包在仓库里的形状就是它被消费时的形状。

### D2 源与产物分离，用 `workflow build` 物化

包目录是纯源，**不放任何受管 Space**。`workflow build <id>` 把源物化到 `<project>/spaces/<flat-id>--<name>/`，
正好落在 `validate_space_root` 既有的白名单里——**不放宽 `PB011`**。

这条推翻了本设计早期版本「放宽 `validate_space_root`，让 AgentSpace 直接住在包目录里」的结论。
当时的理由是「clone 即到位、省掉安装器」；错在把「省掉安装步骤」当成了目标本身。引入 build 之后
三件事同时更好：包仓库干净无产物污染；多包靠 id 前缀天然不撞名；Builder 的路径准入规则一行不改。
代价是 clone 之后要跑一次 build，而 build 本来就是需要的（Skill 四平台投影、Provider 路径解析、
授权挑战都发生在这一步）。

### D3 Skill 四层叠加 + 逻辑引用

层级由 Provider 顺序决定，同名 shadowing 已是 Builder 现有行为：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 1（最高） | Space 自己的 `spaces/<name>/skills/` | 单个 Space 的本地覆盖；build 自动置顶为 Provider |
| 2 | 包的 `skills/` | 本 Workflow 专有 |
| 3 | 包集的 `skills/` | 同一仓库内多个包共享（review、证据契约这类） |
| 4 | 项目 `.genethub/skills/` | 跨包的项目约定 |
| 5 | 产品 builtin-skills | 平台能力 |

需要新增的只有**逻辑引用**：源里写 `$workflow` / `$collection` / `$project`，build 解析成真实相对路径。
没有它，作者得硬编码 `../../../…`，包一挪就断。Builder 的 manifest schema 不变，解析发生在 build 生成
`pipespace.json` 之前。

### D4 多包并存：删项目级 `defaultWorkflow`，一个包绑一个 executor

- 项目级 `default_workflow`（`workflow/mod.rs:74`，校验在 `:2120` 与 `:2208`）删除，且**不在包里复活**。
  PM 用 `workflow list` 查有哪些包、各自绑哪个 executor、哪些是 dev，然后显式点名。
- `executorPath` 从 `project.yaml` 挪走，由 build 从包 id 确定性推导为 `spaces/<flat-id>--executor`，
  作者不手写。
- `workspace.rs:681-684` 的 `exactly one reusable executor` 约束必须改成「按包解析出的路径精确选择，
  匹配不到或匹配多个才报歧义」。
- 激活指针从项目级单文件（`activation_path`）改成按 executor 分文件；Candidate 仍是内容寻址，不变。

Flow 选择同理：包内只有一条 flow 时隐含选中，多条时必须 `--workflow <id>` 点名，否则报歧义并列出候选。
这替代了今天 `cli_front/workflow.rs:565` `select_workflow` 的 `kind`/`complexity` 打分路由——见 D9。
包之间的冲突只在「同一个 flow id 被多个包声明」时报歧义，**不拒绝安装**。

### D5 源里的 Space 定义加 `.src` 后缀

两个文件：`space.json.src` 与 `pipespace.json.src`（D12 合掉了原来的第三个）。理由不只是「怕被规则脚本
误扫」，是真的会撞：`workspace.rs` 的目录列举会把 `*.code-workspace` 收集成可打开的 workspace 候选，
`load_manifest` 认的就是 `pipespace.json`，`detect_legacy` 也在扫特定文件名。源里放真文件会让人和 Agent
误以为那是个活 Space。

补一条规则：**包源里不得有 `.pipebuilder/skills/`**，因为它在产物 Space 里会被自动注入成最高优先级
Provider（`manifest.rs:495-509`）。Space 自己的 Skill 放在 `spaces/<name>/skills/`，由 build 写成
生成 manifest 里的第一优先级 Provider（D12）。

### D6 删安装器，保留授权

`bootstrap_pack.rs`（1607 行）**整个文件删除**：编译期内嵌（`:32`）、`upgradeFrom`/
`upgradeSources.fileDigests`（`:901` 一带，那张 digest 表随之消失）、
`{{PROJECT_SPACE_NAME}}`/`{{AGENT_ID}}`/`{{MODEL_ID_YAML}}` 模板渲染（`:845-892`，改为约定固定文件名
+ 从 daemon 配置解析缺省）、`MAX_PACK_FILES`/`MAX_PACK_BYTES`（改为 build 侧输入限额，见 §8）、
回执整套（`save_receipt` `:1056`、`receipt_matches`、`receipt_space_bindings`、`receipt_commit`）。

回执可删是因为它记的三件事都有更直接的来源：来源 commit 读包目录自己的 `.git`；Space 归属由产物
目录名 `spaces/<flat-id>--<name>/` 确定性推导；是否最新由「源树 digest vs `builder_lock_digest`」判断，
而后者本来就存在 daemon 配置里。多存一份就是多一处会漂移的事实。

一并删掉的还有**第二条获得 Workflow 的路径**：`workflow::initialize_project` /
`initialize_and_activate`（`router.rs:801`）与它依赖的 `bootstrap_pack::direct_workflow_files`，
以及被穿进 Candidate 的 `bootstrap_pack_digest` 字段（`workflow/mod.rs:216`、`:2425`、`:2442`、`:2510`
的特判）。新模型下获得 Workflow 只有一条路：clone 一个包，然后 build。

**不能删的是授权。** `space.json.src` 声明的 `components: [{componentId: executor}]` 意味着调度权——
executor 能派发 Worker、能拿写租约。这不能由「往目录里放个文件」获得，否则任何 clone 进来的包都自带
了权限。人类挑战的形状（`challenge_spec` at `bootstrap_pack.rs:111` 的 `planDigest` + `expectedRevision`
+ git head/status digest + 精确 bootstrap commit）原样搬进新的包模块，语义从「安装包」变成
「授权这个包的组件拓扑」。

一句话：**删掉安装器，不删授权。**

### D7 实验 = 一个普通的 `dev: true` 包

新结构下实验不需要独立机制：`cp -r game-build game-build-v2`（或开一个 git branch）就得到完全独立的
定义 + 载体，两套可以同时跑做 A/B。今天做不到——今天定义只有一份，只能来回切 Candidate digest。

`dev: true` 只是提示字段。PM 使用 dev 包时应额外关注健康度，而健康度给的是事实不是形容词：源/产物
digest 漂移、`workflow check --draft` 状态、每个被引用 role 是否有 enabled Worker（`worker_space_for_role`）、
最近 N 次 Run 的失败/返工/阻塞。

### D8 本轮已拍的其余决定

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| PM 侧 Skill 归谁 | PM 只装通用 Skill（产品内置或 `$project/skills`），包通过 `workflow.md` 向 PM 自我描述 | 根 AgentSpace 只有一个而包有多个；允许包往 PM 投影会让 PM 的能力面随装了几个包而漂移 |
| id 含 `/` 时的产物目录名 | 扁平化为 `-`，build 时检测撞名并报错 | `studio/game-build` 与 `studio-game/build` 会撞；报错比引入转义规则便宜 |
| 包依赖包 | 本版不做 | 多管线用「多包并存 + 各自独立」表达已足够；依赖图会让升级合并复杂度翻倍 |
| 导出/上传命令 | 不做 | `git push` / PR 即发布 |

### D9 清单收敛：只剩 `workflow.md` 的 frontmatter

本设计的第一版给包写了一份 `workflow.yaml`，含 `category` / `requires.tools` / `requires.git` /
`cliMinVersion` / `expects` / `executor` / `flows[]` / `defaultFlow`。**这些字段绝大多数没有执行点，
应当全部删除。** 判据只有一条：**一个字段要么被机械消费，要么能从目录结构推导出来；两者都不是的，
它就是散文，应该写在 `workflow.md` 正文里给人和 Agent 读。**

| 原字段 | 处置 | 理由 |
| --- | --- | --- |
| `category` | 删 | 没有任何消费者。包集目录路径（`studio/game-build`）已经是分类轴，再加一个自由字符串只是第二套不一致的分类 |
| `requires.tools` `requires.git` | 删 | 平台不装 Unity，也不该假装能校验它。真实门禁发生在执行期：Agent 按需安装，装不上时节点带真实错误失败——这比一行未经核实的声明更强的证据 |
| `requires.cliMinVersion` | 删 | 兼容性已经有机械门：flow/role 的 schema 是 `deny_unknown_fields`，版本不匹配时 `workflow check --draft` 必然失败并给出定位诊断。手写版本号只是把同一件事再说一遍，而且会写错 |
| `expects` 检测器 | 删 | J1 的匹配度事实全在项目侧（已装包、flow id 与 Space 名冲突、git 是否干净、是否空目录），平台本来就能算。包侧的「面向 UE 项目」是散文，写进 `workflow.md`；Agent 就站在项目里，自己 glob 比一套三选一的检测器 DSL 更灵活 |
| `executor.space` | 删 | 由 `spaces/*/space.json.src` 中声明 executor 组件的那个目录推导；0 个表示这是纯定义包，多于 1 个报错 |
| `executor.root` | 删 | 节点 task cwd 缺省 `.`，由 Run 输入覆盖。它是每次运行的事实，不是包的属性 |
| `flows[]` | 删 | 扫 `flows/*.yaml`，id 取文件内 `id`，build 校验 id 与文件名一致。登记表是目录的复述 |
| `defaultFlow` | 删 | 见 D4：单条隐含，多条点名 |
| `summary` | 删 | 与 `workflow.md` 首段重复 |

剩下的用 `workflow.md` 的 YAML frontmatter 承载——形状与 `SKILL.md` 完全一致，作者不用学第二套约定：

```markdown
---
description: Unity 构建管线；从改动到可提交审核的 Android 构建
dev: true          # 可选，实验中
---

做什么、何时用、需要哪些前置工具、怎么算验收——这一段是给人和 PM 读的散文，不是 schema。
```

两个字段各自有理由：`description` 是 `workflow list` 与 PM 路由的机读摘要（`SKILL.md` 同款）；
`dev` 是本轮明确要的实验标记。

### D10 `diagnosticRole` 不是包清单字段：策略归平台，载体由 Space 自己声明

项目级 `diagnosticRole`（`ProjectDefinition.diagnostic_role`）容易被误认为「包自带的诊断策略」。
读完 [supervision.rs](../apps/daemon/src/workflow/supervision.rs) 后，事实是**策略整块属于平台**：

| 诊断的组成 | 归属 | 位置 |
| --- | --- | --- |
| 何时触发（180 秒无 LLM／工具活动，且不是在等人） | 平台硬编码 | `supervision.rs:5` `SILENCE_MS`、`:97`、`:116-125` |
| 触发几次、跑多久、几轮 LLM | 平台硬编码 | `:6-8` `MAX_DIAGNOSTICS=2` / `DIAGNOSTIC_DEADLINE_MS` / `DIAGNOSTIC_CALLS=8`，配额按 request group 计（`:180-195`） |
| 诊断会话的提示词 | 平台硬编码 | `:392` 整段 prompt 由 Rust 拼出，**角色的 `prompt` 文件不参与** |
| 只读与证据边界 | 平台强制 | `:381` 拒绝非 `evidence_only` 角色；`:395` `SessionUserInteraction::ReadOnly` + `evidence_scope` |
| 失败与超时后如何回报 PM | 平台硬编码 | `:411`、`:455-465` |
| **跑在哪个 Worker Space、用哪个 agent/model** | **包** | `:382-394` 用 `role.id` 经 `worker_space_for_role` 选载体，用 `role.agent_id`/`model_id`/`mode_id` 起会话 |

所以这个字段实际只表达一件事：**这个包里哪个 Worker Space 充当诊断载体。** 它不该是清单键，
理由和 `executor` 一样——载体的身份应该由载体自己声明。做法也一样：在
`spaces/<name>/space.json.src` 的 `components[]` 里加平台组件 `diagnostic`（`reviewer` 那样「extends
worker」的附加组件），全包 0 个或 1 个，多于 1 个报错。于是清单少一个字段，而授权路径不变——
组件拓扑本来就要过人类挑战，诊断载体的权限也就一并被授权覆盖。

有一件真实的包侧能力不能丢：诊断会话跑在那个 Space 里，**该 Space 的 Skill 会进入诊断上下文**，
所以「这个流程的诊断该看什么、怎么写报告」仍然是包作者能表达的（现有包就是靠
`spaces/workflow-reviewer/skills/workflow-reviewer/SKILL.md` 表达的）。这也是**不采用**「平台直接在
executor Space 里跑诊断、彻底不需要声明」的原因：那样会把 executor 面向派发的 Skill 塞进诊断上下文，
同时丢掉按包定制诊断视角的能力。

没有任何 Space 声明 `diagnostic` 时，诊断能力不可用——走的仍是今天已有的分支：`:208-213` 记录
「未配置或额度已用完」并通知 PM 按机械事实处理，不是报错。

另一条被否掉的路是让 `roles/<id>.yaml` 自己声明 `diagnostic: true`：角色现在是「被 flow 引用才加载」
（`workflow/mod.rs:2165-2175`），改成扫描 `roles/` 会让一个没被任何 flow 引用的散落文件影响 Candidate，
而 [workflow-authoring.md](./workflow-authoring.md) 明确把「uncataloged scratch files 不能篡改角色清单」
当作既有保证，不值得为省一个字段换掉它。Space 声明没有这个问题：`spaces/` 本来就要被完整扫描并物化。

于是**包里不再有任何 `*.yaml` 形式的清单**，`<project>/.genethub/project.yaml` 也整体消失
（它原本只剩 `schema` + `execution.root`，全部可缺省）。项目是否启用 Workflow 的标记从
「存在 `project.yaml`」改为「存在 `.genethub/workflows/` 目录」。

### D11 升级就是 `git pull`，平台既不实现合并，也不联网

本设计的第一版要平台实现三方合并（以回执里的源 commit 为 base）。**这是把 git 已经做完的事再做一遍。**
包目录本身就是一个 git 工作树，所以升级的完整形态是：在包目录里 `git pull`（或 `fetch` + `merge`、
切 tag、开分支，随用户的习惯），git 自己产出冲突标记；带冲突标记的 YAML 必然通不过
`workflow check --draft`，天然阻止激活；解决完再 `workflow build`。平台侧需要写的代码是零。

同理，**daemon 不需要联网**。`git.rs` 今天只有 init / commit / status / diff / resolve-ref，没有
clone、fetch 或任何 remote 概念；为了「给个链接就能装」而把网络、凭据与离线降级引进 daemon，
是本设计能犯的最大一次范围扩张。J1 的链接由 Agent 处理：它有终端，
`git clone <url> .genethub/workflows/<name>` 是一条普通命令，clone 完包就在那儿了。

于是「安装」这个动作在平台侧不存在：**clone 到位 = 有源但无权限，build = 授权并物化**。

### D12 每个 Space 两个源文件，`parent` 推导，层 1 就是 Space 自己的 `skills/`

- `<name>.code-workspace.src` 删除：它唯一的内容是 `folders[]`，并进 `space.json.src`。
- `space.json.src` 的 `parent` 删除：声明 executor 组件的 Space 父级是项目，其余 Space 的父级是本包的
  executor。这是 `agent_space.rs` 已有的拓扑约束（worker 挂在 executor 下），不必让作者再写一遍。
- 于是源里每个 Space 只剩两个文件：`space.json.src`（`lifecycle` + `components[]` + `folders[]`）与
  `pipespace.json.src`（原样复用 Builder 的 `pipespace.v1`，不发明第二套 schema）。
- `skills-override/` 改名为 `spaces/<name>/skills/`，并且**不再物化成 `.pipebuilder/skills/`**：build
  直接把它作为第一优先级 Provider 写进生成的 `pipespace.json`。少一个特例目录名、少一个物化步骤，
  四层叠加的实现方式也统一成「全都是 Provider」。

## 5. 目录结构

**源（手写，git 管理）：**

```
<project>/                                   # 根 AgentSpace = PM，唯一持有 .genethub/
├── .genethub/
│   ├── skills/                              # 第 4 层：跨包的项目约定
│   │   └── house-style/SKILL.md
│   └── workflows/
│       ├── studio/                          # 无 workflow.md → 是包集
│       │   ├── .git/                        # 一个仓库 = 一个包集
│       │   ├── README.md
│       │   ├── skills/                      # 第 3 层：包集公共 Skill
│       │   │   ├── review-common/SKILL.md
│       │   │   └── evidence-contract/SKILL.md
│       │   ├── game-build/                  # id = studio/game-build
│       │   │   ├── workflow.md              # 唯一清单：frontmatter 两个字段 + 散文正文
│       │   │   ├── flows/{game-dev,game-review}.yaml   # 现有 definition.v1，未改
│       │   │   ├── roles/{coder,reviewer}.yaml         # 现有 role.v1，未改
│       │   │   ├── prompts/{coder,reviewer}.md
│       │   │   ├── skills/                  # 第 2 层：本包专有
│       │   │   │   └── unity-coder/
│       │   │   │       ├── SKILL.md
│       │   │   │       ├── references/  scripts/
│       │   │   │       └── .pipe-agents/cursor/        # 按 Agent 平台差异化
│       │   │   ├── spaces/
│       │   │   │   ├── executor/
│       │   │   │   │   ├── space.json.src   # lifecycle + components[] + folders[]
│       │   │   │   │   └── pipespace.json.src
│       │   │   │   ├── coder/               # 同上两件
│       │   │   │   └── reviewer/
│       │   │   │       ├── …两件
│       │   │   │       └── skills/          # 第 1 层：本 Space 覆盖
│       │   │   └── scripts/check.mjs        # 包自校验，先由 Agent 口头维护
│       │   └── film-edit/                   # id = studio/film-edit
│       └── my-unity-build/                  # 单包仓库，id = my-unity-build
└── spaces/                                  # 全部是 build 产物
```

**产物（`workflow build` 生成，全可重建）：**

```
<project>/spaces/
├── studio-game-build--executor/
│   ├── pipespace.json             # 逻辑引用已解析成真实相对路径
│   ├── executor.code-workspace    # 由 space.json.src 的 folders[] 生成
│   ├── .agents/ .cursor/ .codebuddy/ .claude/    # Builder 四平台投影
│   └── AGENTS.md
├── studio-game-build--coder/
├── studio-game-build--reviewer/
└── studio-film-edit--executor/
```

## 6. Schema 草案

**`workflow.md`（包的唯一清单，兼作发现标记）：**

```markdown
---
description: Unity 构建管线；从改动到可提交审核的 Android 构建
dev: true
---

做什么、何时用、需要哪些前置工具、怎么算验收。
```

两个字段都可选（`description` 缺省取正文首段）。其余一切由目录推导：

| 事实 | 来源 |
| --- | --- |
| 包 id | 目录相对 `.genethub/workflows/` 的路径 |
| 包版本 | 该目录所在 git 仓库的 commit |
| flow 清单 | `flows/*.yaml`，id 取文件内 `id`，build 校验与文件名一致 |
| role 清单 | flow 引用的 `roles/<id>.yaml`（保持「引用才加载」） |
| executor | `spaces/*/space.json.src` 中声明 executor 组件的那个；>1 报错 |
| 诊断载体 | 同上，声明 `diagnostic` 组件的那个；0 个表示不启用自动诊断（见 D10） |
| 产物路径 | `spaces/<flat-id>--<space>/`，由 build 推导 |
| task cwd | 缺省 `.`，由 Run 输入覆盖 |

`flows/*.yaml`、`roles/*.yaml`、`prompts/*.md` 的 schema **完全不变**；
`catalog.yaml`（`CatalogDefinition` / `CatalogEntry` / `WorkflowMatch`）整体删除。

**`pipespace.json.src`（逻辑引用 + 跨层复用）：**

```json
{
  "schema": "pipespace.v1",
  "name": "reviewer",
  "agents": ["codex", "cursor", "codebuddy", "claude-code"],
  "skills": ["game-reviewer", "review-common", "evidence-contract"],
  "tags": ["worker", "reviewer"],
  "skillProviders": [
    { "type": "folder", "path": "$workflow/skills" },
    { "type": "folder", "path": "$collection/skills" },
    { "type": "folder", "path": "$project/skills" }
  ],
  "children": { "scanDepth": 0 }
}
```

本 Space 自己的 `skills/` 不用写：build 自动把它作为第一优先级 Provider 插在最前（D12）。

**`space.json.src`（另一个源文件，替代原来的 `space.json` + `.code-workspace`）：**

```json
{
  "lifecycle": "pooled",
  "components": [{ "componentId": "worker", "role": "reviewer" }],
  "folders": ["."]
}
```

`parent` 不写，由组件推导（D12）。

**`<project>/.genethub/project.yaml`：删除。** `ProjectDefinition`（`workflow/mod.rs:70-78`）的四个字段
分别归零——`schema` 随文件消失，`default_workflow` 见 D4，`execution` 全部可缺省，`diagnostic_role`
改由 Space 声明 `diagnostic` 组件推导（见 D10）。项目是否启用 Workflow 的标记改为「存在 `.genethub/workflows/`」，
`find_source_root` 的向上查找相应改为找该目录。

**`.genethub/.gitignore`** 的白名单（`workflow/mod.rs:3021`）随之改为 `skills/**` 与 `workflows/**`，
并显式再忽略 `workflows/**/.git/`，使 clone 进来的包仓库永远不会漏进项目仓库的 index。

## 7. CLI 面

CLI 是薄转发器（[cli-thin-forwarder.md](./cli-thin-forwarder.md)），下列动词的语义全在 daemon：

```sh
"$GENEHUB_CLI" workflow list                        # 每个包：来源(git) + dev + 编译状态 + 产物漂移 + 授权状态 + 冲突
"$GENEHUB_CLI" workflow build <id> [--dry-run]      # 源 → 产物 Space + Skill 投影 + Provider 解析 + lock
"$GENEHUB_CLI" workflow check --draft               # 已存在，不变
```

只有两个新动词。原先设计的 `inspect` 与 `status` 都删掉了：clone 到位之后包就在
`.genethub/workflows/` 里，`list` 已经把它连同「未构建 / 未授权 / 已漂移」一起报出来，
不需要第二个只读入口；`status` 报的源 digest 与 `builder_lock_digest` 也是 `list` 的一列。

`list` 纯只读：**不执行包内任何脚本**。包内 `scripts/` 与 Skill 一样是按需读取的普通文件；
Provider 的 `command`/`build` 已被 `PB006` 拒绝，本设计不放开。

J1 的 Agent 动作序列：`git clone <url> .genethub/workflows/<name>`（Agent 的普通命令，不是平台能力）
→ `workflow list` 拿事实 → 三选一路由建议（就地装 / 新开项目装 / 只读不 build）→
`workflow build --dry-run` → 人类挑战 → `build`。匹配度事实**全部来自项目侧**：已装包列表、
flow id 与 Space 名冲突、git 是否干净、是否空目录。包侧只提供 `workflow.md` 散文，由 Agent 结合它
看到的项目自行判断（要不要 glob `*.uproject` 是 Agent 的事，不是清单字段）。平台不替用户决定。

升级同理不需要动词：在包目录里 `git pull`，然后 `workflow build`（D11）。

`workflow dispatch` 的 `--kind` / `--complexity` 路由随 `match` 一起删除；选择只剩 `--workflow <id>`，
包内单条 flow 时可省略。

## 8. 改动面

| 位置 | 改动 |
| --- | --- |
| `apps/daemon/src/bootstrap_pack.rs`（1607 行） | **整个文件删除**。只有 `challenge_spec`（`:111`）的挑战形状搬进新包模块；`router.rs:2530/2571/2587/2658/2701` 的 `BootstrapPack*` 请求一并下线 |
| `apps/daemon/src/workflow/mod.rs`（第二条路径） | 删 `initialize_project`（`:704`）、`initialize_and_activate`、`router.rs:801` 的入口，以及 Candidate 上的 `bootstrap_pack_digest`（`:216`、`:2425`、`:2442`、`:2510` 特判） |
| `apps/daemon/src/workflow/mod.rs` | `SOURCE_DIR` 变为按包解析；删除 `ProjectDefinition`（`:70-78`）与 `CatalogDefinition`/`CatalogEntry`/`WorkflowMatch`（`:88-108`）；`find_source_root` 改找 `.genethub/workflows/`；`resolve_execution_binding` 改从包推导；`activation_path` 按 executor 分文件；`.gitignore` 白名单更新 |
| `apps/daemon/src/cli_front/workflow.rs` | `select_workflow`（`:565`）去掉 `kind`/`complexity` 打分与 `default_workflow` 回退，只留显式 id 与「单条隐含」；对应 CLI flag 下线 |
| `packages/proto`（`src/domain.rs:1125/1177/1230`、`bindings/index.ts:1890/1932`） | `WorkflowCatalogEntryStatus` 移除 `matchKind`/`matchComplexity`，`WorkflowProjectStatus` 移除 `defaultWorkflow`；**同一个 release set 一次删干净，不留 deprecated 窗口** |
| `apps/daemon/src/workspace.rs` | `exactly one reusable executor`（`:681-684`）改为按解析路径精确选择，匹配不到/多个才报歧义 |
| `apps/daemon/src/agent_space.rs` | `COMPONENT_IDS`（`:31-37`）加入 `diagnostic`，规则与 `reviewer` 同形（extends worker，禁止在 worker 停用时保留） |
| `apps/daemon/src/workflow/supervision.rs` | `Supervision.diagnostic_role` 的来源从 `project.yaml` 改为「声明 `diagnostic` 组件的 Space 及其 worker role」；`:381` 的 `evidence_only` 硬性检查保留；`:208-213` 的「未配置」分支语义不变 |
| `apps/daemon/src/agent_space_builder/manifest.rs` | Provider 路径新增 `$workflow`/`$collection`/`$project` 逻辑引用解析（边界检查 `:550` 不变） |
| 新增 `apps/daemon/src/workflow/package.rs`（暂名） | 包发现、`workflow.md` frontmatter 解析、build（两个 `.src` → 产物 Space、Provider 路径解析、调 `agent_space_builder::run`）、撞名检测、授权挑战 |
| `apps/daemon/bootstrap-packs/game-delivery-v1/` | 已改写为 `apps/daemon/workflow-packages/game-delivery/`（源形态，不再内嵌），`pack.json` 消失；PM 的 `project-manager` Skill 按 D8 迁为产品内置 |
| `docs/workflow-executor-model.md` / `docs/workflow-authoring.md` | 同步「定义在包、载体在产物 Space」的归属描述 |

**限额**（替代原 `MAX_PACK_FILES`/`MAX_PACK_BYTES`）：单包文件数、单包字节数、扫描深度、单项目包数
在 `list` 与 `build` 两侧同时生效，超限 fail closed。

**不需要写的东西**：升级合并（git 做，D11）、网络与凭据（Agent clone，D11）、回执（来源读 `.git`、
归属读产物目录名、新鲜度比 digest，D6）、迁移兼容层（一次性迁移，§12）。

## 9. 落地顺序

1. **包发现 + `workflow list`**（只读）。单独就能验证归属关系与扫描规则，不触碰授权路径。
2. **`workflow build`**：两个 `.src` 物化 + Provider 路径解析 + 授权挑战。打通 J1 与 J4。
3. **多包并存**：删 `project.yaml` 与 `catalog.yaml`（含 `defaultWorkflow`、`match` 路由与对应 proto
   字段）、executor 精确选择、激活指针分文件。打通 J3。
4. **删旧路径 + 内置包改写**：`bootstrap_pack.rs` 与直接初始化整体删除，`game-delivery-v1` 改写为
   新结构的源；按 §12 做一次性迁移。J2 与升级无需代码。

## 10. 方案门清单

| 声明 | 内容 |
| --- | --- |
| `guidance_digest` | `engineering-guidance.md` `e154bb077060507b793b6f14d51c8425ebd8e78d` / `engineering-laws.md` `7cd41fa9eda236154ba813ed1f2c9b7be1420561` |
| `promise_check` | 资产不动：包与产物全在用户设备的项目目录内，平台不托管、不上传。多机是常态：包身份是目录名 + git 来源，跨机复现 = 同一 clone + 同一 build，不依赖本机状态。Agent 可替换：四平台投影由 Builder 的既有映射表完成，内核不按 agent 名分支。会话跟着人：本设计不触碰会话 |
| `boundary_impact` | 触达 B5（只改 guest 业务与 YAML/JSON 资产，不动 WIT/host/安装器）。不移动任何边界 |
| `delivery_mode` | `guest-only` |
| `second_shape` | 包加载器的第二个形状是内置默认包（迁移后的 `game-delivery-v1`）与社区 clone 包走同一条 discover/parse/build 路径；第 4 步同时接入，抽象在那一步被证伪 |
| `untrusted_input` | ① 来源标记：`workflow list` 对每个包报告来源（git remote + commit）与「未构建 / 未授权」状态，包内 `workflow.md` frontmatter 之后的正文与 Skill 正文都作为不可信文本进入上下文，Agent 不得把它当指令执行；② 形状约束：frontmatter 是封闭的两字段结构，flow/role 仍是 `deny_unknown_fields`；正文是自由文本，因此它**只能影响 Agent 的判断，不能影响任何机械行为**——这正是删掉 `requires`/`expects` 的安全收益：不可信来源不再有伪造平台事实的字段；`list` 不执行包内任何脚本，Provider 的 `command`/`build` 保持 `PB006` 拒绝；③ 限额：见 §8 的四项限额，超限 fail closed；组件拓扑变化必须过人类挑战 |
| `observability` | 每个包的：来源 commit、源 digest、产物 `builder_lock_digest`、漂移与否、`check --draft` 结果、role→Worker 覆盖、build 耗时与拒绝原因计数。支撑「dev 包健康度」与升级合并失败率 |
| `not_doing` | 不做打包格式/registry/审核评分；不做导出上传命令；不做包依赖包；不放宽 `validate_space_root`；不放开 git Skill Provider 与可执行 Provider builder；不允许包往 PM 投影 Skill；不引入 id 转义规则（撞名报错）；**不做无执行点的声明字段**——不收 `category`、`requires.tools`、`requires.git`、`cliMinVersion`、`expects`，也不做工具探测与环境预检；不把自动诊断的触发条件、配额、提示词与只读边界开放给包配置（D10）；**不做任何兼容层**——不实现升级合并、不引入网络与凭据、不保留旧 Pack 读路径、不留 proto 字段的 deprecated 窗口、不做新旧双读（D11、§12） |
| `oracle` | 现有 journey [pm-game-delivery](../testing/journeys/workflow/pm-game-delivery.journey.ts) 必须在内置包迁移后继续通过（防回归 oracle）；新增 case：递归发现与 id 推导（标记文件为 `workflow.md`）、包集/单包两形态、撞名报错、flow id 与文件名不一致报错、包内出现 0 个或 >1 个 executor Space 时的行为、0 个或 >1 个 `diagnostic` Space 时的行为（0 个必须走既有「未配置」通知而不是报错）、多 flow 未点名时的歧义错误、`.src` 物化后产物 digest 与授权、四层 Skill shadowing 的最终落盘内容、未授权包不得获得 executor 组件、`$collection/skills` 解析不到时 build 报错、带 git 冲突标记的源必须被 `check --draft` 拒绝。真实组件：daemon 的 workflow 编译器与 AgentSpaceBuilder；无网络边界可 mock——daemon 不联网，测试里的包就是本地目录 |

`G01–G11` 逐项：`G01` 适用（§2 事实先于设计）；`G02` 适用（见 `second_shape`）；`G03` 适用——本次
只删不加字段（`WorkflowProjectStatus.defaultWorkflow`、`WorkflowCatalogEntryStatus` 的
`matchKind`/`matchComplexity`），定义仍只在 `packages/proto` 一处，daemon 与 Web/CLI 在**同一个
release set 内一次删干净**；兼容窗口按本轮决定明确不做，旧客户端读到的是字段缺失而不是降级语义；
`G04` 适用（`guest-only`）；`G05` 适用（包属于项目目录、跨机靠 clone + build 复现，远端不可达时
`workflow list` 只报本地事实并标注来源未知）；`G06` 适用（社区包复用直接消掉「把跑通的流程重新描述
一遍」这类人工输入）；`G07` **适用但结论相反**——`Capabilities` 说的是**平台能力**要提前声明，
不是要求包声明它的环境依赖；工具是否装得上属于执行期事实，平台没有探测它的执行点，硬做只会得到
一个永远不准的假门；`G08` 适用（见 `untrusted_input`）；`G09` 适用（见 `observability`）；`G10` 适用
（见 `not_doing`）；`G11` 适用（见 `oracle`）。

## 11. 已关闭的问题

1. **存量项目如何过渡**：一次性迁移，不留兼容窗口。平台侧不写迁移命令，迁移是 PM 按 §12 执行的
   普通文件操作 + 一次 `build`。
2. **`$collection/skills` 在包被单独 clone 时不存在**：build 报错，不静默跳过。少一层 Skill 造成的
   行为差异比一条构建失败难查得多。
3. **升级合并粒度**：不适用，合并由 git 做（D11）。

## 12. 一次性迁移规范

面向存量项目（已 bootstrap 过 `game-delivery-v1`，或用直接初始化建过 `.genethub/workflow/`）。
**平台不提供迁移命令**，下面是 PM 可以逐条执行并核对的规范；每一步都是普通文件操作或既有命令。

前置：项目 git 工作区干净；记下当前 `workflow check` 的活跃 Candidate digest 以备比对。

1. **建包目录**：`.genethub/workflows/<name>/`，`<name>` 即新的包 id（存量项目建议 `local`）。
2. **搬定义**：`.genethub/workflow/workflows/*.yaml` → `<pkg>/flows/`（`catalog.yaml` 不搬，删除）；
   `roles/` 与 `prompts/` 原样搬到 `<pkg>/roles/`、`<pkg>/prompts/`。确认每个 flow 文件名与文件内
   `id` 一致，不一致的改文件名。
3. **写清单**：`<pkg>/workflow.md`，frontmatter 写 `description`；实验中的包加 `dev: true`。
   原 `project.yaml` 的 `defaultWorkflow` 不迁移——记住它，之后由 PM 在 dispatch 时点名。
4. **搬 Space 源**：现有 `spaces/<name>/` 里手写的部分（`pipespace.json`、`.code-workspace` 的
   `folders[]`、space 本地 skills）改写成 `<pkg>/spaces/<name>/` 下的 `pipespace.json.src` 与
   `space.json.src`；原 `spaces/<name>/skills/` 搬到 `<pkg>/spaces/<name>/skills/`。
   跨 Space 重复的 Skill 这时可以上提到 `<pkg>/skills/` 或 `.genethub/skills/`。
   诊断载体所在 Space 的 `space.json.src` 加 `{"componentId": "diagnostic"}`。
5. **删旧源**：`.genethub/workflow/` 整个删除（含 `project.yaml`）；`.genethub/.gitignore` 白名单改成
   `skills/**`、`workflows/**`，并忽略 `workflows/**/.git/`。
6. **删旧产物**：`<project>/spaces/` 下由旧 Pack 装出来的目录整体删除，连同它们在 daemon 配置里的
   AgentSpace 注册（旧回执文件一并删除）。产物全部可重建，不需要保留。
7. **重建**：`workflow check --draft` 通过后 `workflow build <pkg>`，过人类挑战，产物落到
   `spaces/<pkg>--<space>/`。
8. **核对**：`workflow list` 应显示该包已构建、无漂移；抽一条历史任务重跑，确认 executor 与各 Worker
   Space 都能被派发。旧 Run 记录保留但不再可复现——它们绑定的载体已经不存在，这是一次性迁移的
   已知代价。
