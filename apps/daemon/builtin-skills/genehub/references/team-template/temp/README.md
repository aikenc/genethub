# temp：随时会被清理的临时区

**这里的东西随时可能被清理，不要把重要的东西放在这里。** 要保留的项目或资料搬到 `datas/`，结论写进 `memory.md`。

所有会话都可以读写。命名统一为 `temp/YYMMDD/hhmm_slug_sessionhash`，全部通过 `tools/run.py temp …` 完成，不要手工 `mkdir`、`rm -rf`：

- 新建：`tools/run.py temp new <slug> --purpose "一句话说明用途"`，打印出绝对路径，在里面工作。slug 只用小写字母、数字、连字符（如 `fix-login`、`review-pr-42`），要能看出用途；中文写进 `--purpose`。
- 查：`tools/run.py temp ls [--date YYMMDD] [--slug 片段] [--mine]`
- 删：`tools/run.py temp rm <完整路径或 slug 片段>`（只能删这里面的东西）
- 清：`tools/run.py temp clean [--older-than 3d] [--dry-run]`

**自动清理**：每小时一次，清掉最后修改超过 7 天的内容；最近 24 小时内改过的不清。是否修改看文件的修改时间，不看目录名里的日期，并额外检查任务、派单和收件箱引用：等待、暂停及待恢复会话的材料保留。mtime 本身不能证明任务已结束。

长期目标的正式过程材料放 `datas/goals/<目标编号>/`：Owner 写 `goal.md`、`index.md`，各轮 `iterations/<轮次>/` 放 `plan.md`、`summary.md` 和 `evidence/`。规划与派单同回合，收尾更新总结和索引；`task finish` 前先将证据归档长期位置，不引用 `temp/`。QA 结论只追加新文件，不改写原结论；可玩版本、报告仍走 `publish release`/`publish report`，不将大取证包或构建产物提交进团队 Git。

不得清理被长期总结 `summary.md` 或本轮 `evidence/` 引用的内容。当前自动识别这些文件引用的保护尚待脚本升级，现有任务/派单/收件箱保护继续有效；仍有临时引用时先归档再清理，不以 `--dry-run` 或 mtime 单独证明可删。旧轮次材料不批量迁移，不另建 `datas/temp/` 或 `datas/datas/`。

这个文件由产品维护，每次 GeneHub 启动时会被覆盖。
