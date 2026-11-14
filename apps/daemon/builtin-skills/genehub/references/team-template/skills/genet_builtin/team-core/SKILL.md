---
name: team-core
description: 团队共同约定：真实目标、异步接力、原编号恢复、证据和控制边界。
---

# 团队共同约定

流程服务用户满意；明显损害用户时在原授权内调整，记录偏离原因；发现不满先留原信号再处理。

团队根有 tools/run.py；用消息中的团队根定位，不猜当前目录。日常命令以 `"$GENEHUB_PYTHON" <团队根>/tools/run.py` 开头，只需五个入口：

| 命令 | 用途 |
| --- | --- |
| `task start` | 前台把明确交付或持续目标交给 Owner |
| `task support` | 请求独立支持，结果回精确请求会话 |
| `task send` | 给原 Owner 追加意图；受理不等于恢复或完成 |
| `task finish` | 提交本会话真实结论与持久证据 |
| `task status` | 沿原编号读取状态；未知不换号重派 |

参数、预算、控制、后台作业按需读 [task-options.md](references/task-options.md)；工作合同见 [task-owner.md](references/task-owner.md)。未遇到维护问题无需读维护参考。

- 前台按完成方式选择路径：简单答复直接做；一次交付交给 Owner；持续质量线交给长期目标 Owner。分不清从小开始，只升不降，不向用户讲内部分类。
- 派单是纯异步：一次派出全部可开工项后结束本轮，不 sleep、不轮询、不用常驻 Agent 等待。结果由 timer 接力；普通回复不代表结算，接收不等于成功。
- 原 taskId、机器、输入、控制、累计投入、结果路由和资源回执沿用；未知先核原编号，不猜最近会话、不重跑已完成副作用。成功须实际交付、必需支持结算且已投递结果读入。
- 普通通知不解除用户暂停；失败状态通知不是业务成果。明确暂停/取消、权限、总预算与期限仍须遵守，不能换号、换 SID 或模型绕过。
- 后台不挂起等用户。日常取舍由 Owner 在原授权内决定；重大风险带当前方案合并同步，继续其它工作。红线立即优先纠正，归因不明先由任务 Owner 核查；缺平台证据才记平台归因，不假设产品里另有接手岗位。
- 原生事实、对话与 ghref 是依据；来源为脚本或 Agent 的消息不是 Human 新批准。命令行用绑定的 `"$GENEHUB_CLI"`，不猜另一渠道。历史有界分页，读取失败为未知。
- 改源文件，build 后才更新身份/完整制品，不改生成身份。Skill 只对新会话生效；前台显式交接，Owner 在本轮结果读入后同机交接，旧 Owner 不派新单、不清历史债务。
- 临时实验与正式证据分开；结论先归档，不能引用可清理临时区。预览只链接已存在的入口文件，遵守 genehub-preview。用户沟通只说体验、进展、结论和产物。
- 二级记忆：根 memory.md 留跨角色铁律（≤30行）；岗位 index.md 留复发经验与 ghref 指针，不复制会话。无新信号不写巡查报告。

按需参考：[任务参数](references/task-options.md)、[维护与查询](references/team-maintenance.md)、[质量口径](references/quality.md)、[模型](references/models.md)、[跨机](references/remote-targets.md)、[暂停恢复](references/resume-paused.md)、[业务扩展](references/extensions.md)。

长度按 Unicode 字符计（含空白）：本 Skill≤2200，本队岗位 Skill≤1500，task-owner.md≤4000，quality.md≤3000，其余 reference≤6000；编译指令≤32KiB。不要靠超长单行或把整份按需参考改为必读规避。
