# dev-2 承接"驱动团队并持续改进"的落地准备提案

- **主题**：让 `dev-2` 真正能承接"在槽位 dev-2 驱动团队 A、B 完成远期目标，持续跟进改进工作质量，预算 N 天"。补齐两份上游提案没有覆盖的落地前提：dev 版本覆盖两台机器、观察者的唤醒与身份、把 XWorld 两队从 Beta 迁到 dev-2。
- **状态**：待评审。本文只是提案，没有修改产品代码、槽位配置、Mac 上的 dev-2 实例或任何团队。
- **日期**：2026-11-10（北京时间）
- **适用范围**：`spaces/dev-2` 与 `worktrees/dev-2`，Mac mini 上的隔离 dev-2 实例，Beta 渠道本机的 XWorld 两队（只读来源）。
- **事实基线**（11-10 12:20 至 12:40 实测）：产品仓 `genethub` 在槽位分支 `dev-2`，与 `origin/main` 同为 `2beda9ed`，有一个未跟踪的测试文件；`genethub-cloud` 为 `e7dd53e`，与主干一致。槽位以 parity 车道运行，安装与构建一致，从未发布 Live。
- **上游提案**：[团队工作质量的可量化评估提案](team-work-quality-evaluation-proposal-20261110.md)（下称"评估提案"）与 [平台开发侧的团队观察与改进 Skill 提案](team-quality-iteration-skill-proposal-20261110.md)（下称"观察者提案"）。两份目前放在 `release-beta/docs`，建议随本提案移到 `dev-2/docs`（第 9 节 F1）。
- **分层**：术语见 [分层模型](team-platform-layer-model-20261110.md)。本文全部工作属于平台开发层；XWorld 迁移中由团队完成的步骤（样板采用、补丁改扩展类）属于团队自管理层。
- **来源**：用户要求 `u_99accf46623c4d9e8805ef14f4849503`、`u_58fa6f28628f4810beb2cb2aa5a1f74e`、`u_018f41a275c64b828d3607ac81a7a10f`（第 5.7 节：dev 发布对 Beta/Stable 的影响）。

## 先回答三个问题

1. **现在的影响是什么。** 今天按观察者提案下达"驱动团队 2 天"，前三步做得到：核对槽位、读团队、下达目标。但修复交付不出去：dev-2 从没发过 Live；即使发了，Mac 上的 dev-2 实例跑的是从 Beta 复制的发布版宿主，收不到 Live；宿主和 CLI 的修复也到不了 Mac。远端岗位（qa、map-integrator）因此测不到新版本。另外 dev-2 上没有能运行的 XWorld 团队，只有一份只读的历史副本。
2. **怎么解决。** 分四块补齐：
   - Mac 改为运行本槽构建的 dev 版本，Live 发布后自动推到 Mac，并核对版本。
   - 定下观察者的心跳唤醒方式，以及操作槽位 daemon 时用的身份。
   - 把 Beta 的 XWorld 迁成 `XWorld-ds`（DeepSeek 为主）和 `XWorld-hy`（Hy4 为主）两支可运行的 dev 团队。
   - 把以上全部写成观察者的可执行准备核对。

   进度：
   - **已完成**：本次只读核查与本提案。
   - **待实施**：第 5 节全部。
   - **待验证**：第一次 Live 能否在本槽成功；Mac 经本地 TLS 桥能否取到 Live 制品；新 guest 与 Mac 现有宿主的 ABI 是否兼容。
3. **怎么防止问题复发。** 准备核对改成脚本，以下情况直接判为未就绪，不下达目标：
   - 任一机器的 guest 摘要与本槽 Live 或安装不一致。
   - 团队里还留着 Beta Hub 的机器编号。
   - 两支团队会向同一仓库的同名分支推送。
   - 远端岗位没有安装回执。

   每次 Live 之后自动复跑一遍，结果写进观察者的运行记录。

## 1. 摘要与建议

