# 面向 Agent 的团队 CLI、Skill 与文档精简梳理

> 已批准快照：Human `u_cd48b68b03b2452b94544af72a15be1e` 要求落地；本快照保存原提案内容（其中待评审/分期措辞为历史），实施以本期最新指示和交付记录为准。源dev-2/docs同名文件摘要 `6d490a263d7634f981357d4936f83dad71201ee64080ec8507a71fec059c7d47`。

- 状态：待评审（梳理清单 + 精简方案，未修改任何文件）
- 日期：2026-11-11
- 范围：内置 Skill `genehub-team`（`apps/daemon/builtin-skills/genehub-team/`）与团队样板 Skill
  （`apps/daemon/builtin-skills/genehub/references/team-template/skills/genet_builtin/`），以及样板入口 `tools/run.py`。
  内置 `genehub` Skill（127 行）及其 `multi-machine.md`（170 行）只做了规模统计，没有逐条审查，列为下一步。
- 依据版本：`worktrees/dev-2/genethub` 当前 `dev-2` 分支（dev.25）。下文路径省略公共前缀：
  `T/` = `team-template/skills/genet_builtin/`，`B/` = `builtin-skills/genehub-team/`

## 摘要

1. **用户体验影响**：团队 Agent 每次开会话都要先读 team-core，再按需读 6 份参考文档。这些文档对"该用
   `task` 还是 `spawn`"给出了相互矛盾的指引，还混着一次性迁移说明和游戏项目示例。今天 25 个 dev 版本里，
   两队多次自行合并模板、维护规避补丁，HY 还遇到过一次三方合并冲突。理解和合并的成本直接消耗团队的
   轮次和 Token。
2. **解决办法**：按"一条规则只有一个出处"重写：Skill 里只保留现行合同，迁移和历史说明移到带版本号的
   升级说明，旧命令从日常入口隐藏；把会影响团队行为的版本和内部修复分开发布；加一个文档检查，防止矛盾和
   过期写法回流。
3. **防止复发**：用全新 Agent 执行一组代表性任务来验收（见"验收"），并在测试里加入文档检查。

## 一、规模

| 对象 | 现状 |
| --- | --- |
| 样板 Skill（5 个 SKILL.md） | 合计约 19 KB。`team-core` 只有 38 行，但单行常超过 500 字，"≤40 行"的限制形同虚设 |
| 样板参考文档 | 9 份，约 480 行（`remote-targets.md` 85 行、`extensions.md` 87 行、`rationale.md` 157 行） |
| 内置 `genehub-team` | SKILL 52 行，加 3 份参考文档 209 行 |
| `tools/run.py` | 28 个顶层命令；`task` 下 10 个子命令。Agent 日常只需要 `task start/support/send/status/finish`、`note`、`temp`、`publish` |
| 产品仓 `docs/` | 今天新增 17 份 `team-quality-live*-delivery-*.md` 交付记录 |

## 二、逻辑矛盾（会让 Agent 选错路径）

| 编号 | 矛盾 | 位置 | 处理 |
| --- | --- | --- | --- |
| C1 | **`spawn` 的地位**：team-core 说 `spawn/send` 只用于已存在的旧派单，但多处仍让新工作用 `spawn` | 正确：`T/team-core/SKILL.md` 第 7、20、25 行。冲突：`T/team-core/references/models.md` 第 5 行（用户指定档位时用 `spawn --tier Max`）；`resume-paused.md` 第 13 行（已释放的远端派单"通过正常 spawn 取得新工位"）；`remote-targets.md` 第 35、63、72 行（"新任务先 spawn"）；`B/references/template.md` 第 25、41 行把 `spawn` 当主命令 | 全部改为 `task start/support`（加 `--tier`/`--model`）；`spawn` 只在一份"旧派单收尾"说明里出现 |
| C2 | **接力模型的术语**：内置 template.md 仍描述"Leader → 小组长 → Worker、同批结果合并为一条 result、根节点组长看门狗"，现行合同是"前台选 Owner、结果回到精确请求会话、timer 对账" | `B/references/template.md` 第 41–44 行；对照 `T/team-core/references/task-owner.md` | 按 Task Owner 合同重写这一节；"看门狗"等旧词只在实现说明里保留 |
| C3 | **并发说法不一致，也没有目标**：team-front 说按预算和工位决定并发；team-work 说同 Space 可以并行；task-owner 说配置了 WORKTREE_DIR 就按固定工位串行；template.md 说一个目录同时只有一个写会话。没有任何一处给出并行目标，而评分有 R6（低于 2 为红线） | `T/team-front/SKILL.md` 第 12 行、`T/team-work/SKILL.md` 第 10 行、`task-owner.md` 第 18 行、`B/references/template.md` 第 45 行 | 只在 team-core 定义一次：可拆即并行、目标 5、最少 2，写目录互不重叠；其他位置改为链接（与《评分改进与有效并行提案》P1 一致） |
| C4 | **能否修改 `genet_builtin`**：team-core 说"必要时可修改并记录补丁"；team-reflect 说"尽量随平台整体升级"；extensions.md 说升级只替换 `genet_builtin`。今天两队都在 builtin 里打了规避补丁，升级时只能手工合并 | `T/team-core/SKILL.md` 第 7 行、`T/team-reflect/SKILL.md` 第 17 行、`extensions.md` 第 85 行 | 统一为：`genet_builtin` 不改，缺口走扩展点或 `feedback`；确需临时补丁时写进单独的补丁目录，由升级工具在合并前提示 |
| C5 | **行数限制与实际写法**：team-reflect 要求每个 SKILL.md ≤40 行，团队就把内容挤成超长单行 | `T/team-reflect/SKILL.md` 第 17 行 | 限制改为按字节（例如每个 SKILL ≤4 KB）加单行长度上限 |

