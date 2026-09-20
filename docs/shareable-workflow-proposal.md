# 可分享 Workflow 包设计提案

> 状态：提案（未实现）。本文按[产品工程引导](./engineering-guidance.md)的方案门清单产出，实现前需过门。<br>
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
| `.genethub/.gitignore` 目前只白名单 `workflow/` | `workflow/mod.rs:3021` 要求 `*`、`!.gitignore`、`!workflow/`、`!workflow/**` |

两个由此得到的结论：

1. **共享 Skill 的机制早就存在，是现有 Pack 没用。** `game-delivery-v1` 五个 space 全部是
   `skillProviders: [{"type":"folder","path":"skills"}]`，`game-reviewer` 与 `workflow-reviewer`
   各写一份评审契约。跨 space 复用只需要把 Provider 路径指向项目内的共享目录，schema 不用动。
2. **executor 从来不持有 Workflow 源**，它持有产物与运行期快照，而且这一点由 digest 强制，不靠约定。
   所以「Agent 改进自己的流程该去哪改」没有歧义：改源再 rebuild。

## 3. 术语与归属

- **Workflow 包**：一个目录，含 `workflow.yaml`。身份 = 目录名，不写进任何配置文件。
- **Workflow 包集**：一个目录，不含 `workflow.yaml`，其子目录里含。
- **Flow**：包内的一条流程定义，沿用现有 `genehub.workflow.definition.v1`。一个包可以有多条 Flow
  （`game-delivery-v1` 现在就有 6 条），它们共享同一个 executor。
- **源 / 产物**：`.genethub/` 下的手写内容是源；`<project>/spaces/` 下的一切是 `workflow build` 的产物，
  全部可重建。

Workspace 与 AgentSpace 不是两个东西：AgentSpace 是挂在同一个 `workspace_id` 上的组件叠加层。
「Workspace 在哪由 Workflow 定义」这句成立的方式是：包的 `<name>.code-workspace.src` 声明 `folders[]`，
build 把它物化到产物 Space；**不是**让包决定受管 Space 的落盘位置——那个位置仍由
`validate_space_root` 固定在 `<project>/spaces/<name>`。

## 4. 设计决策

### D1 包 = git 仓库里的原样目录，身份 = 目录名

发现规则（整个设计的支点）：从 `<project>/.genethub/workflows/` 向下递归扫描，**含 `workflow.yaml`
的目录就是一个包，id = 它相对 `.genethub/workflows/` 的路径**，命中后不再向下。

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
| 1（最高） | 产物 Space 内 `.pipebuilder/skills/` | 单个 Space 的本地覆盖（由源里的 `skills-override/` 物化） |
| 2 | 包的 `skills/` | 本 Workflow 专有 |
| 3 | 包集的 `skills/` | 同一仓库内多个包共享（review、证据契约这类） |
| 4 | 项目 `.genethub/skills/` | 跨包的项目约定 |
| 5 | 产品 builtin-skills | 平台能力 |

需要新增的只有**逻辑引用**：源里写 `$workflow` / `$collection` / `$project`，build 解析成真实相对路径。
没有它，作者得硬编码 `../../../…`，包一挪就断。Builder 的 manifest schema 不变，解析发生在 build 生成
`pipespace.json` 之前。

### D4 多包并存：删项目级 `defaultWorkflow`，一个包绑一个 executor

- 项目级 `default_workflow`（`workflow/mod.rs:74`，校验在 `:2120` 与 `:2208`）删除，语义降级为包内
  `defaultFlow`。PM 用 `workflow list` 查有哪些包、各自绑哪个 executor、哪些是 dev。
- `executorPath` 从 `project.yaml` 挪走，由 build 从包 id 确定性推导为 `spaces/<flat-id>--executor`，
  作者不手写。
- `workspace.rs:681-684` 的 `exactly one reusable executor` 约束必须改成「按包解析出的路径精确选择，
  匹配不到或匹配多个才报歧义」。
- 激活指针从项目级单文件（`activation_path`）改成按 executor 分文件；Candidate 仍是内容寻址，不变。

冲突只在「同一个 intent 或 flow id 被多个包声明」时报歧义，让人显式选，**不拒绝安装**。包可以声明
`category`（`game/build-pipeline`、`game/asset-pipeline`、`film/edit`…）——自由字符串，我们只维护一份
推荐前缀列表，纯粹用于给人分类和给歧义提示，不是准入条件。

### D5 源里的 Space 定义加 `.src` 后缀