| 前提 | 现状 | 建议 |
| --- | --- | --- |
| 本机 Live | 能力存在，dev-2 从未用过 | 以一次空改动的 Live 做首发验证（第 5.1 节） |
| Mac 跟随 dev 版本 | 发布版宿主编译时去掉了清单地址覆盖，收不到 Live | S0 用脚本推送 guest 并重启；S1 评估在 Mac 上构建 `iterate` 宿主（第 5.2 节） |
| 宿主、CLI 修复到 Mac | 槽位只构建 Linux 版本 | 与上一项合并解决；未解决前，宿主类修复只在本机验收，并在汇报里注明 |
| 心跳唤醒 | 没有会话级定时原语 | 沿用观察者提案 E3：槽位调度器加 `session send`（第 5.3 节） |
| 观察者身份 | 当前会话的身份被槽位 daemon 拒绝（401） | 固定一个"以槽位用户身份操作"的包装命令（第 5.4 节） |
| XWorld 两队 | 只在 Beta；dev-2 只有只读历史副本 | 从 Beta 主队迁出两支，只改模型和名字；Beta 两队暂停（第 5.5 节） |

## 2. 背景与用户场景

用户的典型输入："在槽位 dev-2 驱动团队 XWorld-ds 完成修仙游戏的地图切片，XWorld-hy 在叙事方面做到产品级表现，你不断跟进和改进团队工作质量，预算 2 天。"

**改前**：观察者核对后发现，dev-2 上没有这两支团队，于是问用户。团队到位后，第 3 小时发现一个样板结算问题，修好后发了 Live：本机 daemon 切到了新版本，Mac 上的 qa、map-integrator 还在跑旧 guest。复验时，本机岗位好转，远端岗位不变，观察者分不清是修复无效还是没被采用。

**改后**：

1. 准备核对一次列出机器版本、远端岗位安装、模型、分支前缀和样板版本，全部通过才下达目标。
2. Live 发布后，推送脚本把同一 guest 推到 Mac，比对摘要后重启 Mac 实例。
3. 观察者用 `daemon status` 确认两台机器的 `daemonVersion` 相同，再开始复验。

## 3. 现状与证据

### 3.1 槽位与本机

`devctl.sh status` 输出：lane `parity`，supervisor running，`up to date: yes`，`live:` 为空。各槽的 `.dev-runtime/live/artifacts` 都是空的，说明 Live 在任何槽位都还没实际用过。`devctl.sh live` 要求源码已提交、已按 HEAD 构建；槽位里有一个未跟踪文件 `testing/specialties/daemon/cold-session-contention.specialty.ts`，会不会被判为不干净尚未验证。

### 3.2 两台机器

槽位 CLI 的 `machine list` 返回两台机器，都在线：

```json
[{"machineId":"mch_g5f_XdUWqiwf","name":"GeneHub dev-2","local":true,"online":true},
 {"machineId":"mch_ZPK9UJkCq-Q5","name":"Mac mini · dev-2","local":false,"online":true}]
```

Mac 实例由 launchd 任务 `com.genethub.dev2.multimachine` 托管，入口包装脚本 `~/GeneHub/dev-2-multimachine/bin/genet-dev-2`：

- 宿主是 `genehub-host-beta`，CLI 是 `genet-beta`，版本 `0.19.0-beta.3`，都是从 Beta 复制的发布版。
- guest 由 `--component …/genehub_guest-beta.wasm` 固定。摘要 `864bbad6…`，本槽安装的 guest 是 `caa1b2c5…`，两者不同。
- 数据目录 `config.json` 的 `updateManifestUrl` 指向 GitHub 上的 `latest-dev.json`，与本槽 Live 无关。
- 这个 guest 没有签名：用该宿主的 `inspect` 检查，返回 `artifact has no signed metadata section`。它能运行，是因为 `--component` 指定的本地文件不验签。
- 该实例的组件存储 `data/component/` 里目前没有已激活的签名组件，`highest-version` 为 `0.19.0-beta.3`。但宿主的更新源是编译时固定的 Beta 清单地址：只要这个实例经更新流程激活过 Beta 的 Live 组件，激活的组件就会压过 `--component` 指定的文件（`apps/host/src/load.rs` 的 `load_component`），而 Mac 上的 dev-2 会悄悄变成 Beta guest。

### 3.3 Live 为什么到不了 Mac

发布版宿主在编译时去掉了清单地址覆盖：

```text
apps/host/src/update.rs:79  fn manifest_urls()
  #[cfg(debug_assertions)] 才读取 GENEHUB_COMPONENT_MANIFEST_URL
  注释："The variable is compiled out of release builds, where a pre-settable update URL would be a back door."
```

本机能收到 Live，是因为槽位用 `iterate` profile 构建，这个 profile 保留了调试断言。Mac 上是 Beta 发布版宿主，所以即使配置了地址也不会被读取。

