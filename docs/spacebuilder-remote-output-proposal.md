# SpaceBuilder 独立输出与远程岗位制品改进提案

状态：待评审。日期：2026-10-24。实施槽位建议：`dev-3`。

本文交付设计文档；接口、配置及诊断名称中标为“拟议”的内容尚未实现。本文不代表已经完成跨机部署或 Beta 发布。

## 摘要与用户场景

用户希望团队源仓只保留在 Linux 协调机器上，把 QA、开发等岗位安排到 Mac mini 或其他机器执行，降低协调机器的 CPU 占用。其他机器只接收所需岗位及运行依赖，不再 clone 整个团队仓。业务项目仓和 worktree 仍在执行机器本地管理。

例如，Linux 的 `team/spaces/qa` 引用了共享身份和 Skill。现在直接 build 会把生成物写回原目录，其中工作区规则还包含 Linux 的绝对路径；把目录复制到 Mac 后，Agent 会读到错误路径。上一版讨论因此绕到“裁剪团队源码、传到远端重新 build”，并提出了 `pack --member qa`，增加了团队选择、打包和依赖收集的专有接口。

建议改为：直接以 `team/spaces/qa` 为输入，生成到团队规范临时区内的独立目录；由配置的 post 脚本补充运行资源、压缩、调用现有文件下载机制并验收安装。生成规则采用有明确基准的相对路径，远端无需团队源码或再次构建。

本期建议评审四项能力：**`build --output`、可迁移的路径表达、Space 级 pre/post hook、无需源输入的产物校验**。不新增 `pack`、`--member` 或内置 `deploy`。传输和安装继续是部署脚本组合平台原语完成的工作。

## 事实基线与槽位选择

本次以实际文件和只读命令结果核对现状，没有执行远程部署。历史中的 Mac 构建、传输和路径迁移实验没有在本次重跑，不能当作本提案的现场验收结果。

| 项目 | 本次基线或观察 |
| --- | --- |
| 产品仓 `genethub` | `3e047970a8b64fe1c2676bc7fed146a69f8529f5`，2026-10-24 fetch 后的 `origin/main` |
| Cloud 仓 `genethub-cloud` | `4a6d5a52a87fc99de449b0fad8b2aa321e758577`，同次 fetch 后的 `origin/main` |
| 内置 builder | SpaceBuilder `0.1.4`；槽位脚本与当前 Beta 安装中的脚本 SHA-256 均为 `e76b3004a03b755b7a47c5d1fef956bb9db947ebc5680e65bce9aa190ee56cca` |
| 当前会话所连 daemon | 上轮只读 `context` 返回 `0.17.1-beta.1`；不是拟议补丁的运行证明 |
| 原有槽位 | 扫描时所有已有双仓槽均有未提交改动；用户明确排除 `dev-2` |
| 新槽位 | 用管理入口创建 `dev-3`，从已有远程同名分支检出后，两仓均以 `merge --ff-only origin/main` 同步；router 返回 `valid: true`、`dirty: false` |

槽位选择以干净和隔离为先，不因为旧槽缺少新脚本就排除旧槽。本次没有可直接采用的干净旧槽，故创建受管新槽；未清理、stash 或覆盖其他槽的改动。创建了对应 Space 和端口注册项；未初始化 `dev.env`、构建产品或启动 dev 服务。本文件是新槽中新增的提案，保存后产品仓自然呈现这一项文档改动。

主要证据如下。函数名为稳定定位依据，行号对应上述源码版本。

