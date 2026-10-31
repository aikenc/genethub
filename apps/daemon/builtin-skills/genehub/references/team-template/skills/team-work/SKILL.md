---
name: team-work
description: 1+N 项目团队的研发与验收会话（含研发组长 Leader、各管线组员、QA 验收）：研发组长自主评估里程碑规划与版本内容可达性，并发编排多工位组员、预检合入、无头浏览器实操截图验收、发布可玩版本并刷新常驻看板。在 leader、qa 与各管线岗位空间里开的会话用它。
---

# 团队研发与验收

开工先用两三句话复述任务、所在工位（`WORKTREE_DIR`）和完成标准；有疑问但不阻塞就按合理默认推进并写明假设。下文 `team.py` 即 `"$GENEHUB_PYTHON" <团队根>/tools/team.py`。

## 研发组长（`spaces/leader`）

1. 先盘点代码基线，评估版本内容可达性与里程碑排期：路线图写 `<团队根>/.pm/trunk/MILESTONE_PLAN.md`；本版本的接口契约、各组员负责的文件边界与验收标准写 `<团队根>/.pm/trunk/milestone-vX.Y.md`。
2. 编制：`team.py employee add <岗位> --desc "<职责>" --repo <主仓>`、`employee retire <岗位>`、`employee ls`；每个组员要有独立工位：`team.py worktree create <slot> --repo <主仓> --branch <分支> --space <组员>`。
3. 并发派单：连续 `team.py spawn --space <组员> --kind work …` 启动多路组员或小组长，然后立即结束本轮；同批全部结束后系统合并成一条 `用途: result` 唤醒你。
4. 多条 `human` 指令按时间序（`#1 → #K`）读，后一条否定前一条时以最新一条为准；请本机其他团队会诊用 `team.py send --to <团队名> --kind question`。
5. 合入：收到组员提交后，在集成工位用 `git merge-tree` 预检无冲突再合入 `main`，并跑语法与构建检查。
6. 验收：`team.py spawn --space qa --kind work` 派 QA（要数值对比时同时派 `research`），结束本轮等回执。
7. 发版：QA PASS 后 `team.py publish release <构建目录> --name vX.Y`，发布到 `datas/releases/vX.Y/index.html` 并更新版本索引与看板；把 `MILESTONE_PLAN.md` 对应条目勾成 `- [x]`。紧急异常用 `team.py publish rollback`。

有浏览器持久数据的应用，先读 `genehub-preview` 的静态预览存储约定：从首版保留固定的用户入口，版本目录用于归档。换版本目录不是存储迁移；旧入口已交付时保留旧版，并提供明确的导出/导入步骤，不让用户重录，也不能仅凭相同存储键承诺自动保留。

## 管线组员与小组长（如 `skill-lead`、`map-lead`）

- 在系统注入的 `WORKTREE_DIR`（`worktrees/<slot>`）里编码、自测并 `git commit`。
- 模块大时当小组长：`team.py spawn --space <本空间> --kind work --worktree auto --desc "子模块" "任务"` 派 5~10 个子工位
  （需要时加 `--space research --kind research`），立即结束本轮；收到汇总回执后把各 `worker/*` 分支合入本工位并自测提交。
- 最终回复列出：分支名、commit SHA、改动文件与核心机制、自测结果。

## QA（`spaces/qa`）

不凭代码猜。用 Playwright 等无头浏览器打开真实页面，模拟按键和点击；断言 `console.error` 与 `pageerror` 为 0；
截关键画面放进报告目录并在 HTML 报告中引用；跑数值模拟检验 TTK、胜率、经济曲线。最后 `team.py publish report <目录> --slug qa-vXY` 发布到 `datas/reports/<slug>/index.html`，给出明确的 PASS/FAIL 与报告链接。

涉及升级保留用户数据时，在同一个浏览器中从原先交付的真实 Beta 入口添加数据，再进入新交付入口核对数据与状态；涉及迁移时实际操作导出/导入和取消。候选本地页面、存储格式兼容或只在新入口重开通过，都不能替代这一步。无法完成真实入口验收时明确写未验收，不把它归为 PASS。

## 链接与等人

- 预览、报告、截图链接写成相对团队根的 `[名称](datas/...)` 或 `[名称](temp/...)`：不加 `../`，不放进反引号。
- 后台不挂起等人：要用户决定的事，把选项和推荐写进最终回复交回请求方，由前台去问；不调用 `AskQuestion`、`request_user_input`、`session ask`。
