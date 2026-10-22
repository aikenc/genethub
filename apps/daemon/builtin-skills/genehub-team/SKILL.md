---
name: genehub-team
description: GeneHub 的 1+N 项目团队机制：一个团队根空间加若干 spaces/<岗位> 子空间，用团队根目录的 tools/team.py 派单、纯异步回合接力、切独立工位、发版与刷常驻看板。用于项目团队、建团队、扩建或精简岗位、给组员或组长派单、多 Agent 并发开发、团队看板与可玩版本的请求。
---

# 项目团队

团队不是平台内置的调度器：它是磁盘上的一组 Space（团队根 + `spaces/<岗位>/` 子空间），加两个随
团队复制、可自主演进的脚本 `tools/team.py` 与 `tools/pm_board_server.py`。用户只跟**主入口（前台）**
说话，其余岗位在后台协同；里程碑规划、并发开发、验收和发版由团队自己完成。

## 拓扑

| 岗位 | 位置 | 职责 |
|---|---|---|
| 前台（主入口） | `front/`（`agentCwd`） | 唯一直接面对用户的窗口：接诉求、追进度、给看板与试玩入口 |
| 研发组长 | `spaces/leader` | 盘点基线、写里程碑与契约、并发派单、合并主干、发版 |
| 管线组员 | `spaces/<岗位>` | 各管一条业务线，在独立工位开发 |
| QA | `spaces/qa` | 无头浏览器实操截图与数值断言验收 |
| 研究 | `spaces/research` | 数值与方案推演，产出报告 |
| 自省 | `spaces/team-reflect` | 维护团队规范、脚本与模板升级 |

- 团队根是子空间的父目录；`agent-space.genet.json` 的 `children.scanDepth` 决定子空间发现深度。
- 团队根有自己的前台会话，`spaces/team-reflect` 跑反思，其余子空间按岗位接收 `work` / `research` 会话；
  每个子空间可以绑独立工位 `WORKTREE_DIR`（一个 git worktree）。
- 模板在 `../genehub/references/team-template/`；建团队、挂工位、起看板走机器管理员
  `../genehub/references/expert-admin-skill/expert-admin/SKILL.md`，不要手搓目录结构。

## 发现与创建

- 先查重：`"$GENEHUB_PYTHON" <团队根>/tools/team.py directory` 列出 `<数据目录>/spaces/` 下已有团队与
  在岗会话。同项目已有团队就复用并补齐成员，不新建第二个。
- 新建由管理员按用户一句话描述设计规模（1+2 / 1+3+QA / 1+5+QA）后一键初始化，再切工位、起看板、
  `snapshot` 留基线。用户不需要知道团队结构或任何命令。

## 派单与接力

| 命令 | 用途 |
|---|---|
| `spawn --space <岗位> --kind work\|research [--worktree auto] --desc "一句话" [--tier Ultra\|Max\|Pro\|Flash\|Mini] [--media image\|video] "任务"` | 在子空间起后台会话；`--worktree auto` 自动切独立并发工位 |
| `send --to <岗位\|会话\|外部专家> [--kind human\|patrol\|task\|question\|note] "话"` | 投递消息；对方忙时写文件收件箱，0 抢占不打断 |
| `employee add\|ls\|retire` | 动态扩编或待岗岗位，自动建子空间与工位 |
| `worktree create\|bind\|ls` | 从主仓切 worktree 并写子空间 `open.env` 的 `WORKTREE_DIR` |

- **纯异步**：`spawn` 或 `send` 之后**立即结束本轮**，不 sleep、不轮询、不阻塞等待。
- 系统按三法则收齐结果再唤醒上级：**有界终态**、**父就绪才交棒销账**、**根节点组长看门狗自愈**。
- 分形多级：`Leader -> 小组长 -> 多名并发 Worker + Research` 用同一套机制，不需要新协议。
- 同一批子任务全部结束后合并为一条 `result` 回执；中途异常由看门狗拉起，不必人工催促。
- 档位 `Ultra/Max/Pro/Flash/Mini` 是平台路由标签，不是模型 id；有图片或视频需求加 `--media`。
  团队只写标签，不钉 `modelId`。

## 产物、看板与汇报

| 命令 | 作用 |
|---|---|
| `publish release <源> --name vX.Y` / `publish report <源> --slug <名>` / `publish rollback` | 发可玩版本到 `datas/releases/`、报告到 `datas/reports/`、紧急回滚 `latest` |
| `board start\|refresh` | 确保常驻看板服务在线并刷新 `datas/board/index.html` |
| `note --kind unhappy\|preference\|external\|observation --quote "原话"` / `reflect now "要求"` | 给自省岗位留言或立即改进团队流程 |

- 对用户只说进展与结论，不提 `team.py`、`.pm/`、工位等内部结构；链接一律写相对团队根的 `datas/...`。
- 常驻看板可用进程环境或团队根 `open.env` 的 `TEAM_BOARD_PORT=0` 关闭；跑测试的团队必须关掉，
  否则常驻进程会被判为资源泄漏。

## 边界

- 团队产物是产品资产：改模板、脚本与规范走 `sync-identity` 校验后 `snapshot` 提交，不手改生成文件。
- 用户不满意先 `note --kind unhappy`，流程问题用 `reflect now`，不要直接改平台机制。
- 团队自省可以改自己的 Skill 与 `tools/team.py`；平台内置 Skill 与 daemon 行为不归团队。