### 3.4 什么修复能走 Live

- 内置 Skill 和团队样板编在 `genet-daemon` crate 里（`apps/daemon/build_support.rs` 用 `include_bytes!` 嵌入 `builtin-skills/`），而这个 crate 被 `apps/guest` 依赖，所以它们随 guest 分发，可以走 Live。
- 宿主、CLI、Python 运行时的修复不能走 Live，需要重新安装；Mac 上目前做不到。

### 3.5 观察者身份

在当前会话里直接调用槽位 CLI（设好 `GENEHUB_DEV_DATA_DIR`）会返回 `401 Unauthorized`："the local daemon refused this Session's CLI identity"。原因是当前会话带着主 Hub 的 `GENEHUB_SESSION_ID` 和 `GENEHUB_CONTROLLER_TOKEN`。去掉这两个变量后，`machine list` 正常返回。Mac 的包装脚本也是这样做的。

### 3.6 XWorld 两队

| 项目 | 主队 `xworld` | 实验队 `xworld-exp5a` |
| --- | --- | --- |
| 位置 | `/root/.local/share/GeneHub-beta/spaces/xworld` | `…/spaces/xworld-exp5a` |
| 团队定义仓 | `main`，origin 为 GitHub `aikenc/team-games`，`.git` 44M，工作区干净 | `main`，origin 为本机裸仓 `/root/exp-remotes/xworld-exp5a/team.git`，`.git` 41M |
| 总体积 | 239G，其中 `worktrees/` 215G（272 个 `games.git` 工作树），`spaces/` 14G，`temp/` 17G，`datas/` 8G | 228G，结构相同 |
| 岗位 | front、map、map-terrain、map-props、map-integrator、actor、pcg、splat、stream、qa、research、release、team-reflect | 相同 |
| 模型（`.genethub/open.env`） | 执行与研究 `codebuddy`/`deepseek-v4.1-flash`；反思 `codex`/`gpt-6.1-sol` | 相同 |
| 最近 48 小时会话 | DeepSeek 205，Sol 141，hy4std 0 | DeepSeek 248，Sol 139，hy4std 2 |
| 远端岗位 | qa、map-integrator：`TEAM_MACHINE=mch_LlDArLOhiG3E`（Beta Hub 里的 Mac） | 相同 |

两点会改变迁移做法：

- **两队今天都以 DeepSeek 为主。** 11-07 用户说过"全部切吧，hy 太浪费时间了"（`docs/team-goals.md` 第 110 行），之后两队的执行和研究岗位都从 `hy4std` 改成了 `deepseek-v4.1-flash`。所以"Beta 按模型区分"已经不成立，`XWorld-hy` 需要显式改回 `hy4std`。
- **两队都改过样板内部脚本。** `tools/genet_builtin/team.py` 为反思单独选模型打过补丁，`tasks.py` 加过过程事件补丁，安装器加过 `retain_archive` 补丁。迁移时如果直接带过去，观察者以后每次发布样板修复，两队都要三方合并。

dev-2 现有的"XWorld · Beta历史体验"由 `reports/create-xworld-history-copy.py` 生成，会话全部标为 `historyOnly`，不复制定时器和任务台账，只能看、不能跑。

## 4. 目标与范围

| 目标 | 成功的样子 |
| --- | --- |
| H1 本机 Live 可用 | 一次 `devctl.sh live` 成功，`daemon status` 的 `daemonVersion` 为 `0.0.1-dev.1`，`devctl.sh identity` 通过 |
| H2 Mac 跟随 | 每次 Live 后 10 分钟内，Mac 实例的 guest 摘要与本机相同、`daemonVersion` 相同；不一致时准备核对失败 |
| H3 观察者可唤醒 | 24 小时内心跳无静默缺口；重复投递被稳定消息编号去重 |
| H4 观察者可操作槽位 | 一条固定命令能以槽位用户身份读写，不需要每次手工去掉变量 |
| H5 两支 dev 团队可运行 | `XWorld-ds` 和 `XWorld-hy` 在 dev-2 工作台可见；前台可对话；各完成一单真实任务：远端 qa 在 Mac 上接单、回传、结算 |
| H6 不互相干扰 | Beta 两队在迁移后不再推送；dev 两队的推送都落在各自的分支前缀下 |

**本期不做**：

