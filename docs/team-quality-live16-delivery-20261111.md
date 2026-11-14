# dev.16：远端协议诊断与原任务验证

> 历史提案/交付记录：保留当时的事实、原口径与回执，不代表当前实施状态。工作合同以 [团队机制](teams.md) 及后续已批准决定为准；其中已被取代的人工解除、重开测量窗口、前台驱动续轮等旧规则不再适用。

北京时间2026-11-11 11:52的增量记录，延续[dev.13–15记录](team-quality-live13-15-delivery-20261111.md)。[本期目标](team-quality-80-goal-20261111.md)及截止2026-11-12 00:36:13.969不变。两队仍未达成连续三个不同小时正式原生卡≥80。

## 影响、修复与防复发

DS原远程任务长期显示“远端接单结果未确认”，实际接收程序缺少必要的 `--require-prepare-settlement` 参数。模糊错误不能帮助团队判断同步升级的必要性。dev.16在有完整远程退出结果、退出码2、接收stdout为空且stderr明确拒绝本次实际携带的已知必要协议参数时，返回 `REMOTE_PROTOCOL_UNSUPPORTED` 和具体参数名。其他错误继续保持未知；不回显原始stderr、不清理意图、不创建会话或重发业务。

非本项目的真实双daemon夹具使用独立旧CLI语法包装器复现：修复前 `261111-1135-remote-protocol-red-a405` 准确失败；修复后 `261111-1138-remote-protocol-fixed-9393` 及精确提交 `261111-1141-remote-protocol-committed-e997` 均2/2通过、无输入漂移。覆盖非特定错误不泄漏、原意图/写者占用/原生会话数不变，以及后续正常结算与暂停请求方恢复。lint/governance通过。只执行必要dev-feedback，未执行完整dev、merge、Beta或Stable门禁。

## 发布与采用

- 产品提交：`91e2fed594c43e5912dd86aae371ba1dec9f7613`；受控封印 `32ffa69f2254dd45fd5dbeec887d702d5f4e5b824ee4a40cc589c3f199fd27a3`。
- 测试及Open构建提交：`251a0992c4b6bcb367d58e8072631d253111fdfc`；封印 `60e87b9c99cae5b2420a7632aad7b37a36c2e1c9ed81ddfcb8e82f90c2a1dd9b`。均已推送dev-2，Cloud仍为 `e7dd53ea04bbddefcb6bf4622cc206b3312c7efc`。
- dev.16 guest：SHA256 `6919c9a8e931b70a932785339a701d953475e08a5d25b3c9010d9653d326e400`，31,806,881字节；构建回执 `a3ab7e3c635fdbfc22875fcde457ac8aa6f8935e2e63073a274ee66a7f114130`。
- Mac传输 `tr_7a34e4eff3b7462b905af03082a85db3` 已完成且摘要相符，11:50:34沿原guest watcher原子替换，保留dev.15。原宿主、ABI与设备指纹不变，未人工重启；宿主仍是此前实测的ad-hoc/cdhash-only程序。
- 源机与Mac实际context均为dev.16，六个公共模块摘要匹配；team.py为 `11922b6ab3d9314cc451840054e0479464c942457eefb29ce050876abb107655`。独立控制shell及嵌套官方identity/liveness/smoke均退出0，原supervisor与Fabric v4普通会话、页面和跨项目smoke通过。

两队自行合入公共变化，保留定制。11:51只读核验DS原操作 `taskop.1dfa3f37ad2c28326a439948784bdf96f7bf78404567fbd44d3493f55e9f94d9`：状态仍为creating，但在 `1794368976053` 已记录“远端运行时不支持协议参数 --require-prepare-settlement，需同步升级”。这证明诊断修复已在原场景生效；DS远端仍旧，原结算没有完成。平台guest更新、团队源端采用和团队远端同步分别验收。观察者未替团队改文件、tick、重派或催办。

## dev.13–15的新增原生证据

HY原操作 `taskop.a2704c21a8e7af748ea36fdaaee048044bcd9923ec5b4918839fe694aa584e36` 的not-created围栏仍在。新增原生回执证明结果 `x.36d9625db163aa3d0e546841` 于 `1794367638384` 收到、`1794367641521` 送达并读入原请求方，关联原生turn为 `turn_1c84d00d9b7343c79574f4a64e93646a`。因此11:29旧记录中的“尚待证明读入”已补证；没有重发结果，也没有抹掉历史R1失分。

11:36–11:37读取团队自行生成的11:00小时修订卡及冻结事实，均与原生安装评分器重算一致：

| 团队 | 闭环项/已知权重 | 暂定分 | 仍未知的红线 | 修复的真实效果 |
| --- | --- | --- | --- | --- |
| XWorld-ds | 71 / 90% | 42.497 | R6 | dev.15使无资源工作不再误报R5未知；R5已可判且未触发 |
| XWorld-hy | 22 / 65% | 0 | R5 | dev.14排除旧暂停项后R6上界1.7333，小于2，红线可判且触发；真实资源归还时间不明仍保留 |

两个旧暂停工作在冻结事实中均为active空、整个10:00–11:00区间excluded，未把暂停当有效工作。DS的R6区间仍跨2，保持未知；HY没有因修复而变高分。原事实摘要DS为 `e1bd4dc275373e8c30ff00f9bb77a0bd7bc43ed4351d28c076a0a9f76c14a7c6`，HY为 `37506ee286d3f94f69e25e3cdb05a634cc4514dd4fcd097de090ab625a8cbb86`。同一小时修订卡不计作多个小时，旧卡保留。

## 后续验收与证据位置

继续核验DS自主远端同步后的原意图结算，及新小时原生卡的正式资格、失分和连续性。诊断修复已经完成；两队质量80目标尚未完成。对团队只按用户可见业务目标和体验交流，平台侧分析和修复通用机制；本轮没有新增团队消息，也未改团队或项目仓。

原dev-2任务库保留 `team-remote-protocol-diagnostic-20261111/live16-delivery-proof.json`、原定向run与发布回执。主任务 `team-experiments-ds-hy-20261110` 内的 `source-team-protocol-adoption-1153.json`、`hy-original-settlement-native-1146.json`、`native-paused-activity-proof-1136.json`、`native-latest-quality-1137.json` 分别提供原任务诊断、结果读入、暂停排除和冻结卡证据。这些文件名是稳定取证编号，事件时间以回执字段为准。