三个文件：`space.json.src`、`pipespace.json.src`、`<name>.code-workspace.src`。理由不只是「怕被规则脚本
误扫」，是真的会撞：`workspace.rs` 的目录列举会把 `*.code-workspace` 收集成可打开的 workspace 候选，
`load_manifest` 认的就是 `pipespace.json`，`detect_legacy` 也在扫特定文件名。源里放真文件会让人和 Agent
误以为那是个活 Space。

补一条规则：**包源里不得有 `.pipebuilder/skills/`**，因为它在产物 Space 里会被自动注入成最高优先级
Provider（`manifest.rs:495-509`）。源里的覆盖层放在 `spaces/<name>/skills-override/`，由 build 物化。

### D6 删安装器，保留授权

可以删：编译期内嵌（`bootstrap_pack.rs:32`）、`upgradeFrom`/`upgradeSources.fileDigests`（`:901` 一带，
那张 digest 表随之消失）、`{{PROJECT_SPACE_NAME}}`/`{{AGENT_ID}}`/`{{MODEL_ID_YAML}}` 模板渲染
（`:845-892`，改为约定固定文件名 + 从 daemon 配置解析缺省）、`MAX_PACK_FILES`/`MAX_PACK_BYTES` 这类
内嵌尺寸限制（改为 build 侧的输入限额，见 §8）。

**不能删的是授权。** `space.json.src` 声明的 `components: [{componentId: executor}]` 意味着调度权——
executor 能派发 Worker、能拿写租约。这不能由「往目录里放个文件」获得，否则任何 clone 进来的包都自带
了权限。现有的人类挑战（`challenge_spec` at `bootstrap_pack.rs:111` + `planDigest` + `expectedRevision`
+ 精确 bootstrap commit）整体保留，语义从「安装包」变成「授权这个包的组件拓扑」。回执
（`save_receipt` at `:1056`）保留并扩展为按包记录来源 `{url, ref, commit}`，用于升级时的三方合并 base。

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
| `expects` 检测器 | 限制为 `glob:` / `path:` / `file-contains:` 三种 | 否则它会长成任意脚本，`inspect` 的只读保证就没了 |
| 导出/上传命令 | 不做 | `git push` / PR 即发布 |

## 5. 目录结构

**源（手写，git 管理）：**

```
<project>/                                   # 根 AgentSpace = PM，唯一持有 .genethub/
├── .genethub/
│   ├── project.yaml                         # 只剩项目级事实；无 defaultWorkflow
│   ├── skills/                              # 第 4 层：跨包的项目约定
│   │   └── house-style/SKILL.md
│   └── workflows/
│       ├── studio/                          # 无 workflow.yaml → 是包集
│       │   ├── .git/                        # 一个仓库 = 一个包集
│       │   ├── README.md
│       │   ├── skills/                      # 第 3 层：包集公共 Skill
│       │   │   ├── review-common/SKILL.md
│       │   │   └── evidence-contract/SKILL.md
│       │   ├── game-build/                  # id = studio/game-build
│       │   │   ├── workflow.yaml            # 包清单：dev / match / flows / executor
│       │   │   ├── workflow.md              # 给人和 PM 看：做什么、何时用
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
│       │   │   │   │   ├── space.json.src
│       │   │   │   │   ├── pipespace.json.src
│       │   │   │   │   └── executor.code-workspace.src
│       │   │   │   ├── coder/               # 同上三件
│       │   │   │   └── reviewer/
│       │   │   │       ├── …三件
│       │   │   │       └── skills-override/ # 第 1 层：本 Space 覆盖
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
│   ├── executor.code-workspace
│   ├── .pipebuilder/skills/       # 由 skills-override/ 物化
│   ├── .agents/ .cursor/ .codebuddy/ .claude/    # Builder 四平台投影
│   └── AGENTS.md
├── studio-game-build--coder/
├── studio-game-build--reviewer/
└── studio-film-edit--executor/
```

## 6. Schema 草案

**`workflow.yaml`（新增，替代 `catalog.yaml` 与项目级 `defaultWorkflow`）：**

```yaml
schema: genehub.workflow.package.v1
summary: Unity 构建管线：出一个可提交审核的 Android 构建
category: game/build-pipeline        # 自由字符串；平台只给推荐前缀
dev: false
requires:
  cliMinVersion: "0.14.0"
  components: [pm, executor, worker]
  tools: [{ id: unity, detect: "path:Unity" }]
  git: required
expects:
  - detect: "glob:*.uproject"
    hint: 面向 UE 项目；Unity 项目请用 …
executor:
  space: executor                    # 对应 spaces/executor/；产物路径由 build 推导
  root: "."                          # 节点 task cwd，相对项目根
defaultFlow: game-dev
flows:
  - id: game-dev
    path: flows/game-dev.yaml
    match: { kind: game, complexity: standard }
  - id: game-review
    path: flows/game-review.yaml
```