- 不迁 tikistar（UE 项目，体积过大）。
- 不迁 Beta 的会话正文、在途任务、锁和定时器。
- 不改 Beta 渠道的安装。
- 不实现评估提案的 P1，也不编写观察者 Skill 本身。

## 5. 具体方案

### 5.1 本机 Live 首发验证

1. 提交一个不改行为的候选（例如 guest 里一处版本注释），按 `genethub-modify-review` 封印后提交，`devctl.sh build`。
2. `devctl.sh live`，观察 `status` 的 `live:` 行和 `daemon status`。
3. 记录所需时间、团队会话是否被打断、`reset live` 能否回退。
4. 结论写回 `genethub-dev-development` 的 SKILL.md：未跟踪文件是否阻断 Live，Live 期间会话是否保持。

### 5.2 Mac 跟随 dev 版本

**S0：推送脚本**（新增 `spaces/dev-2/reports/push-mac-guest.mjs` 之类的 Space 本地脚本，不是产品接口）：

1. `devctl.sh live` 成功后，取本槽 Live 制品里的 guest 路径和 sha256。
2. 由 Mac 执行 `genet file download --from mch_g5f_XdUWqiwf <guest 路径> ~/GeneHub/dev-2-multimachine/bin/genehub_guest-<sha8>.wasm`，以接收方 `completed` 和 sha256 为准。
3. 保留上一版为 `genehub_guest.previous-<sha8>.wasm`，原子替换包装脚本引用的文件，`launchctl kickstart -k` 重启 Mac 实例。
4. 读 Mac 的 `daemon status` 和 guest 摘要，写入观察者运行记录的 `devVersions[].adoption`。

代价：每次重启 Mac 实例都会打断远端岗位上的在途会话。所以推送与本机 Live 合批，选在远端岗位没有在途关键操作的时刻；重启后检查团队能否自行恢复，这本身也算一次自愈测试。

**S1：在 Mac 上构建 dev 宿主**（待评审）：Mac 上装 Rust，检出本槽分支，用 `iterate` profile 构建 macOS 版的宿主和 CLI。因为保留调试断言，可以设置 `GENEHUB_COMPONENT_MANIFEST_URL` 指向本槽 Live 地址，自动接收 Live，宿主和 CLI 的修复也能到 Mac。前提是验证：Mac 经本地 TLS 桥访问 `https://<域名>/relay-dev-2/artifacts/*` 能拿到制品。需要按 `macos-pitfalls.md` 用稳定证书签名，否则每次换版本都要重新授权。

**不建议**：改产品，让发布版宿主也接受清单地址覆盖。源码注释已明确把它视为后门。

**ABI 兼容**：S0 之前先确认本槽 guest 能被 Mac 现有的 `0.19.0-beta.3` 宿主加载（`stamp-genehub-abi.mjs` 管理的 ABI 标记）。不兼容时只能走 S1，或者先从当前 Beta 复制一份更新的宿主。

### 5.3 心跳唤醒

沿用观察者提案的 E3：由 supervisor 托管槽位里的一个小调度器，按 `obs-<任务>-tick-<序号>` 向观察者会话发送 `session send --message-id`。观察者会话在主 Hub 上，所以调度器用主 Hub 的 CLI `/root/.local/bin/genet` 发送，不用槽位 CLI。实施前验证两件事：重复投递是否被去重；会话正忙时的消息会排队还是被拒。

### 5.4 观察者身份

新增 Space 本地包装命令 `spaces/dev-2/reports/slot-genet.sh`：去掉 `GENEHUB_SESSION_ID` 和 `GENEHUB_CONTROLLER_TOKEN`，设置 `GENEHUB_DEV_DATA_DIR=<槽位>/.dev-runtime/data/daemon`，再执行 `.dev-runtime/install/bin/genet-dev "$@"`。观察者给团队发消息、读会话都走这条命令。这样它在槽位 daemon 上的身份是本机所有者，和工作台上的用户一致。

"当前会话的 CLI 不能直接操作另一个槽位"本身就是平台摩擦，按观察者提案第 5.6 节登记为平台接口问题。

### 5.5 XWorld 迁移

**来源与命名**（推荐方案，待评审）：两队都从 Beta 主队 `xworld` 迁出，只在名字和模型上有差别，这样两队的比较只有模型一个变量。

| dev 团队 | 显示名 | 执行与研究模型 | 反思模型 |
| --- | --- | --- | --- |
| `xworld-ds` | XWorld-ds | `codebuddy`/`deepseek-v4.1-flash` | `codex`/`gpt-6.1-sol` |
| `xworld-hy` | XWorld-hy | `codebuddy`/`hy4std` | `codex`/`gpt-6.1-sol` |

