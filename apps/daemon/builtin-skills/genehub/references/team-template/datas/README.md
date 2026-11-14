# datas：团队要长期维护的东西

这里放团队名下**希望持久维护**的一切：项目仓库、资料、调研产出、数据，不限于仓库。团队的文件都放在团队自己的目录里，不散落到机器的别处。

- **命名建议**：`datas/<group>/<project>` 或 `datas/<group>/<folder>`。仓库用地址里的 group 和名字（`https://github.com/aikenc/genethub` → `datas/aikenc/genethub`）；别的东西自己起个 group 归类，如 `datas/research/competitors`。命名是建议，不是强制，但要让人一眼看出是什么。
- **谁写**：工作会话写；思考会话与前台只读。思考想验证就去 `temp/` 做副本；要改就交给工作会话。
- **取路径**：不要自己拼相对路径。运行 `tools/run.py path datas <group>/<name>`（或 `--from <git 地址>`）得到绝对路径，加 `--create` 同时建目录。
- **看内容**：`tools/run.py datas ls`。
- **一个目录同一时间只有一个写会话**：开工作会话时用 `spawn --dir <绝对路径>`。
- **不要放这里的**：几天内会不用的临时文件，放 `temp/`。
- 用 `tools/run.py mount <路径>` 认领的外部项目目录不受这里的约束，原来在哪还在哪。

## 长期目标的迭代产物

只有长期目标使用 `datas/goals/<目标编号>/`；一般任务仍用原任务输出、`datas/reports/` 和 `datas/releases/`，简单答复不额外留目录。

```text
goals/<目标编号>/
  goal.md                 原需求、验收、整体期限与会话总数预算
  index.md                每轮一行：阶段目标、状态、版本、总结；预算已用/剩余
  iterations/<轮次>/
    plan.md               本轮规划，引用上一轮总结
    summary.md            交付、验证、差距、延续任务和下一轮方向
    evidence/             QA 原结论、对照截图、关键日志摘要
```

Owner 写 `goal.md`、规划和总结并维护 `index.md`；任务负责人与 QA 写本轮证据，前台和反思只读。规划完成即写 `plan.md`，与派单同回合；收尾写 `summary.md` 并更新索引。目标预算先由 Owner 手记，未知用量保留未知，不估算实际金额；程序化总账另行交付。

`task finish` 前先归档，证据不得引用 `temp/`。QA 结论写入后不改写，纠正追加新文件。可玩版本仍用 `publish release`，报告用 `publish report`；总结只链接产物，取证包和构建产物不进团队 Git，只记路径和校验值。不要在 `datas/` 下再嵌套一份 `datas/` 或 `temp/`。

新一轮开始采用本规范，不批量搬迁旧材料；旧根任务与原材料在 `goal.md`/`index.md` 引用，原任务累计时间、结论与控制保留。程序化迭代记录和旧任务转换命令尚未交付，不手写第二份账本。

被 `summary.md` 或 `evidence/` 引用的材料不得清理。当前自动扫描这些引用的保护尚待脚本升级；仍有旧临时引用时先归档再清理，不凭说明假设已自动保留。

这个文件由产品维护，每次 GeneHub 启动时会被覆盖；不要在这里记笔记。