`flows[]` 就是今天的 `CatalogDefinition`（`workflow/mod.rs` 的 `CatalogEntry` / `WorkflowMatch`），
原样搬进包清单；`flows/*.yaml`、`roles/*.yaml`、`prompts/*.md` 的 schema **完全不变**。

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

**`<project>/.genethub/project.yaml`（瘦身后）：**

```yaml
schema: genehub.workflow.project.v2
execution:
  root: "."          # 缺省任务目录；包可覆盖
```

**`.genethub/.gitignore`** 的白名单（`workflow/mod.rs:3021`）随之改为 `project.yaml`、`skills/**`、
`workflows/**`，并显式再忽略 `workflows/**/.git/`，使 clone 进来的包仓库永远不会漏进项目仓库的 index。

## 7. CLI 面

CLI 是薄转发器（[cli-thin-forwarder.md](./cli-thin-forwarder.md)），下列动词的语义全在 daemon：

```sh
"$GENEHUB_CLI" workflow list                        # 扫描 + 来源(git) + dev 标记 + 编译状态 + 产物漂移
"$GENEHUB_CLI" workflow inspect <url|path>          # 只读：清单 + requires/expects + 当前项目冲突事实
"$GENEHUB_CLI" workflow build <id> [--dry-run]      # 源 → 产物 Space + Skill 投影 + Provider 解析 + lock
"$GENEHUB_CLI" workflow status <id>                 # 源 digest vs builder_lock_digest
"$GENEHUB_CLI" workflow check --draft               # 已存在，不变
```

`inspect` 是纯只读的：**不执行包内任何脚本**。包内 `scripts/` 与 Skill 一样是按需读取的普通文件；
Provider 的 `command`/`build` 已被 `PB006` 拒绝，本设计不放开。

J1 的 Agent 动作序列固定为：`workflow inspect`（事实）→ 匹配度报告 → 三选一路由建议（就地装 /
新开项目装 / 只读试跑）→ `workflow build --dry-run` → 人类挑战 → `build`。匹配度**只由事实构成**：
包侧的 `requires` 与 `expects`（受限检测器），项目侧的已装包列表、flow id 与 Space 名冲突、git 是否干净、
是否空目录。平台不替用户决定，Agent 也不猜。

## 8. 改动面

| 位置 | 改动 |
| --- | --- |
| `apps/daemon/src/bootstrap_pack.rs` | 大幅删：内嵌、digest 表升级、模板渲染、尺寸限制。保留并改造：`challenge_spec`、`save_receipt`（记来源 commit）、`write_asset` |
| `apps/daemon/src/workflow/mod.rs` | `SOURCE_DIR` 变为按包解析；`ProjectDefinition` 去掉 `default_workflow` 与 `execution.executor_path`（→ v2）；`CatalogDefinition` 并入包清单；`resolve_execution_binding` 改从包推导；`activation_path` 按 executor 分文件；`.gitignore` 白名单更新 |
| `apps/daemon/src/workspace.rs` | `exactly one reusable executor`（`:681-684`）改为按解析路径精确选择，匹配不到/多个才报歧义 |
| `apps/daemon/src/agent_space_builder/manifest.rs` | Provider 路径新增 `$workflow`/`$collection`/`$project` 逻辑引用解析（边界检查 `:550` 不变） |
| 新增 `apps/daemon/src/workflow/package.rs`（暂名） | 包发现、清单解析、build（物化 `.src` → 产物 Space、`skills-override/` → `.pipebuilder/skills/`、调 `agent_space_builder::run`）、撞名检测、三方合并升级 |
| `apps/daemon/bootstrap-packs/game-delivery-v1/` | 迁移为新结构的内置默认包，`pack.json` 从 532 行降到清单级别 |
| `docs/workflow-executor-model.md` / `docs/workflow-authoring.md` | 同步「定义在包、载体在产物 Space」的归属描述 |

**限额**（替代原 `MAX_PACK_FILES`/`MAX_PACK_BYTES`）：单包文件数、单包字节数、扫描深度、单项目包数
在 build 与 inspect 两侧同时生效，超限 fail closed。

**升级**：以回执里记的「安装时源 commit」为 base，项目现状为 ours，新版本为 theirs 做三方合并；
冲突留 marker 并阻止激活（`workflow check --draft` 必然失败，天然门禁）。这一步是社区可维护性的前提——
社区作者不可能手写维护 `fileDigests` 表，那是当前形态最硬的阻塞点。

## 9. 落地顺序

