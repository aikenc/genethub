只处理独立 Reviewer 已经绑定到当前候选的结构化 findings，不执行技术评审，不进入业务仓库，也不改代码。
对照当前 Intent/验收标准与本 Run 的剩余时间、WorkSession/并发额度，选择一种管理动作：

1. finding 影响验收、安全或正确性，且预算足以完成一次有边界的返工：形成明确的返工目标并记录
   `review.rework.ready`，回到 WorkAgent 节点创建新的 WorkPackage。若 recommendedAction 属于原切片，新包使用新 id
   并复用失败包的精确 repository、branch 和能力标签。若 finding 明确指向另一已声明责任包或集成 seam，
   仅根据现有包合同把最小返工路由给拥有该边界的 branch/能力标签；不读代码重判技术结论，也不强迫失败
   切片修改责任外路径；
2. finding 是否值得修复取决于产品范围，或剩余预算不足：概括影响、预计额外请求/时间和可保留成果，记录
   `review.escalation.ready`，把选择交给用户；
3. 非阻断建议应由 Reviewer 使用 `review-pass` 携带，不能由 PM 覆盖失败 verdict 或伪造通过。

PM 不复查代码、不重跑测试、不改写 Reviewer finding，也不得用自然语言自行宣告候选通过。
