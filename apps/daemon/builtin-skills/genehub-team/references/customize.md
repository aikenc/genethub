# 定制与重写团队

**内置团队是样板，不是平台内置能力。** 平台只提供 Space、会话、定时器、CLI 这些原语（见 [primitives.md](primitives.md)）；
`genehub/references/team-template/` 是一份可直接复制、改写、甚至整体替换的样板。团队一旦建出来，
就是用户自己磁盘上的一棵 Space 树加一个 git 仓库，不属于产品代码。

## 哪些东西可以改

| 想改的 | 位置 | 生效方式 |
|---|---|---|
| 团队目标与铁律 | `soul.md`、`memory.md`（全局经验，≤30 行） | `run.py sync-identity` |
| 岗位职责与风格 | `front/role.md`、`front/style.md`、`spaces/<岗位>/role.md`、`style.md`、`index.md` | 同上 |
| 团队自己的 Skill | `skills/<业务目录>/<skill>/`，在描述符登记 Provider；内置 `skills/genet_builtin/team-*` 可作有记录的修改 | 同上；新会话读取 |
| 业务流程、资源、反思、看板与命令 | 描述符 `team` 块选 Class；业务子类放 `tools/<业务模块>/`，继承 `genet_builtin.api` | 统一由 `tools/run.py` 装配；完整构建与校验后安装 |
| 成员与层级 | `run.py employee add` / `retire`；或手写 `spaces/<名>/` 并改 `agent-space.genet.json` 的 `children.scanDepth` | 前者自动建子空间；后者要 build |
| 生成物 | `AGENTS.md`、`.agents/skills/*`、`.genethub/hooks/*` | 不要手改；`spacebuilder verify` 会报 `SB017` |

业务扩展首先读 [公开 Class 接口](../../genehub/references/team-template/skills/genet_builtin/team-core/references/extensions.md)。优先配置与子类，不复制内置调度器；`tools/genet_builtin/` 和 `skills/genet_builtin/` 提示内置维护范围，但不禁止有意修改。

## 改完怎么落地

普通 Agent 会话可以在团队唯一定义源修改；若使用独立运行制品，先在源构建完整输出并校验，再安装到运行目录，保留状态与回执。运行副本不初始化 Git，也不直接 snapshot。源码团队改完按顺序落地：

1. `run.py sync-identity` 编译并校验全队空间描述与身份文件；不通过就 `git checkout` 回退。
2. `run.py snapshot -m "改了什么"` 提交团队根仓库。
3. 已在运行的会话读的是旧身份，重开会话才生效。
4. 团队自己维护了测试就一起跑。

## 加岗位、减岗位

- 加：`run.py employee add <名> --desc "职责" [--role <md 文件>] [--repo <主仓>]`，建子空间；能定位到
  团队业务仓时顺手切工位，`--no-worktree` 可关闭。
- 减：`run.py employee retire <名>` 解除工位绑定转待岗；子空间目录与会话记录保留，不销毁证据。

## 整体重写

两条路，按需要的自由度选：

1. **保留团队运行时**：把 `team-template/` 复制到 `<数据目录>/spaces/<新名字>/`，改
   `agent-space.genet.json`（`name`、`description`、`agents`、`skills`、`identity`、`children.scanDepth`）
   和 `skills/`，再 `sync-identity` + `snapshot`。派单、看板、模板升级链都还在。
2. **只要一棵自己的 Space 树**：自己写 `agent-space.genet.json` 与 Skill，放在
   `<数据目录>/spaces/<名字>/`，用 `spacebuilder.py build <目录>` 生成 Agent 实际读的文件。
   这时没有 `team.py`，派单、看板、模板升级要自己实现或者不要；能依赖的平台能力见 [primitives.md](primitives.md)，
   字段与构建规则见内置 Skill 目录下的 `genehub/references/spacebuilder.md`。

daemon 从 `<数据目录>/spaces/` 发现 Space，两条路的产物都放在那里才会被注册。团队本身是一个 git 仓库，可以分享：
别人 clone 到自己的 `<数据目录>/spaces/<名字>/` 下运行 `run.py sync-identity`，就成了他自己的团队。

## 与平台模板的关系

- 团队初始化时把模板记进 `platform` 分支；`run.py drift` 看团队自定义与模板的差异。
- 平台模板更新不会自动覆盖团队：定时任务给反思会话留升级留言，按
  `genehub/references/team-template/skills/genet_builtin/team-reflect/references/upgrade.md` 三方合并。
- `run.py reset` 会覆盖平台文件与 `soul.md`，只在用户明确要求时用，并且先看预演。

## 不要改的

- daemon 行为与平台内置 Skill：重装会覆盖，团队只在模板副本上改。
- `.spacebuilder/` 的锁与生成文件：改源文件再 build，不绕过 `SB017`。