1. **包发现 + 清单 + `workflow list`**（只读）。单独就能验证归属关系与扫描规则，不触碰授权路径。
2. **`workflow build`**：`.src` 物化 + 逻辑引用解析 + 授权挑战复用。打通 J1 与 J4。
3. **多包并存**：删项目级 `defaultWorkflow`、executor 精确选择、激活指针分文件。打通 J3。
4. **三方合并升级**替掉 `fileDigests`，内置包迁移到新结构。
5. **`workflow inspect` + 匹配度事实报告**（J1 体验层）。J2 无需代码。

## 10. 方案门清单

| 声明 | 内容 |
| --- | --- |
| `guidance_digest` | `engineering-guidance.md` `e154bb077060507b793b6f14d51c8425ebd8e78d` / `engineering-laws.md` `7cd41fa9eda236154ba813ed1f2c9b7be1420561` |
| `promise_check` | 资产不动：包与产物全在用户设备的项目目录内，平台不托管、不上传。多机是常态：包身份是目录名 + git 来源，跨机复现 = 同一 clone + 同一 build，不依赖本机状态。Agent 可替换：四平台投影由 Builder 的既有映射表完成，内核不按 agent 名分支。会话跟着人：本设计不触碰会话 |
| `boundary_impact` | 触达 B5（只改 guest 业务与 YAML/JSON 资产，不动 WIT/host/安装器）。不移动任何边界 |
| `delivery_mode` | `guest-only` |
| `second_shape` | 包加载器的第二个形状是内置默认包（迁移后的 `game-delivery-v1`）与社区 clone 包走同一条 discover/parse/build 路径；第 4 步同时接入，抽象在那一步被证伪 |
| `untrusted_input` | ① 来源标记：`workflow list`/`inspect` 对每个包报告来源（git remote + commit）与「未授权」状态，包内 `workflow.md`、Skill 正文作为不可信文本进入上下文，Agent 不得把它当指令执行；② 形状约束：清单是带 schema 的封闭结构（`deny_unknown_fields`），`expects` 只允许 `glob:`/`path:`/`file-contains:` 三种检测器，`inspect` 不执行包内任何脚本，Provider 的 `command`/`build` 保持 `PB006` 拒绝；③ 限额：见 §8 的四项限额，超限 fail closed；组件拓扑变化必须过人类挑战 |
| `observability` | 每个包的：来源 commit、源 digest、产物 `builder_lock_digest`、漂移与否、`check --draft` 结果、role→Worker 覆盖、build 耗时与拒绝原因计数。支撑「dev 包健康度」与升级合并失败率 |
| `not_doing` | 不做打包格式/registry/审核评分；不做导出上传命令；不做包依赖包；不放宽 `validate_space_root`；不放开 git Skill Provider 与可执行 Provider builder；不允许包往 PM 投影 Skill；不引入 id 转义规则（撞名报错） |
| `oracle` | 现有 journey [pm-game-delivery](../testing/journeys/workflow/pm-game-delivery.journey.ts) 必须在内置包迁移后继续通过（防回归 oracle）；新增 case：递归发现与 id 推导、包集/单包两形态、撞名报错、`.src` 物化后产物 digest 与授权、四层 Skill shadowing 的最终落盘内容、未授权包不得获得 executor 组件、三方合并冲突阻止激活。真实组件：daemon 的 workflow 编译器与 AgentSpaceBuilder；mock 边界：git remote 用本地裸仓库，不打真实网络 |

`G01–G11` 逐项：`G01` 适用（§2 事实先于设计）；`G02` 适用（见 `second_shape`）；`G03` 不适用（不新增
跨端协议字段，CLI 输出经 daemon 既有结构化响应）；`G04` 适用（`guest-only`）；`G05` 适用（包属于项目
目录、跨机靠 clone + build 复现，远端不可达时 `workflow list` 只报本地事实并标注来源未知）；`G06` 适用
（社区包复用直接消掉「把跑通的流程重新描述一遍」这类人工输入）；`G07` 适用（`requires`/`expects` 是声明，
Agent 在动手前就知道装不装得上，不靠试错）；`G08` 适用（见 `untrusted_input`）；`G09` 适用（见
`observability`）；`G10` 适用（见 `not_doing`）；`G11` 适用（见 `oracle`）。

## 11. 开放问题

1. 内置默认包迁移期间，旧 `genehub.bootstrap-pack.v1` 回执与已 bootstrap 的存量项目如何过渡：一次性
   迁移命令，还是新旧读路径并存一个版本窗口？
2. 包集的 `skills/`（第 3 层）在包被单独 clone（不带包集）时不存在。build 应当在逻辑引用解析不到时
   报错，还是降级为跳过？倾向报错——静默少一层 Skill 比失败更难查。
3. 升级三方合并的粒度：整包一次合并，还是按 `flows/`、`roles/`、`spaces/` 分区各自合并并分别报冲突？
