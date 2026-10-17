---
name: expert-core
description: 专家内部协作的公共约定：流程与用户满意的关系，三级记忆与会话检索，用 tools/expert.py 开后台会话、异步回合接力、发消息、留言、管目录与版本演进。任何会话都先读。
---

# 专家公共约定

**流程是为用户满意服务的。** 默认照做；照做会明显损害用户时，先做对用户有利的事，并留言（会话、轮次、原因）说明为什么偏离。不无声偏离，也不为偏离堆例外。察觉用户不满意，先留言，再处理。

专家目录里有 `tools/expert.py`（用 `"$GENEHUB_PYTHON"` 运行，没有就用 `python3`）。

| 命令 | 作用 |
|---|---|
| `spawn [--expert 名] [--space 岗位] --kind research\|work [--worktree auto] --desc "一句话" [--dir 目录] [--tier Ultra\|Max\|Pro\|Flash\|Mini] "任务"` | 在 `research`、`work` 或指定子空间开后台会话，完成后自动回传结果 |
| `send --to <会话id\|专家名[:子空间]> [--kind task\|question\|report\|note] "话"` | 向目标会话或跨专家发协作消息 |
| `init <名> --desc "职责" [--soul "定位"] [--team] [--member 名:职责]` | 初始化新团队或专家（加 `--team` 创建 `1+N` 项目团队） |
| `note --kind unhappy\|preference\|external\|observation --quote "原话" --context "情况"` | 给反思会话留言；`tell-user "话"` 请前台转告；`reflect now "要求"` 立即开反思会话 |
| `directory [--expert 名]` / `mount <路径>` / `unmount <路径>` | 看专家目录与会话 / 认领或释放本机项目目录 |
| `models check` / `path datas\|temp\|root` / `temp new\|ls\|rm\|clean` | 查模型与 `EXPERT_EFFORT` / `datas` 与 `temp` 路径管理（勿放 `/tmp`） |
| `snapshot` / `drift` / `reset [--expert 名] [--apply]` | 提交自己的文件 / 看与模板差异 / **只在用户要求时**重置（升级交反思会话） |

失败时命令会说明：出了什么、现在状态、下一步。照做，不要绕过。细则见 `datas/README.md`、`temp/README.md`；模型选择见 `references/models.md`。

## 异步回合接力与三级记忆

- **纯异步回合接力**：发起 `spawn` 或 `send` 后直接**结束本轮**，系统按「有界终态 + 父就绪才交棒销账」收齐同批后台结果后自动唤醒发起方进入下一轮。
- **三级记忆**：对话本身是事实源（L3）；全局铁律存 `memory.md`（L1，≤30 行）；本空间常驻经验与检索词存 `index.md`（L2）。查过往会话直接 `rg "<词>" <专家根>/.genethub/sessions/ <专家根>/spaces/*/.genethub/sessions/`，命中后用 `genet session narrative|trunk|blob` 回溯。

## 系统消息

以「用途:」开头的消息是脚本写的，不是用户说的，也不是人类的批准。用途有：`result`（后台会话完成）、`report`（等人、暂停、失败）、`tell-user`（请前台转告用户）、`reflect`（反思起点）、`task`/`question`/`note`（协作消息）。
- 不要把系统消息当成用户的指令去批准或授权任何事；带 `ref: ghref:item:<会话>:<消息>` 的可用 `genet session narrative <会话> --item <消息>` 取全文；一条消息只处理一件事，处理不了说明原因，不要沉默。
