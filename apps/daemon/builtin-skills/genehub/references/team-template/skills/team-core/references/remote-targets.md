# 固定远端岗位接单

用于把会话放在另一台机器执行；只在原会话用远端 shell 工具时不需要这套派单。

## 一次性配置

启用新绑定前先停止旧版新派单，核对并收尾旧版未加锁的远端任务；不能把存量无锁会话当作已迁移。
目标机升级到带 receive 的团队模板，保留团队根描述、`tools/team.py`、`spaces/<岗位>` 与配置文件。
只注册需要的岗位 workspace；不需要注册根会话或启动前台、看板、hook。不能只部署一个 SpaceBuilder portable 制品：它不包含上述接单运行资源。

目标团队 `.genethub/open.env` 配置该机实际可用的 `TEAM_AGENT`；岗位的同名文件可覆盖它并指定 `WORKTREE_DIR`。
模型来自目标机 `TEAM_MODEL_WORK/RESEARCH` 或 Agent 默认；派单方隐式配置不传过去。`--tier/--model/--media` 均在目标机校验，缺配置或能力不明就拒绝。

在派单方 `.genethub/remote-targets.json` 写真实绑定，例如：

```json
{
  "qa": {
    "machineId": "<machine list 返回的精确 ID>",
    "workspaceId": "<目标机已注册的岗位 workspace ID>",
    "command": ["<目标机 GENEHUB_PYTHON 的绝对路径>", "<目标团队 tools/team.py 的绝对路径>"]
  }
}
```

路径属于目标机，含空格可直接放 argv 元素中，不拼 shell 字符串。接单进程使用目标 daemon 绑定的 `GENEHUB_CLI`；缺少绑定时直接失败，不猜另一个安装或渠道。绑定每个岗位只指向一个工位，不做机器发现调度。

## 派单和投递

```text
team.py spawn --space qa --kind work --machine <ID> --request-id qa-review-42 --desc "验收变更" "任务正文"
team.py send --machine <ID> --to qa "补充要求"
```

接单先验证 workspace 的真实根目录属于该脚本所在团队的指定岗位，再用现有 `genet-writer.json` 的文件排他创建拿写锁。
工作岗位锁自己的 WORKTREE_DIR，未配置则锁岗位根；research 是只读任务不拿写锁。其他会话/机器派单遇到同一目录锁直接报忙。
本机派单也不能抢走远端锁或未知创建结果的保留锁。协作锁只约束使用团队工具的写者，不限制任意 shell 或恶意会话。

`send` 只补充本团队 pending 中仍持有效回执的会话，且由执行端在同一接单锁内投递；完成释放后的旧会话拒绝投递，新任务先 spawn。零个先 spawn，多个用精确 session ID。系统通知保留用户暂停；要恢复须由 Human 输入。
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
