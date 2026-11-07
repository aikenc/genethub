---
name: genehub-team
description: GeneHub 的团队机制：多个 Agent 会话组成一支会接力的队伍，用户只跟前台说话，后台岗位并发推进、结果自动回到发起方。用于建团队、接入共享团队、项目团队、多 Agent 并发开发与派单接力、扩建或精简岗位、团队看板与可玩版本，以及定制、改造或从零重写团队。区分平台原语与内置样板，按身份路由到对应参考。
---

# 团队

团队不是平台内置的调度器。平台只提供原语（Space 树、身份编译、定时 hook、系统通知、会话控制、档位路由、
跨机执行）；内置的 1+N 项目团队是用这些原语搭出来的**样板**——一棵 Space 树加 `tools/run.py` 等脚本。
建出来的团队归用户所有，可以改，也可以整体换掉。机制正本是 GeneHub 源码仓的 `docs/teams.md`。

## 按身份读

| 你现在是 | 读什么 |
|---|---|
| 用户要一支团队、接入别人分享的团队 | 交给机器管理员：`../genehub/references/team-admin-skill/team-admin/SKILL.md`；不要手搓目录 |
| 团队里的会话（cwd 在某个团队下） | 团队自己的 `skills/genet_builtin/team-core` 与岗位 Skill（已随身份加载）；它们以团队当前版本为准 |
| 想知道内置样板怎么运转：岗位、命令、接力规则、升级 | [references/template.md](references/template.md) |
| 要改岗位、流程、Skill、脚本，或换掉样板 | [references/customize.md](references/customize.md) |
| 不用样板，从平台能力开始自己写 | [references/primitives.md](references/primitives.md) |

样板文件在 `../genehub/references/team-template/`，统一入口是 `tools/run.py`，内置实现位于 `tools/genet_builtin/`；业务扩展见模板 team-core 的 `references/extensions.md`。

## 日常只需理解这些

前台按岗位给目标与验收标准，用已有 `task start`；执行会话需要支持用 `task support`，提交结论用 `task finish`。脚本自动解析岗位所在机器、保存归属并把结果回到原请求方。接收不是完成，未知结果沿原编号恢复。只有维护 Agent 需要配置远程目标并运行原 build，详见管理员 Skill；普通任务不换算机器 ID、不搬文件、不填写回传配置。

## 不能违反的三条

- **派单后立即结束本轮**：样板里 `task start/support/send` 都是纯异步，结果由定时对账收齐后唤醒你；
  不 sleep、不轮询。自己写的团队也不要让会话守着等。
- **对用户零黑话**：只说进展与结论，不提脚本、内部目录或工位；后台岗位不挂起等人，要人决定的事经前台问。
- **改源文件，不改生成物**：`AGENTS.md`、`.agents/skills/`、`.genethub/hooks/` 由 SpaceBuilder 生成；改身份或
  Skill 后用 `run.py sync-identity`（或 `spacebuilder.py build`）重编，重开会话才生效。

## 边界

- 团队可以改自己的 Skill、身份与脚本；平台内置 Skill 与 daemon 行为不归团队，重装会覆盖。
- 用户不满意先 `run.py note --kind unhappy`，流程问题用 `run.py reflect now`；平台缺陷写进团队的
  `docs/platform-issues.md`，不要绕过平台。
- Workflow（PM / Executor）是退役中的旧机制，不要用它建团队或派单。

## Timer执行约定

回调默认`schedule: "fixed-delay"`：本次命令及收尾结束后再等`every`，运行中不重入、不积压补跑，冷却不占执行名额。Team巡检使用此模式；耗时超过触发间隔本身不算故障，仍按声明timeout处理。显式`interval`仅供短命令，其实际执行期限为`min(timeout, every×15%)`，亚秒值不向上取整，到期整组强制结束。改模板hook源并重新build，不手改生成的`.genethub/hooks/`；新daemon默认也适用于未写schedule的已有hook，跨渠道共同执行需核对各daemon版本。
