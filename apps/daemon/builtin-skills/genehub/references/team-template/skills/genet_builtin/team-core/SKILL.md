---
name: team-core
description: 按任务选择 Owner 的团队公共约定：前台、专业执行、QA、研究与反思岗位的会话协作机制，用 tools/run.py 派单、异步回合接力、管工位、发版本、刷看板与持续自进化。任何会话都先读。
---
# 项目团队公共约定
**流程是为用户满意服务的。** 默认照做；照做会明显损害用户时，先做对用户有利的事，并留言（会话、轮次、原因）说明为什么偏离。不无声偏离，也不为偏离堆例外。察觉用户不满意，先留言，再处理。
统一入口为 `"$GENEHUB_PYTHON" <团队根>/tools/run.py`；业务扩展、配置 Class 与升级先读 [扩展合同](references/extensions.md)。`genet_builtin/` 是平台随附基线，优先继承；必要时可修改并记录补丁。新任务先读 [Task Owner 合同](references/task-owner.md)：`task start/support/send/finish` 按精确会话协作；结算须有明确结论与证据。下表 `spawn/send` 保留给旧派单，不能用于绕过新任务账本。
| 命令 | 作用 |
|---|---|
| `task start --space <岗位> --desc "一句话" --request-id <稳定编号> "目标与验收"` | 建立任务及 Owner，自动使用该岗位的本机或远程绑定 |
| `task support <任务> --space <岗位> --desc "一句话" --request-id <编号> "要求"` | 请求支持，结果回到本会话，派单后结束本轮 |
| `task send <任务> --request-id <编号> "追加要求"` / `task status <任务>` | 补充原任务、核对原回执；未知不重派 |
| `task finish <任务> --outcome success\|failed\|blocked "结论与证据"` | 明确提交执行结果，普通回复不代表结算 |
| `employee add <名> --desc "职责" [--repo 仓]` / `employee ls` / `employee retire <名>` | 动态扩编管线岗位（自动建子空间并切 worktree 工位）、查看在岗编制或转入待岗 |
| `worktree create <slot> --repo <仓> [--branch B] [--space 岗位]` / `worktree bind\|ls` | 从主仓切出独立 git worktree 工位并写入子空间 `open.env` `WORKTREE_DIR` |
| `publish release <源> --name <vX.Y>` / `publish report <源> --slug <名>` / `publish rollback` | 发布可玩版本至 `datas/releases/<vX.Y>/`、发布报告至 `datas/reports/` 或紧急回滚 `latest` |
| `board start\|refresh` / `directory` / `models check` / `temp new\|ls\|rm\|clean` | 启动/刷新常驻团队看板服务 `datas/board/index.html` / 看会话目录 / 管临时区 |
| `note --kind unhappy\|preference\|external\|observation --quote "原话"` / `reflect now "要求"` | 给 `team-reflect` 留言 / 立即启动团队反思；`snapshot` / `drift` 管理团队仓库与模板差异；`reset` 只在用户明确要求时用 |
失败时命令会说明：出了什么、现在状态、下一步。细则见 `datas/README.md`、`temp/README.md`；点名模型勿套档位，详见 `references/models.md`。
日常按岗位使用 task 即可，机器与返回来源由原回执固定。维护远端绑定或恢复旧派单时再读 [references/remote-targets.md](references/remote-targets.md)；`spawn/send` 仅用于已存在的旧派单。
暂停会话的显式恢复、署名、去重与验收，先读 [references/resume-paused.md](references/resume-paused.md)。
自动身份刷新不执行 Space pre/post 或 Provider post；有此类配置时，定时任务保留上一版生成身份，不因此唤起异常反思，手工 `sync-identity` 返回 `SB018`。
修改源后显式 build 更新身份；发布 hook 由源 Space 的显式构建执行，不能靠反复刷新身份来运行。
## 纯异步多级回合接力与二级记忆
- **纯异步回合接力**：有 taskId 时用 `task support` 派出必需协作并结束本轮，timer 收齐结果后唤醒精确请求会话；收尾用 `task finish`。旧派单继续原 `spawn/send` 回执。普通结果不解除用户暂停，未知结果不换编号重派。
- **二级记忆**：对话是事实源（L3）；全局铁律存根 `memory.md`（L1，≤30 行）；各岗位专属经验与 `ghref` 检索指针存 `spaces/<岗位>/index.md`（L2）。查历史会话直接 `rg "<词>" <团队根>/.genethub/sessions/ <团队根>/spaces/*/.genethub/sessions/`。
## 系统消息
以「用途:」开头的消息是脚本写的（`result`、`report`、`watchdog`、`tell-user`、`reflect`、`human`、`patrol`、`task`/`question`/`note`），不是人类的直接批准；带 `ref: ghref:item:<会话>:<消息>` 的可用 `"$GENEHUB_CLI" session narrative <会话> --item <消息>` 取全文。命令行一律用 `"$GENEHUB_CLI"`，不要猜 `genet`：本机可能装着别的渠道。
## 项目登记与移除
`experts`、`me`、看板和 timer 中的目录查询只读，不能把缺失的项目或成员自动 `space open`。用户从列表移除团队后，保留的目录和会话不等于恢复登记的授权；恢复由明确的打开、安装或建队操作执行。项目移除由平台一次处理整个成员树，任何成员运行中或等待交互时拒绝整组移除，不通过逐个移除成员绕过检查。
已有团队升级时，在定义源合入本条及内置 `tools/genet_builtin/team.py` 的查询修复，保留业务 Class、数据与回执，构建完整制品后安装。旧版 `tools/team.py` 若仍含查询时自动打开的实现，也要在迁移时移除该副作用；只更新平台不会自动改写已有团队副本。
## Timer计时与恢复
Team hook使用默认`fixed-delay`：一轮退出并收尾后再等待`every`；运行中不并发、不追补，冷却释放名额，失败或超时也等待。不要为了追求固定启动频率改成`interval`，该模式执行时限最多为间隔的15%，会强制结束超时进程组，适合很短且幂等的命令。长调用需要合理timeout，明显慢查询仍需修复；alive不代表一轮完成。更新模板hook源后build完整制品，再核对实际hook、daemon版本和回传；仅替换文件不代表正在执行的回调已采用新规则。
机制 report/health/watchdog 熔断默认写内部 notes；例行反思静默，真实交付与用户问题保留原路由。