实施前在 dev-2 上确认 `hy4std` 和 `deepseek-v4.1-flash` 都已配置并能连通（槽位从 Beta 播种过 provider，但未逐个核对）。

**迁移步骤**：

1. **冻结来源。** 经 Beta 前台以用户身份请两队暂停，确认没有在途派单和写锁；记录主队定义仓 HEAD 和 `games.git` 各分支 HEAD。
2. **建团队目录。** 在槽位的工作区目录下，从 `team-games` 克隆定义仓到 `xworld-ds/` 和 `xworld-hy/`，各开一个分支 `dev2/xworld-ds`、`dev2/xworld-hy`。改 `agent-space.genet.json` 的 `name` 和 `description`，改根 `.genethub/open.env` 的模型。
3. **迁数据。** 只复制 `datas/board`、`datas/quality`、`datas/releases` 和 `docs/`，以及 `memory.md`、`soul.md`；不复制 `.genethub/sessions`、任务台账、派单意图、在途回执、锁和定时器状态。需要回看历史时，用现有的历史副本。
4. **工作树。** 不复制 `worktrees/`。团队开工时从 `games.git` 按需新建，分支前缀为 `dev2-ds/` 和 `dev2-hy/`，与 Beta 的分支隔开。
5. **样板升级。** 用槽位当前样板升级两队，由团队反思岗位按升级提醒合入；把 `team.py`、`tasks.py` 和安装器上的补丁逐条判断：能用扩展类表达的改为扩展类，不能的登记为样板缺口，进入观察者的"样板公共脚本"路线。这一步属于团队准备，但它决定了后续样板修复能否少冲突。
6. **远端岗位。** 两队的 qa、map-integrator 改为 `TEAM_MACHINE=mch_ZPK9UJkCq-Q5`；在 Mac 的 `~/GeneHub/dev-2-multimachine/projects` 下由官方 employee sync 安装岗位，按 Beta 的做法稀疏克隆 `games.git`（排除历史 contracts 下的大型 GLB/PNG）；以安装回执为准。
7. **登记与验收。** 在 dev-2 工作台加入两个团队，前台可对话；各派一单 qa 到 Mac，完成接单、`task finish` 回传、结算和释放资源，才算迁移完成。

**可选路径**：优先尝试产品的"共享工作流包 → 管理员克隆"（内置 `pm-project-bootstrap`），由 dev-2 的"GeneHub dev-2管理员"会话完成第 2、5、6 步。这样迁移本身也在测平台。走不通的步骤再用脚本，并把卡点登记为平台问题。

**磁盘**：不复制工作树时每队约 10G；`/data` 剩余 391G，`/root` 剩余 1014G，足够。

### 5.6 准备核对脚本

观察者提案第 5.3 节的清单增加以下各项，落在观察者 Skill 的 `observer.py ready` 中，每项都输出实测值：

| 项目 | 判定 |
| --- | --- |
| 机器版本一致 | 每台机器的 `daemonVersion` 与 guest 摘要等于本槽 Live；没有 Live 时等于本槽安装 |
| 远端岗位安装 | 每个 `TEAM_MACHINE` 都是本槽 Hub 的机器编号，且有安装回执 |
| 无 Beta 残留 | 团队目录里没有 Beta Hub 的机器编号，没有指向 `GeneHub-beta` 的路径 |
| 分支隔离 | 各队的工作树分支前缀互不相同，也不同于 Beta 的活动分支 |
| 模型可用 | 各队 `open.env` 里的模型在本槽 provider 里存在，且最近一次连通测试通过 |

### 5.7 dev 发布对 Beta/Stable 的影响，以及 dev 自己的门禁

dev 不走 GitHub CI。这里的"CI"指从改动到被机器运行的整条交付链：测试门禁、审查封印、构建、签名、发布、分发和采用。`devctl.sh live` 不是新能力，代码已经在，只是从没用过。本提案新增的是三件事：在 dev-2 上经常使用 Live、把 guest 推到 Mac、可能在 Mac 上构建 dev 宿主。

**事实（源码核对，未实测）：**

