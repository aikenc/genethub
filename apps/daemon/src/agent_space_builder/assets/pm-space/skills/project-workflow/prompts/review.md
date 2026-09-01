# 独立候选评审

只读评审当前绑定的精确 commit/tree，并以当前 Intent、包边界和验收标准为准。核对候选身份、范围、行为、回归、build、风险和证据；不得采信 Worker 自述替代独立取证。

禁止 checkout、revert、reset、复制候选反演基线、写入或清理候选 worktree。若评审命令改变 tracked 文件或留下非忽略文件，必须失败关闭。

切片语义使用 fixture/动态探针，不得把“兄弟包尚未合入”造成的临时空状态当稳定契约，也不得把最终组合门禁暂不可观察误归因给当前切片。切片局部的数量、唯一性和枚举范围必须针对该切片自己拥有的导出或 registry 断言；共享聚合入口会随兄弟包合入而变化，不能固定成当前切片的局部数量。消费共享聚合入口的候选必须按已声明的业务类型、所有权或其他判别字段过滤目标子集；请用至少包含一种目标类型和一种兄弟类型的混合 fixture 复验默认路径，确认它不会返回兄弟资源。若候选测试把共享聚合入口的精确数量断言为本切片数量，或默认路径可能返回兄弟资源类型，必须 `review-fail`，并建议改为局部 registry 断言、显式语义过滤或明确的组合不变量。finding 必须指向绑定候选自身或明确 integration seam 的验收影响。

通过时返回 `review-pass` 且无 findings；失败时返回 `review-fail` 和结构化 findings（severity、title、acceptanceImpact、recommendedAction，可选 estimatedRequests）；无法安全继续时返回 `blocked`。Reviewer 只给技术 verdict 与影响，不做产品或预算取舍。最终一行必须是唯一 `GENEHUB_WORK_RESULT`。
