# 固定远端岗位接单

用于把会话放在另一台机器执行；只在原会话用远端 shell 工具时不需要这套派单。

## 一次性配置：一个岗位只属于一台机器

岗位放到哪台机器，只看该岗位自己的 `spaces/<岗位>/.genethub/open.env`：

```text
TEAM_MACHINE=<genet machine list 返回的精确机器 ID>
```

没有这一行的岗位在定义源本机执行。团队根 `.genethub/open.env` 写 `TEAM_MACHINE` 会被拒绝；值为空也拒绝。
写好后在唯一定义源运行一次：

```text
run.py employee sync
```

sync 构建完整独立 Team 输出（临时目录，用完删除），按机器分组，每台目标机传输一次、在目标机
`~/.genehub-teams/<源 Team 标识>` 解包、纯产物校验、只登记声明到这台机器的岗位，并把真实引用写回定义源
`agent-space.genet.json` 的 `members`。运行目录由平台决定，不需要也不允许 Agent 手写目标路径、安装脚本、
workspace ID、Python 路径或返回 JSON；`members` 是 sync 的输出，不是配置项。改机器就改 `TEAM_MACHINE`
后重新 sync：新机器登记、源端绑定改指新机器；旧机器若仍托管本团队其他岗位，sync 顺带移除该岗位的登记，
否则在输出 `retained` 中列出，确认那里没有在途任务后再移除（文件和历史都保留）。删掉 `TEAM_MACHINE` 后 sync 即回到本机。
同一台目标机上不同源 Team 自动落在不同目录。远端不执行 build、不带作者 Provider／Skill 源，不启动前台或 Timer。

目标机第一次安装时若有多个可用 Agent，sync 会报出目标机 `.genethub/open.env` 的确切路径；在那台机器写一次
`TEAM_AGENT=<Agent ID>` 后重跑 sync。岗位的同名文件可覆盖它并指定 `WORKTREE_DIR`。模型来自目标机
`TEAM_MODEL_WORK/RESEARCH` 或 Agent 默认；派单方隐式配置不传过去。`--tier/--model/--media` 均在目标机校验，
缺配置或能力不明就拒绝。`employee ls` 的「机器」列显示每个岗位的归属和是否已安装。

硬约束（脚本强制，不靠约定）：

- 声明了 `TEAM_MACHINE` 的岗位，`task start`、`spawn`、`send --to <岗位>` 都自动派到那台机器；`--machine` 指向别的机器直接拒绝，不能临时改派。
- 声明了但还没 sync 到那台机器，派单拒绝并提示先 sync，不会退回本机执行。
- 目标机只接安装回执中登记的岗位；未安装到这台机器的岗位请求直接拒绝。
- 已有目录归属冲突、在途／未知任务会阻止替换；先收尾再 sync，不删锁重派。

接单进程使用目标 daemon 绑定的 `GENEHUB_CLI`；缺少绑定时直接失败，不猜另一个安装或渠道。

### 旧团队迁移

旧团队的手写 `members`、`.genethub/remote-targets.json`、根描述里调用 `tools/install_remote.py` 的 build post，
以及自写的 install/deploy 脚本都属于旧机制。没有 `TEAM_MACHINE` 的岗位仍按旧绑定兼容运行并提示迁移。
迁移步骤：收尾旧绑定上的在途派单；删除根描述中 install_remote 的 build post（sync 发现它会拒绝）；
给每个远端岗位写 `TEAM_MACHINE`；运行 `employee sync`；确认 `employee ls` 显示已安装、新任务真实接单回传后，
再停用旧运行目录的 workspace 登记，删除自写脚本。迁移不改未完成派单的原回执。

## 派单和投递

```text
run.py task start --space qa --request-id review-42 --desc "验收变更" "目标与验收标准"
run.py task send <返回的任务> --request-id add-42 "补充要求"
```

