只处理当前 Run 中已经通过独立评审并进入 Accepted 的候选。逐个执行
`genet pm project package integrate --id <package-id>`；Coordinator 会复验候选 commit/tree、评审绑定、
干净本地 `main` 与合并后的祖先关系，并串行写入类型化集成证据。不要创建集成 WorkPackage/WorkSession，
不要让 WorkAgent 执行机械 Git 合并，也不要进入业务仓库。发生冲突或基线不干净时，Coordinator 会持久化
失败证据并自动派生 `integration.blocked` 进入恢复路径；不要自行补写事实，不得把失败当作已交付。
