在租用的 worktree 中自主完成整个结果型工作包，直至形成干净候选或遇到具体阻塞。内部 checkpoint 只用于恢复，
不等待 PM 逐步批准。最终返回执行过的验证、产物摘要、已知限制、合同变化和简洁结论；候选 commit/tree 由
Coordinator 从干净 worktree 直接推导并校验，WorkAgent 不负责搬运或声明这些身份。运行中不要用自然语言进度
代替候选事实。