- **签名根是公开的。** 所有渠道共用一个签名根，种子是写在源码里的 `[7; 32]`（`apps/host/src/keys.rs`："One self-contained signing root for every channel"）。所以签名只保证内容完整，不证明是谁发布的；任何能运行 `genehub-host pack` 的人都能签任何渠道。这是现状，dev Live 不会让它更糟。
- **渠道隔离靠两道检查。** 一是宿主编译时固定的清单地址：发布版没有 `GENEHUB_COMPONENT_MANIFEST_URL` 覆盖。二是宿主核对清单渠道和签名信封里的渠道：两者都必须等于宿主自己的渠道（`apps/host/src/update.rs` 第 238、276、325、541 行）。dev 签出的组件信封渠道是 `dev`，Beta 和 Stable 宿主会拒绝。
- **`devctl.sh live` 固定用 `--channel dev`。** 发布到本槽 `.dev-runtime/live/artifacts`，版本号是 `0.0.1-dev.N`；`publish-component.mjs` 按渠道持锁，按渠道使用独立的已盖章工作树，并且只有 dev 渠道允许回环 http。
- **发布代码是共用的。** dev Live 和 Beta 发布用的是同一份 `scripts/publish-component.mjs` 和 `genethub-cloud/publisher/*.mjs`。

**风险与对策：**

| 风险 | 影响谁 | 程度 | 对策 |
| --- | --- | --- | --- |
| 为了让 dev Live 跑通而改发布代码，改坏了 Beta 发布 | Beta 发布 | 中 | 发布代码的改动不进 dev Live 的快速通道：合入主干前，在 `release-beta` 用 `publish-component.mjs --plan --channel beta` 复核，并跑 Beta 发布相关专项 |
| 有人用 `--channel beta` 签出组件，它被 Beta 宿主接受 | Beta 用户 | 低（今天的流程就有这个风险） | 观察者 Skill 和推送脚本只允许 `--channel dev`；推送脚本只写 Mac 上 `dev-2-multimachine` 目录。签名根改用外部密钥属于 Stable 毕业的事项，本提案不处理 |
| Mac 上的 dev-2 实例经 Beta 更新流程激活 Beta Live，悄悄变成 Beta guest | 观察结论 | 中 | 准备核对比对正在运行的 guest 摘要，而不只看在线状态；R4 改用 Mac 上构建的 dev 宿主后，这条风险消失 |
| 推送脚本或重启误伤 Mac 上真实的 Beta/Stable | Beta/Stable 用户在 Mac 上的会话 | 中 | 只操作 launchd 任务 `com.genethub.dev2.multimachine`，路径白名单限定在 `~/GeneHub/dev-2-multimachine`；Mac 上构建宿主时按 `macos-pitfalls.md` 签名，不在已授权的 Beta 路径上运行未签名程序 |
| dev 与 Beta 的远端岗位抢同一台 Mac 的采集与 Blender | Beta XWorld 的远端岗位 | 中 | 按 F3 暂停 Beta 两队；不暂停时，在 dev 两队的远端岗位上限制并发 |
| 本机构建与 Beta 发布同时占用 CPU 和磁盘 | Beta 发布耗时 | 低 | Live 与 Beta 发布错开；`/data` 已用 77%，迁移不复制工作树 |
| 共享网关改动影响所有 dev 槽位 | 其他 dev 槽位 | 中（仅在需要改网关时） | 让 Mac 取 Live 制品优先走现有子路径；确需改网关时按 `gateway-stop` 的维护授权处理 |

**dev 版本到达 Beta/Stable 的唯一路径不变**：槽位分支 → 经 MR 合入主干（需人授权，GitHub CI 在这里把关）→ `release-beta` 和 `release-stable` 各自的发布流程。dev Live 不提供绕过这条路径的办法。

**dev 自己的门禁**（替代 GitHub CI）：每个 dev 版本都要满足以下条件才能发布：

1. 受影响范围的 testctl 门禁通过：明确范围的修复走 `dev-feedback`，跨模块走 `dev`（`testing/policies/gates.ts`）。
2. 按 `genethub-modify-review` 取得封印并提交；`publish-component.mjs --commit` 本身也要求双仓干净。
3. `devctl.sh build` 和 `identity` 通过，Live 发布后本机 `daemonVersion` 等于新版本。
4. Mac 推送后，guest 摘要与本机一致。

