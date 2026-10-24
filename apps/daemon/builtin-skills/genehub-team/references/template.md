# 内置样板：1+N 项目团队怎么运转

这里描述的是 `../../genehub/references/team-template/` 这一份样板的实现，**不是平台规则**：团队可以改掉其中任何一条。
已建团队以它自己目录里的 `skills/team-core` 和岗位 Skill 为准——团队改过的地方，本文不再适用。

## 拓扑

| 岗位 | 位置 | 职责 |
|---|---|---|
| 前台 | 团队根，`agentCwd: front` | 唯一直接面对用户的窗口：接诉求、追进度、给看板与试玩入口 |
| 研发组长 | `spaces/leader` | 盘点基线、写里程碑与契约、并发派单、合并主干、发版 |
| 管线组员 | `spaces/<岗位>` | 各管一条业务线，在独立工位开发；`employee add` 扩出 |
| QA | `spaces/qa` | 无头浏览器实操截图与数值断言验收 |
| 研究 | `spaces/research` | 只读的推演、调研、评审，产出报告 |
| 反思 | `spaces/team-reflect` | 回看会话与留言，维护团队规范、脚本，做模板升级 |

Skill：`team-core`（所有会话先读）、`team-front`（带 5 秒定时 hook）、`team-work`、`team-research`、`team-reflect`。
身份四层：`soul.md` 宪章、`memory.md`（≤30 行）、岗位 `style.md`、岗位 `index.md`；会话记录是事实源。

## 命令（`"$GENEHUB_PYTHON" <团队根>/tools/team.py …`）

| 命令 | 用途 |
|---|---|
| `spawn --space <岗位> --kind work\|research [--worktree auto] [--machine <ID>] --desc "一句话" [--tier Ultra\|Max\|Pro\|Flash\|Mini] [--media image\|video] "任务"` | 在子空间起后台会话；`--worktree auto` 自动切独立并发工位；`--machine` 派到远端机器的同名岗位 workspace；`--team <名>` 派到本机另一支团队 |
| `send --to <岗位\|会话\|团队名[:岗位]> [--machine <ID>] [--kind human\|patrol\|task\|question\|note] "话"` | 投递消息；对方忙时写文件收件箱，0 抢占不打断；`--machine` 投给远端岗位或远端会话 |
| `employee add\|ls\|retire` | 动态扩编或待岗岗位，自动建子空间与工位 |
| `worktree create\|bind\|ls` | 从主仓切 worktree 并写子空间 `open.env` 的 `WORKTREE_DIR` |
| `publish release <源> --name vX.Y` / `publish report <源> --slug <名>` / `publish rollback` | 发可玩版本到 `datas/releases/`、报告到 `datas/reports/`、紧急回滚 `latest` |
| `board start\|refresh` | 确保常驻看板服务在线并刷新 `datas/board/index.html` |
| `note --kind unhappy\|preference\|external\|observation --quote "原话"` / `reflect now "要求"` | 给反思岗位留言，或立即改进团队流程 |
| `mount <目录>` / `unmount <目录>` / `path datas\|temp\|root` / `temp new\|ls\|rm\|clean` | 认领或释放业务目录、取标准路径、管 `temp/` 下的一次性产物 |
| `notes [ls\|done <编号>]` / `tell-user "话"` | 反思岗位处理留言、经前台转告用户 |
| `directory [--team <名>]` / `snapshot` / `drift` / `sync-identity` / `reset` | 查团队与会话、提交团队仓库、看模板差异、重编身份、用户要求时整体恢复模板 |

`--expert` 是 `--team` 的旧名，仍然可用。失败时命令会说明出了什么、现在状态、下一步。

## 接力规则

- **纯异步**：`spawn` 或 `send` 之后**立即结束本轮**，不 sleep、不轮询、不阻塞等待。
- 定时对账按三法则收齐结果再唤醒上级：**有界终态**、**父就绪才交棒销账**、**根节点组长看门狗自愈**。
- 分形多级：`Leader -> 小组长 -> 多名并发 Worker + Research` 用同一套机制，不需要新协议。
- 同一批子任务全部结束后合并为一条 `result` 回执；中途异常由看门狗拉起，不必人工催促。
- 一个目录同一时间只有一个写会话；并发组员在各自 worktree 提交，由组长 `git merge-tree` 预检后合入。
- 档位是平台路由标签，不是模型 id；团队只写标签，不钉 `modelId`。
- **跨机器**：`spawn --machine <ID>` / `send --machine <ID> --to <岗位>` 在远端的岗位 workspace 起会话或投递。
  账本、收件箱和写者锁仍留在派单方，`pending` 记录带 `machine`，定时对账据此去远端取状态与最终回复；
  远端不注册团队根、不跑前台与对账器。`--worktree`/`--dir` 只对本机有效，跨机没有共享写者锁；远端用目标机器
  自己的 Agent 与默认模型，不沿用请求方的 `modelId`。

## 对用户

- 只说进展与结论，不提 `team.py`、`.pm/`、工位等内部结构；链接一律写相对团队根的 `datas/...` 或 `temp/...`。
- 后台岗位不挂起等人；要用户决定的事回到前台，由前台问。
- 常驻看板可用进程环境或团队根 `open.env` 的 `TEAM_BOARD_PORT=0` 关闭；跑测试的团队必须关掉，
  否则常驻进程会被判为资源泄漏。

## 升级与恢复

- 初始化时模板记进团队仓库的 `platform` 分支；`drift` 看团队与模板的差异。
- 模板更新后，定时任务给 `team-reflect` 留 `upgrade` 留言，由它按
  `../../genehub/references/team-template/skills/team-reflect/references/upgrade.md` 在 `temp/` 里三方合并、验证后生效。
- 改名前的团队（Skill 叫 `expert-*`）合并后，`sync-identity` 会把描述文件里的旧名改指 `team-*`。
- `reset` 覆盖平台文件与 `soul.md`，只在用户明确要求时用，先看预演。

设计取舍的完整理由在 `../../genehub/references/team-template/skills/team-reflect/references/rationale.md`。