| 证据 | 当前行为与设计影响 |
| --- | --- |
| [builder 主入口](../apps/daemon/builtin-skills/genehub/references/spacebuilder/spacebuilder.py) 的 `parse_args`、`discover_space_tree`（约 3831、971 行） | 接受一个 Space 目录，默认扫描 3 层子 Space；没有 `--member`、`--output` 或 `pack`。直接指定叶子 Space 就能独立构建，`children.scanDepth: 0` 可禁用向下扫描 |
| 同文件 `load_manifest`（约 709 行） | 严格校验字段，目前没有 Space 级 `buildHooks`；加入配置必须更新解析和文档 |
| 同文件 `workspace_rule`、`load_workspace`（约 1739、1014 行） | 规则写入 `folder.resolved`；manifest 中变量、绝对路径或本机不存在的 folder 会被跳过。不能用构建机的目录存在性决定远端工作区内容 |
| 同文件 `apply_build`（约 3185 行） | 以源 Space 为落盘根，写生成物和 `.spacebuilder/lock.json`；需要拆开输入根与输出根 |
| 同文件 `run_post_commands`（约 3200 行） | 已有 Provider 级后置命令、argv 执行、超时和错误诊断；不等于 Space 级构建生命周期 |
| 同文件 `verify_member_state`（约 3516 行） | 校验同时读取 manifest、identity 等源输入，并校验产物摘要；远端仅有产物时不能照搬现有 `verify` |
| [Python 注入](../apps/daemon/src/adapter/mod.rs)、[定时 hook](../apps/daemon/src/hooks/mod.rs) | 已有 `GENEHUB_PYTHON`、渠道绑定 CLI 及平台变量展开机制；Agent 与定时 hook 路径有源码证据，任意 remote shell 是否同等注入仍需验证 |
| [团队脚本](../apps/daemon/builtin-skills/genehub/references/team-template/tools/team.py) 的 `temp_new`、`builder_script`，以及 [temp 规范](../apps/daemon/builtin-skills/genehub/references/team-template/temp/README.md) | 已有标准临时目录、用途/创建者记录与清理，以及内置 builder 定位；不必自创 `/tmp` 文件名或另拷一份 builder |
| [文件传输合同](../apps/daemon/builtin-skills/genehub/references/file-transfer.md) | 接收方下载，已有断点续传、SHA-256 校验和状态回执；不应用 shell stdout 搬二进制 |

讨论来源可追溯至用户关于单源团队仓的要求 `ghref:item:s_7acc8a92efc1430d96c404b0fc7e67de:u_f8166951f1654304a44a2287ab654534`，以及要求改进内置 builder 的消息 `ghref:item:s_2818f870971f4f1d9b218cfb07b08124:u_104db9c2a1a94d5ba92d41de1559fc90`。后续要求撤去不必要的 pack、复用内置 Python/temp，以及排除 dev-2，分别对应消息 ID `u_34ae8318ae36468dbc56f2a03a422836`、`u_d18218a9f0d14675b9396ec9057f1695`。这些是需求来源，不是实现证据。

## 目标与边界

成功时，同一份 QA 源 Space 可在 Linux 上生成制品，移动到不同绝对路径的 Mac 后，只注册 QA 即可创建使用正确身份、Skill 和本机项目目录的新会话；远端不依赖团队 git、源 Provider 或构建机路径。

builder 负责确定性生成、路径表达和自己管理的文件；部署脚本负责团队所需的附加文件、压缩、传输、安装与回执。builder 仍保留独立 Python CLI、不依赖 daemon 的核心定位。

本期不解决项目仓同步、跨机器写任务互斥、远端派单目标归属、中央调度或自动升级用户的定制团队。这些不能通过“岗位制品安装成功”宣称已经完成。远端父容器及 `team.py` 若仍有自动注册根 Space 等行为，必须由团队部署适配明确限制；builder 不自动猜测或删掉某个 Skill。

## 拟议接口与输出合同

以下为拟新增调用，`$BUILD_DIR` 由调用方取得，`$SPACEBUILDER` 使用平台或团队已有定位机制得到；均不是新增的全局环境变量。

```bash
"$GENEHUB_PYTHON" "$SPACEBUILDER" build "$TEAM_ROOT/spaces/qa" \
  --output "$BUILD_DIR/artifact/spaces/qa" --format json

"$GENEHUB_PYTHON" "$SPACEBUILDER" verify \
  "$BUILD_DIR/artifact/spaces/qa" --artifacts-only --format json
```

`--output` 指向输入 Space 对应的输出根，不表示团队根，也不决定远端安装目录。输入有子 Space 时，保留现有向下发现规则，按相对路径输出；叶子岗位不需要成员选择参数。整个调用完成后 Space post 才可发布完整制品，不能在子树尚未生成时提前打包。

