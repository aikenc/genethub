# temp：随时会被清理的临时区

**这里的东西随时可能被清理，不要把重要的东西放在这里。** 要保留的项目或资料搬到 `datas/`，结论写进 `memory.md`。

所有会话都可以读写。命名统一为 `temp/YYMMDD/hhmm_slug_hash4`，全部通过 `tools/expert.py temp …` 完成，不要手工 `mkdir`、`rm -rf`：

- 新建：`tools/expert.py temp new <slug> --purpose "一句话说明用途"`，打印出绝对路径，在里面工作。slug 只用小写字母、数字、连字符（如 `fix-login`、`review-pr-42`），要能看出用途；中文写进 `--purpose`。
- 查：`tools/expert.py temp ls [--date YYMMDD] [--slug 片段] [--mine]`
- 删：`tools/expert.py temp rm <完整路径或 slug 片段>`（只能删这里面的东西）
- 清：`tools/expert.py temp clean [--older-than 3d] [--dry-run]`

**自动清理**：每小时一次，清掉最后修改超过 7 天的内容；最近 24 小时内改过的不清。是否修改看文件的修改时间，不看目录名里的日期，所以还在用的东西不会被清走。

这个文件由产品维护，每次 GeneHub 启动时会被覆盖。