无需指定机器：岗位的 `TEAM_MACHINE` 决定目标；源机无需登记同名执行 workspace，但岗位定义仍留在源机。原创建意图固定目标，改 `TEAM_MACHINE` 并 sync 不移动在途任务。`spawn/send --machine` 只兼容旧绑定；对声明了机器的岗位，它必须与声明一致。

接单先验证 workspace 的真实根目录属于该脚本所在团队的指定岗位，再用现有 `genet-writer.json` 的文件排他创建拿写锁。
工作岗位锁自己的 WORKTREE_DIR，未配置则锁岗位根；research 是只读任务不拿写锁。其他会话/机器派单遇到同一目录锁直接报忙。
本机派单也不能抢走远端锁或未知创建结果的保留锁。协作锁只约束使用团队工具的写者，不限制任意 shell 或恶意会话。

`send` 只补充本团队 pending 中仍持有效回执的会话，且由执行端在同一接单锁内投递；完成释放后的旧会话拒绝投递，新任务先 spawn。零个先 spawn，多个用精确 session ID。系统通知保留用户暂停。用户明确要求继续时，前台/组长可按 [用户明确要求继续](../SKILL.md#用户明确要求继续) 用自己署名的普通消息恢复原会话；不能把通知伪装成 Human 输入或自动解除暂停。
跨机 `--dir/--worktree` 不可用，`--workspace` 必须等于配置绑定，不是临时覆盖。
使用精确会话 ID 时也校验 `--workspace`。显式空 workspace/machine/request-id 都拒绝；空 machine 不会退成本机执行，空 request-id 不会被当成一次新任务生成编号。

## 回执与故障恢复

派单方在 `.genethub/team/dispatch/` 保存意图；执行端在岗位 `.genethub/team/dispatch/` 保存创建回执。
回执和写锁是执行端本机文件；没有分布式锁服务、自动排队或机器级重派。平台记录为脚本输入，原发起方标在任务正文及回执中，不能当作 Human 的直接批准。

- 同编号、同内容重试只取原回执；不同内容拒绝。省略编号时每次 spawn 都生成并提前输出新编号，同正文的新任务也不会复用旧结果；失败后须用输出的 --request-id 查询原派单，不能省略编号盲重派。
- 创建前保存 unknown；收到 sessionId 后更新回执。丢回复后用同编号重试；执行端已有 sessionId 就返回同一个会话。
- 执行端仍为 unknown 时禁止重建。管理员先按目标 workspace、标题、系统消息与时间核对实际会话，恢复原回执；确认从未创建才能解除保留状态。禁止删锁、换编号碰运气。
- 写锁由发起方完成对账后请求执行端释放，必须匹配原编号与 sessionId，且会话已终止、没有待处理输入和用户暂停，最新回复 ID 与发起方的结果快照一致；期间收到新回复就保留待办重新对账。由本派单明确超时取消或内核记录本轮失败的终态可释放写锁，保留原暂停标志；不得通过普通通知解除暂停。释放失败待办仍保留；一条失败不阻塞其他独立任务。
- 暂停会话保留锁。原始创建响应丢失且发起方永久丢账、执行端磁盘损坏或管理员强制关机时，需要上述人工核对；本版不承诺自动修复。
- 不同机器之间不做 lease 到期抢锁。回执长期保留用于去重；确认任务不再重试后才能人工归档，不能在不明确保留期的情况下自动清除。

升级团队脚本与配置后重开会话读取新 Skill；本版代码提交不会自动升级已运行的用户团队。
## 定义与运行绑定

新增岗位定义在唯一维护源完成，`employee sync` 把制品部署到执行机；执行副本的 `employee add` 会在写入前拒绝。已部署岗位的 `worktree bind` 和待岗操作只更新本机 `.genethub/open.env`，不改生成描述、不触发编译。需要新增岗位或调整编辑器 folders 时先联系当前溯源中的定义源负责人；不能为使派单继续而在远端补写 Provider、源描述或生成指令。