| 对象 | 推荐语义 |
| --- | --- |
| `sourceRoot` | 定位 manifest、identity、Provider 和 Space 源文件的本机根；绝不当作远端根 |
| `outputRoot` | 本次生成物实际落盘的位置；正常原地 build 时等于 sourceRoot |
| 远端安装根 | 部署脚本的参数，由目标机解释；核心 builder 不必认识机器 ID 或远端绝对路径 |
| 原地 build | 不传 `--output`，保留现有入口和所有权行为 |
| 独立输出 | 生成物与输出锁位于 outputRoot；不改源 Space 的现有生成物和所有权锁。原有 Provider 缓存/构建命令仍可能修改其约定位置，不能据此承诺源树绝对只读 |

独立输出拒绝 sourceRoot 本身、指向源树输入/生成目录的重叠目标及 symlink 逃逸；需要原地构建时继续使用原调用。临时区若位于团队根内，须位于发现扫描排除的 `temp` 路径，且不能落在当前输入 Space 的扫描子树内造成递归。重复构建只更新当前输出锁证明拥有的文件，非受管文件冲突报错，不清空目录。

生成目录必须包含可注册的执行描述，不能只输出 `AGENTS.md` 和 Skill 后就声称可部署。推荐在独立输出中派生最小 `agent-space.genet.json`，保留岗位名称、agents、agentCwd、folders 与所需运行配置，移除仅供编译的 identity、源 Provider 和 build hook；编译结果已经进入各 Agent 指令和 Skill。源描述摘要保留在 provenance 中，执行描述本身纳入输出文件摘要。

该执行描述是独立输出专有的受管文件类型。不得放宽原地模式对 Human-owned manifest 的覆盖保护。缺少完整执行合同前，不开放“制品直接注册”的对外承诺。

## 路径迁移与运行依赖

先修正 builder 自己生成的 workspace 规则：记录相对 Space 根的声明路径，明确 Space 根相对当前指令文件的位置。`agentCwd` 非空时，基准必须随生成文件位置调整；不能把 `../../datas` 随意解释成相对 Agent 当前 shell 目录。

独立输出模式保留合法的、可迁移的相对 folder 声明，允许其仅在远端存在；在安装目标上检查实际目录。变量路径沿用现有运行时配置解析机制，不能在 Linux 上展开出本机 worktree 后写进制品。绝对路径、Windows 盘符或 guest/native 路径不做字符串替换式迁移，应由目标端已有路径机制处理。

这不能自动修复用户 identity 文本、脚本或 Skill 中手写的绝对路径。部署验证应检查选定制品中是否残留构建机路径，并报告具体源位置；有意绑定本机的内容需明确适用范围，不能把相对路径机制描述成任意代码可移植。

团队脚本可能还依赖父容器、`tools/` 或资料目录。pre/post 按该项目需求复制最小运行资源、保留相对布局；`datas`、`temp`、worktree 的用户内容不打包。必要的父容器可以存在，但只注册目标岗位，不构建或注册根/前台。部署脚本须防止后续运行又隐式打开根；不靠“操作时记得不要打开”维持这一约束。

## Space 构建 hook

建议增加以下可选字段；示例中的脚本名是部署适配的拟议示例，并非已存在文件。

```json
{
  "buildHooks": {
    "pre": [
      {
        "cwd": ".",
        "args": ["{python}", "tools/prepare.py", "{sourceRoot}", "{outputRoot}"]
      }
    ],
    "post": [
      {
        "cwd": ".",
        "args": ["{python}", "tools/publish-station.py", "{outputRoot}"]
      }
    ]
  }
}
```

`cwd` 相对声明该 hook 的源 Space，`args` 按 argv 执行，不隐式经过 shell；`{python}` 为当前 builder 的 `sys.executable`。同时明确 `{sourceRoot}`、`{outputRoot}`、`{spaceName}` 的含义。旧 Provider command 的 `{spaceRoot}` 维持源根语义，避免悄悄把既有命令改成向输出根写入；需要消费输出的脚本显式使用新字段。

