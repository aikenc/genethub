# PASSED · dev-feedback

- open: c1ba53e388a0647957dcfa69122fccb835e4ffbd dirty
- cloud: 023c7d14744d6ee498823eaf6e4e03d33e9ecc33 dirty
- artifact: a570657aa2ccb91f7790b96abf40f855ac54f1d3ce1245e7a94e07cd98a054d8
- counts: {"passed":9,"failed":0,"blocked":0,"unstable":0,"interrupted":0,"not-applicable":0,"total":9}
- qualified: true
- feedback scope: CLI七条冻结Rust与TS共享当前CLI/guest对照，接管四条CLI契约；混合旧Speech与坏pipeSpaces失败保持原文，确认后删除helper; not a complete dev/Beta/Stable gate
- problems: none
- slowest: specialty.parity-reconstruction.cli-remote 27084ms, specialty.cli.remote-contract.shell-io 17884ms, specialty.cli.remote-contract.background-replay 16377ms, specialty.cli.remote-contract.stale-identity 15906ms, specialty.cli.remote-contract.revoked 15750ms
- inspect: testctl inspect --run [path]