## 三、过期内容（不再适用，却每次都被读入）

| 编号 | 内容 | 位置 | 处理 |
| --- | --- | --- | --- |
| E1 | 一次性迁移说明："已有团队升级时，在定义源合入本条及 `team.py` 的查询修复……旧版 `tools/team.py`……" | `T/team-core/SKILL.md` 第 31 行 | 移到 `upgrade.md`，按版本标注 |
| E2 | 旧脚本的分页迁移细节（`unboundedQueryDisabled` 处理），两处各写一遍 | `B/SKILL.md` 第 48–52 行、`T/team-core/SKILL.md` 第 32 行 | 新团队不需要，移到升级说明；Skill 只写"历史读取用分页" |
| E3 | 改名遗留：`--expert` 是 `--team` 旧名；`expert-*` 改名；Workflow（PM/Executor）退役说明 | `B/references/template.md` 第 37、67 行；`B/SKILL.md` 第 42 行 | 删除，或只留在升级说明里 |
| E4 | 相对版本的写法："本版仅支持同机……"、"本版不承诺自动修复"、"本版代码提交不会自动升级" | `task-owner.md` 第 14 行、`remote-targets.md` 第 77、80 行 | 改为写清当前能力边界；版本差异进入变更说明 |
| E5 | 游戏项目示例写进通用样板：`skill-lead`、`combat-lead`；看板固定展示"可玩版本"；内置"数值与玩法研究专家"岗位 | `T/team-reflect/SKILL.md` 第 15 行；`tools/genet_builtin/board.py`、`team.py` 第 2394 行附近 | 改成中性示例；看板与研究岗位文案按项目配置 |
| E6 | Timer 计时约定在三处重复，内容基本相同 | `B/SKILL.md` 第 44–46 行、`T/team-core/SKILL.md` 第 34 行、`T/team-front/SKILL.md` 第 21 行 | 只保留在 team-core（或 primitives.md），其他位置删除 |

核对过、不属于过期的：template.md 中"team-front 带 5 秒定时 hook"属实（`team-front/hooks/timer.genet.json`：`every: 5s`、`fixed-delay`）。

## 四、CLI 精简

现有命令都保留，只调整 Agent 能看到什么：

| 分层 | 命令 | 出现在哪里 |
| --- | --- | --- |
| 日常 | `task start/support/send/status/finish`、`task pause/resume/cancel`（前台）、`note`、`temp`、`publish`、`directory` | team-core 命令表 |
| 维护 | `employee`、`worktree`、`mount/unmount`、`sync-identity`、`snapshot`、`drift`、`feedback`、`quality`、`models`、`board` | team-reflect 或管理员参考 |
| 内部/兼容 | `spawn`、`send`、`receive`、`hook`、`tick`、`init`、`member`、`datas`、`path`、`reset`、`tell-user`、`reflect`、`notes` | 不进日常命令表；`spawn/send` 只在旧派单收尾说明中出现 |

`run.py --help` 默认只列日常命令，`--help --all` 再列全部。错误输出保持现在的"出了什么、现在状态、下一步"。

## 五、降低版本迭代带来的理解成本

1. **按影响面分开发布**：内核和采集器的内部修复随时发；改变团队行为或评分含义的改动，每小时最多合并发一次，
   附一段"对团队有什么变化"的说明（不超过 5 行）。
2. **模板版本号与变更说明**：样板带版本号；`upgrade.md` 按版本列出"需要团队做什么"，没有动作的版本只写一行。
3. **未修改的 builtin 自动升级**：团队没改过的 `genet_builtin` 文件直接替换，只有改过的才需要合并（配合 C4）。
4. **交付记录归档**：产品仓 `docs/` 中每版一份的交付记录合并为一份按版本追加的记录，避免在文档检索时被大量相似文件干扰。

## 六、防回流：文档检查

在测试工程中加一项静态检查，覆盖内置 Skill 与样板 Skill：

- 新流程文档中出现 `spawn` / `send --to` 作为新建工作的指引时报错，旧派单说明文件除外；
- 出现"本版"、`--expert`、`expert-*` 等过期写法时报错；
- 同一段规则（按归一化后的文本）在多个文件重复出现时报错；
- 单个 SKILL.md 超过字节上限，或单行超过长度上限时报错。

## 验收

- 文档检查在当前文本上能找出 C1、C5、E1–E4、E6 列出的位置；改写后通过。
- 用全新 Agent（未读过本提案）在测试团队中完成以下任务，检查**最终账本和会话状态**，不只看命令轨迹：
  1. 用户指定"用 Max 档"开一个新任务：应产生 `task start --tier Max` 的任务账本记录，没有新的 `spawn` 派单；
  2. 恢复一条已释放的远端派单：应沿原任务编号恢复，不新建重复任务；
  3. 一个包含 3 个独立部分的目标：Owner 首轮应派出多项支持，各自绑定不同目录。
- 改写后样板 Skill 总字节数下降（目标 30% 以上，待实测），日常命令表不超过 10 行。

## 兼容与迁移

- 只改文字和 `--help` 展示，不删除命令，旧派单和旧脚本继续可用。
- 已建团队按现有升级流程合入；团队改过的 Skill 段落以团队版本为准，升级说明中标出冲突段落。

## 未决问题

- 内置 `genehub` Skill 和 `multi-machine.md` 尚未逐条审查，需要同样的梳理。
- 修改团队可见的 Skill 文本属于"改变团队行为"的版本，需要在本轮实验截止前确认发布时机，避免影响评分窗口内的团队理解。
