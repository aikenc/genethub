# dev.17：让协议诊断进入团队反思

北京时间2026-11-11 12:20的增量记录，延续[dev.16记录](team-quality-live16-delivery-20261111.md)。[本期目标](team-quality-80-goal-20261111.md)及截止2026-11-12 00:36:13.969不变；两队质量80目标仍未完成。

## 影响、修复与验证

DS原远程派单虽已记录准确的协议缺失原因，但任务状态、反思简报和待处理notes都没有呈现它。dev.17在保存原派单意图后，将经过验证的 `REMOTE_PROTOCOL_UNSUPPORTED` 写入现有反思notes，按原操作和诊断去重。重复检查沿用同一条记录，已处理记录也不重建；不回显任意stderr、不清理资源、不重派业务或唤醒岗位，不新增团队工作流。

非本项目的真实双daemon/relay/CLI夹具，从公开 `notes ls` 验证错误可见、重复检查记录ID不变、普通错误不混入、原意图和目标写者/会话数不变，并覆盖后续正常结算与显式暂停恢复。原失败 `261111-1157-protocol-visibility-red-8faa` 精确报缺少诊断记录；隔离后 `261111-1206-protocol-visibility-isolated-4650` 和精确提交 `261111-1214-protocol-visibility-committed-53a6` 均2/2、dev-feedback qualified、无输入漂移。lint/governance通过。只运行必要定向范围，未执行完整dev/merge/Beta/Stable门禁。

`261111-1200-protocol-visibility-fixed-aef6` 行为2/2通过，但有其他开发会话写入预览代码造成inputDrift，不计候选合格。已由该任务所属Agent移走其改动，我们保留本候选并重新验证；没有覆盖他人改动或将预览代码混入发布。

## 提交与真实发布

- 产品 `2c321d99cde171dbdf468fd1f9e346f5b11db31b`，受控封印 `3f048cb292b01928065a79d4a18df2f0e6765a8c5a541c3fbc56b93925e02766`。
- 测试/Open构建 `08a00a2356c78d80a2f7788c1b275837cf84158b`，封印 `46375e42cc2e5182a5824e6ae9eea7ca4ca5a167f7d962eb742dca87584ad278`；已push dev-2。Cloud保持 `e7dd53ea04bbddefcb6bf4622cc206b3312c7efc`。
- dev.17签名guest `a94ead31b88672744cf5c0f96aa3d467ac3bcd5b8f888ff3d26e53ce8a66d0c3`，31,807,713字节；构建回执 `f90336380bc80c831c834f6d2de97b39d51690c522463cd5712c21d532a4c51c`。
- Mac原传输 `tr_c424936950654a3780537f13873d8648` 完成且摘要一致，沿原guest watcher原子替换，保留dev.16。宿主、ABI、设备ID和指纹不变，未发信号或手动重启。
- 源机和Mac实际context均为dev.17，六个公共模块摘要相符；本次tasks.py摘要 `f6cb69400673acb92ec4a63ebde00b34470b8ac90b06d53e578c2b767714226a`。正式smoke验证原supervisor 2950753脱离启动会话存活、Fabric v4普通会话/页面/跨项目路径；独立Beta控制shell及内层命令均退出0。

平台安装完成不等于团队已经采用。12:20读取DS原 `taskop.1dfa3f37ad2c28326a439948784bdf96f7bf78404567fbd44d3493f55e9f94d9` 仍creating，最新简报及notes还没有新诊断；继续等待团队自主合入、核对原操作，不由观察者修改Team或项目仓、tick、重派或催办。本轮未发团队业务消息。只向另一开发任务发送过一条明确Agent来源的槽位冲突协调消息。

## 最新原生小时卡与待查问题

12:14只读取得的11:00–12:00最新修订卡与原生安装评分器重算一致，capture身份均正确：

| 团队 | 闭环项 / 已知权重 | 暂定分 | 未知红线 |
| --- | --- | --- | --- |
| XWorld-ds | 74 / 90% | 42.1 | R6 |
| XWorld-hy | 24 / 90% | 35.23 | R3、R5、R6 |

两队均无正式分。同一小时多张修订卡只算一个小时；没有三张不同连续小时正式80分的完成证据。DS有效在途均值区间1.3596–3.3176，HY为0.6239–2.4498，均跨阈值2，保留未知。历史R1失分不随发布清零。

HY另有结果送达证据缺口：原工作会话 `s_a54fcda519ffd1c82139a9ebd8f095ad` 的结果 `x.416b046f206046c6799e611a` 有团队input-accepted事件和原请求方原生历史正文，但当前原生retainedInputs中没有该ID、rounds中也没有对应轮次。正文不含接收时间，不能把观察时间伪作精确送达时间，也不能宣称已读。该会话35条保留回执中仅两个历史输入缺失，尚在调查原因；未重发输入、未修改评分事实或门槛。

## 证据与下一验收

原dev-2任务库 `team-protocol-diagnostic-visibility-20261111` 保存发布、Mac应用、实际采用与smoke合成证据 `live17-delivery-proof.json`；测试任务库保存失败、漂移及有效run。主任务库保存 `native-latest-quality-1215.json`、`protocol-diagnostic-visibility-1220.json`、`hy-native-receipt-gaps-1217.json` 和 `hy-gap-neighbors-1222.json`。文件名为取证编号，实际时间以字段为准。

下一步：核对DS自主采用后的原notes/简报及远端同步结算；查明HY原生输入回执缺口；按原预算继续读取正式小时卡，不用构建、发布、在线或暂定分代替完成。
