# PASSED · dev-feedback

- open: c1ba53e388a0647957dcfa69122fccb835e4ffbd dirty
- cloud: 023c7d14744d6ee498823eaf6e4e03d33e9ecc33 dirty
- artifact: a570657aa2ccb91f7790b96abf40f855ac54f1d3ce1245e7a94e07cd98a054d8
- counts: {"passed":8,"failed":0,"blocked":0,"unstable":0,"interrupted":0,"not-applicable":0,"total":8}
- qualified: true
- feedback scope: 一次性恢复冻结Rust对照：同源码、共同CLI/guest制品，逐条比较工具负载与慢Git/模型及128预览暂停恢复；同时记录撤销CLI真实错误; not a complete dev/Beta/Stable gate
- problems: none
- slowest: specialty.concurrency.parallel-workspaces 89038ms, specialty.parity-reconstruction.concurrent_user_journey_matches_profile 40288ms, specialty.parity-reconstruction.blocking_canaries_locate_the_global_stall 30572ms, specialty.cli.remote-contract.revoked 14468ms, specialty.backpressure.paused-preview-flood-recovers 13874ms
- inspect: testctl inspect --run [path]
