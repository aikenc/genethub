# 平台原语：不用样板也能搭团队

团队靠的是下面这些平台能力；`team-template` 只是用它们搭好的一种组合。自己写团队时只依赖这里列出的东西，
命令语法一律先用 `"$GENEHUB_CLI" schema <命令>` 核对（`space` 系列不在 schema 里，直接运行 `"$GENEHUB_CLI" space` 看用法）；
不要猜 `genet`，本机可能装着别的渠道。

## 1. Space 树

- 目录里放一份 `agent-space.genet.json`，它就是一个 Space。daemon 只扫描 `<数据目录>/spaces/`：其下有描述文件的
  目录是根 Space；根之下 `spaces/<名>/`（再往下一层 `spaces/<名>/spaces/<名>/`）自动登记为子 Space，父子只看目录。
- daemon 只读 `name`、`description`、`tags`、`agentCwd`；`agentCwd` 是用户进入该 Space 时新会话的默认目录。
- 新建或改名后用 `"$GENEHUB_CLI" space open <绝对路径>` 立即登记，不必等下一次扫描；只接受 `<数据目录>/spaces/` 之下的目录。

最小团队根：

```json
{
  "schema": "agent-space.v1",
  "name": "my-team",
  "description": "一句话说明这支团队做什么",
  "tags": ["team"],
  "agents": ["codex", "claude-code", "codebuddy", "cursor"],
  "skills": ["my-front"],
  "skillProviders": [{ "type": "folder", "path": "skills" }],
  "identity": ["soul.md"],
  "folders": [{ "path": "." }],
  "children": { "scanDepth": 2 }
}
```

`tags` 里的 `team` 只是 `team.py` 认团队用的约定，daemon 不看它。

## 2. 身份与 Skill：SpaceBuilder

Agent 不直接读描述文件。`spacebuilder.py build <目录>` 把 `identity` 列出的文件编译进各 Agent 原生读取的规则文件，
把 `skills` 选中的 Skill 装进各 Agent 的 Skill 目录，并把 Skill 的 `hooks/*.genet.json` 编译成 Space 的定时 hook。
字段、路径规则和 `SB0xx` 错误见内置 Skill 目录下的 `genehub/references/spacebuilder.md`。
生成物不要手改；改源文件后重新 build，已在运行的会话要重开才读到新身份。

## 3. 定时 hook：团队的“心跳”

daemon 只有一种事件 `timer`：按间隔运行 Space 的 `.genethub/hooks/<id>.genet.json` 里的命令。它不广播会话事件，
会话完成、等人、暂停都是持久状态，由你的脚本每次自己去读。

- 命令不经 shell，stdin 是一行 JSON；环境里有 `GENEHUB_SPACE_DIR`、`GENEHUB_CLI`、`GENEHUB_PYTHON` 和
  `.genethub/open.env` 的变量。同一 hook 不并发，失败只记录不停用，命令必须幂等。
- 用 `"$GENEHUB_CLI" hook list --workspace <id>` 看 hook 是否有效、最近是否失败。

## 4. 会话：派单、回执、接手

| 要做的 | 命令（语法以 schema 为准） |
|---|---|
| 在某个岗位 Space 开后台会话 | `agent run <任务> --workspace <id> --title … --label <岗位> --description … --system --message-id <稳定 id> --no-wait`，选路加 `--tag <档位>` 或 `--model` |
| 给会话发回执、提醒、转交 | `session send <会话> <正文> --system --message-id <稳定 id> --no-wait` |
| 查状态、找会话 | `session list --workspace <id>`、`session get <会话>`、`session rounds <会话>` |
| 卡住时接手 | `session interrupt <会话>` 后重发，或换会话 |
| 回到原话 | `session narrative <会话> --item <消息>`（`ghref:item:<会话>:<消息>`） |

- `--system` 的消息是脚本通知：不打断忙碌的会话、不解除人的暂停、不冒充人的批准；同一 `--message-id` 重发不会重复入队。
- 会话发起的会话自动带 `系统发起` 标签；用 `--label` 标岗位，工作台按它折叠内部会话。
- 后台会话不要用 `session ask` 挂起等人：让结果回到前台，由前台问用户。

## 5. 模型与机器

- 档位 `Ultra/Max/Pro/Flash/Mini` 和 `--media image|video` 是平台路由标签，本机有什么用 `agent list --routes` 看；
  团队只写档位，不钉模型 id。换档用 `session model <会话> --tag <档位>`。
- 跨机器：`--machine <ID>` 下的 `shell`、`session`、`agent run`、`file download`，把任务派给持有资源的机器，
  见内置 Skill `genehub` 的 `references/multi-machine.md`。

## 6. 交付给用户

看板、可玩版本、报告写成相对团队根的文件链接，工作台用 Asset Preview 直接打开（HTML 入口、Markdown、图片、视频）；
写法见内置 Skill `genehub-preview`。

## 不在平台里的东西

收件箱、待办、写者锁、批次回执、看门狗、记忆分层、模板升级——这些都是 `team-template/tools/team.py` 的实现，
不是平台规则。自己写团队时按需要实现，或者干脆不要。