## 6. 取舍与替代方案

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| Mac 继续用 Beta 宿主，手工更新 guest | 仅作 S0 | 能立刻用，但每次都要重启，宿主修复也到不了 Mac |
| 发布版宿主开放清单地址覆盖 | 不采用 | 源码明确把它视为后门 |
| Mac 上构建 `iterate` 宿主 | S1 候选 | 能自动跟随，宿主修复也能到 Mac；代价是 Mac 要装工具链、要签名 |
| 整盘复制 Beta 团队（含工作树和会话） | 不采用 | 230G 级别；会续跑 Beta 旧任务和锁 |
| 只用现有历史副本 | 不采用 | 只读，不能运行 |
| ds、hy 分别来自主队和 5a | 备选 | 能保留两份不同的历史，但两队的差异就不只是模型 |
| Beta 两队继续运行，只靠分支前缀隔离 | 备选 | 同一个 `games.git` 有三方推送，Beta 的集成分支仍可能被 dev 合并影响 |

## 7. 分期、验收与交付

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| **R0** 本机 Live 与身份 | 第 5.1、5.4 节 | H1、H4；`reset live` 能回退 |
| **R1** Mac 跟随（S0） | 第 5.2 节 S0 脚本与 ABI 核对 | H2：连续两次 Live 后 Mac 都跟上；中断的远端会话能自行恢复，或者如实记录未恢复 |
| **R2** XWorld 迁移 | 第 5.5 节 | H5、H6 |
| **R3** 准备核对与心跳 | 第 5.3、5.6 节，并入观察者提案 S0 | H3；故意让 Mac 落后一个版本时，准备核对失败并列出缺项 |
| **R4** Mac 自动跟随（S1，可选） | 第 5.2 节 S1 | 不重启 launchd 也能接收 Live；签名保持，不触发重新授权 |

R0、R1 和 R2 可以并行推进。R3 依赖 R0 和 R1。没有测量依据，这里不给工期。

## 8. 兼容、迁移和恢复

- **Beta 两队**：只暂停、不删除。迁移失败时恢复 Beta 两队，dev 两队删除目录即可。
- **Mac 实例**：每次推送都保留上一版 guest；失败时改回旧文件并重启。不碰 Mac 上原有的 Beta 和 Stable。
- **Live**：`devctl.sh reset live` 回到安装包里的 guest，需要先停槽位。
- **现有历史副本**：保留，作为两队的历史参考。

## 9. 需要的决定

- **F1** 是否把两份上游提案移到 `dev-2/docs`，并以本文为第三份。
- **F2** 两支 dev 团队都从 Beta 主队迁出、只改模型（推荐），还是 ds 来自主队、hy 来自 5a。
- **F3** 迁移后 Beta 两队暂停（推荐）、继续运行并靠分支前缀隔离，还是停用只读。
- **F4** Mac 跟随方式：S0 推送脚本先行，S1 在 Mac 上构建 `iterate` 宿主是否立项。
- **F5** 迁移由 dev-2 管理员会话走产品路径（推荐先试），还是直接用脚本。
- **F6** 迁移和 Live 首发是否授权在 dev-2 立即执行；它们会改槽位运行状态，并重启 Mac 上的 dev-2 实例。
- **F7** 第 5.7 节的 dev 门禁是否作为观察者每次发布 dev 版本的硬条件；发布代码的改动是否一律先在 `release-beta` 用 `--plan` 复核。

## 10. 本次做了什么、没做什么

- **做了**：读了两份上游提案和 `genethub-dev-development` 的发布与真机说明；只读查看了槽位状态、两仓分支、Hub 机器列表、Mac 上 dev-2 实例的 launchd 配置、包装脚本和 guest 摘要（经主 Hub 的 `genet shell` 读取 Mac）；读了宿主更新源码和内置 Skill 的打包方式；统计了 Beta XWorld 两队的体积、模型配置和最近会话的模型分布。
- **第 2 次修订（13:10）**：新增第 5.7 节；第 3.2 节补充 Mac guest 未签名、Beta 更新源可能压过 dev guest 两项事实（只读检查 Mac 的组件存储与 `inspect` 结果）；改为引用分层模型。
- **没做**：没有发 Live、没有构建、没有改 Mac 实例、没有暂停或复制任何团队、没有向任何会话发消息。
- **未验证**：Live 能否在本槽成功；Mac 经 TLS 桥能否取到 Live 制品；新 guest 与 Mac 现有宿主的 ABI 兼容性；`hy4std` 在 dev-2 上是否可用；产品的工作流包克隆路径能否承接 XWorld。
