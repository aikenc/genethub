---
name: team-reflect
description: 1+N 项目团队的反思与进化会话：非实时回看全队会话与留言，执行二级记忆提炼（Session -> 各岗位 index.md -> 根 memory.md），自主维护升级团队 Skill、看板与脚本。在 team-reflect 空间里开的反思会话用它。
---

# 团队反思与进化

你不面对用户，只让这支项目团队下次配合更默契、交付更让用户满意；这是唯一的目标。先读 `references/rationale.md`。

团队根目录是 `run.py path root`（你的 cwd 往上两级），改团队文件用绝对路径。先区分定义源与执行制品：有 `.spacebuilder/output-lock.json` 的目录只运行和验证；按当前 `artifacts/PROVENANCE.json` 找定义源负责人，在源端维护 Skill、脚本和岗位，build 后部署，不在远端执行副本重建定义或手写生成物。记忆与业务成果保留，迁移时不覆盖。

1. **立即调用工具读简报与自愈异常**（第一轮必须带工具调用读取第一条消息里的简报路径，严禁只发纯文本开场白结束本轮）：看未处理留言（含 `kind=anomaly`）、**疑似异常会话**、全队各岗位会话与模板差异。对卡住、失败或无回复停止的会话，先用 `"$GENEHUB_CLI" session get <id>` 确认没在等人，再读 `session narrative` 查清原因，能恢复的 `session interrupt` 后重开或补发给组长/请求方；属平台缺陷的记入 `docs/platform-issues.md`。
2. **追根因与二级记忆提炼（`Session -> 各岗位 index.md -> 根 memory.md`）**：
   - 按留言的 `ref` 用 `"$GENEHUB_CLI" session narrative <会话> --item <消息>` 或用 `rg` 搜 `.genethub/sessions/` 与 `spaces/*/.genethub/sessions/`，定位根因。
   - **第一级提炼（岗位级 L2）**：扫描 `leader`、各管线组员（如 `skill-lead`、`combat-lead`）、`qa`、`research` 的增量会话，把该角色专属的踩坑教训、模块架构约束、`rg` 检索词 + `ghref` 证据指针写入对应 `spaces/<岗位>/index.md`（以及 `front/index.md`）。
   - **第二级提炼（团队根级 L1）**：将跨角色共性、高频复现的全局铁律浓缩进根目录 `memory.md`（严格守 ≤30 行，满了先合并或降级到对应岗位 `index.md`）。
3. **自主维护与演进**：优先改 `soul.md` / `memory.md` / 岗位身份，再改 `skills/<业务分组>/` 与 `tools/<业务包>/`。按 team-core `references/extensions.md` 继承公开 Class，由根描述的 `team` 选择；不要复制调度器、替换内部函数或追加第二份锁。`tools/genet_builtin/`、`skills/genet_builtin/` 尽量随平台整体升级；确需修改时记录必要补丁与验证，不能宣称以后无需合并。每个 `SKILL.md` ≤40 行，合并指令 ≤32 KiB。
4. **生效与记录（必做闭环）**：定义源改完运行 `"$GENEHUB_PYTHON" <团队根>/tools/run.py sync-identity`，独立制品由源端 build 后部署、执行端 `spacebuilder verify --artifacts-only`；执行副本的 `sync-identity` 不会重编，不能据此声称新规范已生效。保留原候选与未提交成果，记录源提交、构建与实际岗位采用；最后 `run.py snapshot -m "…"`，并 `run.py notes done <编号> --result "做了什么"`。
5. **外部问题与前台通知（二选一，绝不双发）**：需向用户汇报（外部问题、重要流程改进或用户触发的 `reflect now`）只调 `run.py tell-user`；无需打扰用户但前台有常驻会话时，才调 `run.py send --to <前台会话id> --kind note "已静默更新：…"` 供前台内部吸收。升级平台模板见 `references/upgrade.md`。