推荐生命周期为：静态校验及命令门禁 → 获取源/输出构建锁 → pre → 重新读取受影响输入并规划 → Provider build 与生成 → 原有 Provider post → 校验并写成功构建回执 → Space post。子树调用的成功边界覆盖整棵输入树。各 Space 的 pre 在其规划前执行，Space post 在整树生成与校验完成后按确定顺序运行，最后才执行入口 Space 的 post；因此发布整包应放入口 Space 的 post。

需要补充或保持的合同如下：

- `check`、`explain`、`build --dry-run`、`verify` 和 `clean` 均不运行 Space hook；dry-run 不承诺 pre 动态生成的输入已具备，只能报告缺项或前置需求。
- `--require-no-post-commands` 保持对旧 Provider post 的拒绝，并拒绝新增 pre/post；检查在 pre、Provider builder 或生成写入之前完成。它不是“静默跳过 hook”的开关，也不凭名称承诺禁止原有 Provider build。
- pre 失败不进入生成阶段；hook 已写出的文件不伪称自动回滚。生成或旧 Provider post 失败时不执行发布 post。post 非零、超时、目标不可达或完成回执未确认均不得返回“部署完成”。
- 子进程诊断写 stderr，stdout 保留机器可解析报告；报告区分生成阶段与 post 阶段，沿用稳定诊断体系，具体新增错误码在实施时统一分配。
- 构建锁负责本机构建并发，不能替代远端安装互斥。post 可重入，但发布脚本必须先查已有传输/安装回执，不能以重跑 build 为由重复执行外部动作。

生命周期原型必须覆盖已有 Provider 命令与整树 journal 的行为，不能只在单 Space 路径各插入一次 subprocess 就宣布完成。

## 复用内置机制的部署路径

| 机制 | 本方案如何使用 | 不应新增的重复能力 |
| --- | --- | --- |
| 内置 Python | GeneHub 调用 `$GENEHUB_PYTHON`；Python hook 使用同一 `sys.executable`；zip、摘要、文件处理用标准库 | 不依赖系统 `python3`、系统 zip，也不往内置 Python 安装包 |
| 团队临时区 | 通过现有 `team.py temp new <slug> --purpose ...` 取得 `temp/YYMMDD/hhmm_slug_hash4`，在其内部存产物和压缩包 | 不自创 `/tmp` 命名，不虚构通用 `genet temp` 命令；通用 builder 不依赖 team.py |
| 生命周期和所有权 | 沿用构建锁、原子写入、所有权锁、树 journal 及结构化报告，按输出根扩展 | 不另建一套通用部署数据库或团队成员打包系统 |
| 文件传输 | post 用渠道绑定 `$GENEHUB_CLI` 调 remote shell，让接收方 `file download`，保存 transferId | 不通过 shell stdout、Base64 或 stdin 传压缩包 |
| 本机配置 | 目标机器的 `.genethub/open.env` 保留 `WORKTREE_DIR` 等目标端配置 | 不覆盖目标配置，不把本机的 Python、CLI 或 worktree 绝对路径发往另一系统 |
| Space 注册 | 经现有目标端 `space open` 只注册岗位，回读 workspace 实际信息 | 不复制 workspace ID，不注册根，不把注册请求接收当作新会话成功 |

remote shell 必须在目标已登记的 workspace 和有效隔离边界内运行；首次安装若缺少可写锚点，报告具体缺口，不为了部署扩大配对权限。远端解释器、CLI 和平台路径使用目标机自己的绑定；当前源码已证明 Agent/定时 hook 的注入，普通 remote shell 的实际环境是实施前必验项，不把两者混为一谈。

压缩包一旦开始传输便不再修改。源端保留它直到传输终态确认，超出临时区保留期的长时间部署需使用既有持久资料区保存，不能假设 temp 永不清理。传输完成以接收方 `completed` 与 SHA-256 为准；源文件变化、完整性失败和中断分别按现有合同处理。

接收方下载到 staging，解包检查绝对路径、`..`、symlink 逃逸及文件权限，校验产物后安装。先保存旧版本受管文件及安装记录，再替换受管文件；移除旧版本已受管但新版本不再包含的文件。附加资源的受管清单由部署适配记录，不能把整个团队目录当作可删除对象。失败时恢复旧版本，保留用户数据、目标端 open.env 和项目 worktree；有活动会话时不自动切换其在用脚本，等待可确认的安全切换窗口。新身份只对新会话生效。

