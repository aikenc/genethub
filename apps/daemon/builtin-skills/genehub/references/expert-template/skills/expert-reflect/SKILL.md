---
name: expert-reflect
description: 专家的反思自省会话：非实时地回看会话与留言，执行记忆提炼（Session -> 各空间 index.md -> 根 memory.md），改进 soul.md、Skill 与脚本。
---

# 反思（Reflect）

你不面对用户，只让这位专家下次做得更让用户满意；这是唯一的目标。先读 `references/rationale.md`：我们的理念、做过的权衡、自由度、加限制的规则。下面是做法，都是建议：挡了用户的路就偏离，并写明原因。

专家根目录是 `expert.py path root`（你的 cwd 往上两级），改它的文件用绝对路径。`datas/` 是项目正本，归工作会话，没有必要不去写。

1. **立即调用工具读简报与自愈异常**（第一轮必须带工具调用读取第一条消息里的简报路径，严禁只发纯文本开场白结束本轮）：看未处理留言（含 `kind=anomaly`）、**疑似异常会话**、各空间会话与模板差异。对卡住、失败或无回复停止的会话，先用 `genet session get <id>` 确认 `interactionSummary.requests` 为空（没在等人），再读 `session narrative` 查清原因，能恢复的 `session interrupt` 后重开或补发给请求方；属平台缺陷的记入 `docs/platform-issues.md`。
2. **追根因与三级记忆提炼（`Session -> 各空间 index.md -> 根 memory.md`）**：
   - 按留言的 `ref` 用 `genet session narrative <会话> --item <消息>` 或用 `rg` 搜 `.genethub/sessions/` 与 `spaces/*/.genethub/sessions/`，定位根因。
   - **空间级提炼（L2）**：把 `front`、`research`、`work` 各自专属的踩坑教训、检索词 + `ghref` 证据指针写入对应 `front/index.md` 或 `spaces/<空间>/index.md`。
   - **专家根级提炼（L1）**：将跨空间共性、高频复现的全局铁律浓缩进根目录 `memory.md`（严格守 ≤30 行，满了先合并或降级到对应空间 `index.md`）。
3. **改自己与规范**，优先级：`soul.md` / `memory.md` / 各空间 `style.md` 与 `index.md` > 本地 Skill（`skills/local-*`，并加进对应描述文件的 `skills`）> 本地脚本（`tools/local/`）> 平台文件（改动要小，升级要合并）。`expert-core` 守 ≤40 行，合并指令守 32 KiB。
4. **生效与记录（必做闭环）**：改完运行 `"$GENEHUB_PYTHON" <专家根>/tools/expert.py sync-identity`（内部自动调用 SpaceBuilder 编译校验，不过就 `git checkout` 回退）；最后 `expert.py snapshot -m "…"` 提交，并 `expert.py notes done <编号> --result "做了什么"`。
5. **外部问题**（需要用户给环境或授权、平台 bug、平台机制不健全）：写清种类、证据引用、试过什么、需要谁做什么，用 `expert.py tell-user` 交前台转告。
6. **通知前台（二选一，绝不双发）**：需向用户汇报（如外部问题、重要改动或用户主动触发的 `reflect now`）只调 `expert.py tell-user`；无需打扰用户但前台有常驻会话时，才调 `expert.py send --to <前台会话id> --kind note "已静默更新：…"` 供前台内部吸收。两者绝不同时发送。

自由度：自由——`soul.md`、`memory.md`、各空间 `style.md` 与 `index.md`、自己的 Skill 与脚本；谨慎（先在 `temp/` 验证，写依据）——改 `expert-core`、平台文件、脚本层加限制或放宽；先问用户——涉及外部系统与授权、整体重置、拿不准用户满不满意的取舍。升级平台文件见 `references/upgrade.md`。
