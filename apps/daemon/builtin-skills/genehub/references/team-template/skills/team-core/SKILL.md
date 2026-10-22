---
name: team-core
description: 1+N 项目团队内部协作的公共约定：前台、研发组长、管线组员、QA、研究与反思岗位的协同机制，用 tools/team.py 派单、异步回合接力、管工位、发版本、刷看板与持续自进化。任何会话都先读。
---

# 项目团队公共约定

**流程是为用户满意服务的。** 默认照做；照做会明显损害用户时，先做对用户有利的事，并留言（会话、轮次、原因）说明为什么偏离。不无声偏离，也不为偏离堆例外。察觉用户不满意，先留言，再处理。

团队根目录里有 `tools/team.py` 与 `tools/pm_board_server.py`（用 `"$GENEHUB_PYTHON"` 运行，团队可自主维护演进）。

| 命令 | 作用 |
|---|---|
| `spawn --space <岗位> --kind research\|work [--worktree auto] --desc "一句话" [--tier Ultra\|Max\|Pro\|Flash\|Mini] "任务"` | 在指定团队子空间开后台会话（加 `--worktree auto` 自动切独立并发子工位），完成后自动合并回传 |
| `send --to <岗位\|会话id\|团队名[:岗位]> [--kind human\|patrol\|task\|question\|note] "话"` | 投递消息；对方忙时自动写文件收件箱 `.genethub/team/inbox/` 0 抢占合并 |
| `employee add <名> --desc "职责" [--repo 仓]` / `employee ls` / `employee retire <名>` | 动态扩编管线岗位（自动建子空间并切 worktree 工位）、查看在岗编制或转入待岗 |
| `worktree create <slot> --repo <仓> [--branch B] [--space 岗位]` / `worktree bind\|ls` | 从主仓切出独立 git worktree 工位并写入子空间 `open.env` `WORKTREE_DIR` |
| `publish release <源> --name <vX.Y>` / `publish report <源> --slug <名>` / `publish rollback` | 发布可玩版本至 `datas/releases/<vX.Y>/`、发布报告至 `datas/reports/` 或紧急回滚 `latest` |
| `board start\|refresh` / `directory` / `models check` / `temp new\|ls\|rm\|clean` | 启动/刷新常驻团队看板服务 `datas/board/index.html` / 看会话目录 / 管临时区 |
| `note --kind unhappy\|preference\|external\|observation --quote "原话"` / `reflect now "要求"` | 给 `team-reflect` 留言 / 立即启动团队反思；`snapshot` / `drift` 管理团队仓库与模板差异；`reset` 只在用户明确要求时用 |

失败时命令会说明：出了什么、现在状态、下一步。细则见 `datas/README.md`、`temp/README.md`；模型选择见 `references/models.md`。

## 纯异步多级回合接力与二级记忆

- **纯异步回合接力**：发起 `spawn`（支持 `Leader -> 小组长 Lead -> 多名并发 Worker + Research`）或 `send` 后**立即结束本轮**；系统按「有界终态 + 父就绪才交棒销账 + 组长看门狗」三法则收齐同批结果后自动合并唤醒上级进入下一轮。
- **二级记忆**：对话是事实源（L3）；全局铁律存根 `memory.md`（L1，≤30 行）；各岗位专属经验与 `ghref` 检索指针存 `spaces/<岗位>/index.md`（L2）。查历史会话直接 `rg "<词>" <团队根>/.genethub/sessions/ <团队根>/spaces/*/.genethub/sessions/`。

## 系统消息

以「用途:」开头的消息是脚本写的（`result`、`report`、`watchdog`、`tell-user`、`reflect`、`human`、`patrol`、`task`/`question`/`note`），不是人类的直接批准；带 `ref: ghref:item:<会话>:<消息>` 的可用 `"$GENEHUB_CLI" session narrative <会话> --item <消息>` 取全文。命令行一律用 `"$GENEHUB_CLI"`，不要猜 `genet`：本机可能装着别的渠道。