部署回执记录包外 SHA-256、源版本、目标机器/安装路径、阶段和对应 transferId；同一包和目标重试先回读回执再继续。未知安装状态先核查，不能盲目覆盖。归档摘要不放进包自身以制造自引用；builder 版本与产物摘要复用输出锁，部署回执只补跨机器事实，不设计大份重复 `DEPLOY.json`。

## 校验、兼容与恢复

推荐新增显式 `verify <产物根> --artifacts-only`：不加载源 Provider、不执行任何 hook，校验输出 schema、执行描述及全部受管产物的摘要、路径和可执行属性。它证明“交付的字节符合构建回执”，不证明远端目录存在、附加资源齐全或会话可执行。完整部署必须叠加目标端资源检查和新会话 smoke。

原有 `verify <源 Space>` 保持源输入和生成物一致性检查，不能遇到缺源就自动降级成产物检查。输出锁需要明确源码 provenance 与执行描述的不同身份；独立输出使用新版本化记录，旧 builder 遇到不认识的制品合同明确拒绝。新代码继续读取既有原地锁，旧原地流程不强制迁移。

不改用户的定制团队来“演示”新字段。旧版 builder 会拒绝新 manifest 字段，需先更新构建端；作为纯执行端的目标机应通过契约兼容检查，不强求与构建端脚本字节一致。内置源码发布后会物化到安装目录，用户直接修改安装副本不会成为产品修复；团队自带 `spaceBuilder` 或既有覆盖设置继续生效，必要时明确提示它尚未采用补丁。

出错时分别保留构建诊断、传输回执和安装回执。生成失败可清理输出锁证明拥有的临时文件；传输中断沿用同源同目标续传；安装失败恢复旧制品。外部 post 的副作用不由 builder 假装原子回滚，脚本必须报告已发生的动作和可恢复阶段。

## 改动位置与替代方案

| 问题 | 拟改位置 | 预期行为 |
| --- | --- | --- |
| 原地输出耦合、路径不便携 | 内置 `spacebuilder.py` 的规划/写入上下文、workspace 投影和路径检查 | 明确源/输出根，支持可迁移规则与独立输出 |
| 缺少 Space 生命周期 | 同脚本 manifest、单 Space 和树入口、命令执行/报告 | pre/post 的顺序、失败和安全模式一致 |
| 缺源不能验收 | 同脚本 lock schema、verify 及受管目标校验 | 输出执行描述可校验，原地源校验不降级 |
| 使用方不知标准入口 | [SpaceBuilder 说明](../apps/daemon/builtin-skills/genehub/references/spacebuilder.md)、[团队模板说明](../apps/daemon/builtin-skills/genehub-team/references/template.md)、必要的样板部署适配 | 使用内置 Python/temp/下载/注册；清楚说明已有团队如何采用 |

Cloud 仓没有预设产品改动。具体测试工程修改由实施阶段的测试 Skill 选定，这份文档不新增或运行产品测试。

| 替代方案 | 取舍 |
| --- | --- |
| 继续远端接收源码并 build | 可保留作兼容路径，但仍要搬源依赖、维护构建环境，不满足“本机直接出执行制品”的首选体验 |
| 增加 `pack --member` | 把团队裁剪与资源策略塞入通用 builder；叶子 Space 本可直接作为输入，本期不采用 |
| 只加 `--output` | 改动小，但仍有绝对路径、缺少执行入口及缺源校验问题，不能作为远程支持交付 |
| 本地用 `--target-root` 写死 Mac 目录 | 一个制品绑定一个路径，跨系统解释和目录存在性更复杂，本期优先相对路径 |
| builder 内置机器发现、传输和安装 | 与独立 CLI 边界冲突，重复平台能力；留给可配置 post 组合 |

独立输出会增加一种执行描述和校验模式，这是本方案主要实现成本。它由“不携带完整团队源仍能注册和验收”的目标直接产生，不能省略后改用一个只有规则文件的 zip 冒充完整岗位。

## 验收与交付边界

| 编号 | 输入或故障 | 必须观察到的结果 |
| --- | --- | --- |
| A1 | 原地调用及已有 Space 树 | 既有生成、clean 和源 verify 正常，扫描语义不变 |
| A2 | 叶子 QA → 独立输出；含子 Space 的入口另测 | 只从指定入口向下构建，源原有生成物和锁未变，输出布局/整树回执一致 |
| A3 | 输出目录重复使用、含非受管同名文件、目标重叠或 symlink | 仅更新锁拥有的内容；冲突/逃逸拒绝，不误删源文件或用户数据 |
| A4 | Linux 构建后移动路径；远端才有的 folder；agentCwd 非空 | 无构建机路径残留，声明未因源端目录缺失被丢弃，新会话定位正确 |
| A5 | pre 改输入、Provider build/post、Space post 各成功或失败 | 实际执行顺序符合合同；失败阻断发布，输出报告可判定阶段 |
| A6 | dry-run、check、explain、verify、clean 及拒绝命令模式 | hook 不执行；拒绝模式在新增 pre/已有命令副作用前失败 |
| A7 | 远端没有 identity/Provider；删改一个产物或执行描述 | artifacts-only 正常校验或精确报错；原 verify 不静默降级 |
| A8 | 系统 PATH 没有 python/zip；remote shell 环境不同 | 使用内置解释器和标准库；缺目标绑定明确失败，不回退到源机路径 |
| A9 | 下载中断、同包重试、源变化、完整性失败 | 保留正确回执、按现有合同恢复，无重复安装或假成功 |
| A10 | 安装到已有岗位，新版本删除旧脚本，安装中途失败 | 只替换/删除受管文件；失败可恢复，open.env、数据、worktree 保留 |
| A11 | 专用 Mac QA 首次安装及重复安装 | 下载 completed 且摘要一致；仅目标岗位被注册；目标目录/依赖正确；新会话读到预期身份与 Skill 并写出指定测试结果 |
| A12 | 团队支持文件可能隐式注册根；目标已有活动会话 | 根/前台未被隐式注册；活动任务不被静默切换，新身份仅在新会话生效 |

A1–A10 先做隔离验证；A11–A12 在获授权的专用测试岗位验收，检查机器、workspace、会话数量与测试文件摘要，不能只检查 argv、注册响应或命令退出码。真实 Mac 通过之前只能交付候选能力，不宣称已支持用户实际团队；Windows 路径合同未验证前不扩大支持声明。

分期建议：第一段完成输出、路径、hook 和产物校验的一致合同与隔离验证；第二段用最小部署适配完成 Mac QA 闭环，再交接 Beta Live 发布。只完成 hook 可以独立交付“构建扩展能力”，但不能宣传为完整远程制品机制。具体 Beta 组件版本由发布时的 release context 确定，不锁死旧聊天中的 `beta.2`；不夹带 App 安装包、设备安装或 daemon 重启。

本次仅新增此提案和为其准备的受管 dev-3 槽/Space，未实施上表能力、未推送提交、未部署用户团队、未发布 Beta。

## 实施前必须解决的验证项

1. 执行描述与输出锁的最小 schema：用真实 daemon 注册原型确认哪些字段必须保留，哪些属于源编译信息；确认旧锁与原地 clean 的保护不被放宽。
2. 整树 hook、Provider 命令和 journal 的阶段边界：原型证明 dry-run/安全模式确实无 hook 执行，整包发布不会早于子树成功。
3. agentCwd、目标端才存在的 folder 及变量路径：以目标 daemon 当前解析规则给出可运行例子，不能仅凭字符串看似相对就通过。
4. remote shell 的解释器绑定及首次写入锚点：确认实际目标环境和隔离根，缺口按最小范围补齐，不绕过权限。
5. 团队运行支持文件及根注册副作用：列出 Mac QA 的实际运行依赖，验证无源执行及重复安装；其他岗位随后扩展。

这些项决定远程制品能否开放，应在承诺 Beta 支持前给出原型证据。当前没有工期测量依据，不给出精确天数或代码量预测。
