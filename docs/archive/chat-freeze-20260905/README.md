# 聊天卡死旧批次归档（2026-09-05）

本目录保存旧批次的论证和测试证据。旧提案按原始字节保留；其中互相矛盾或已推翻的结论不作为新实现依据。归档不宣称旧批次已完成系统性验收。

- [旧提案原文](proposal-v3.md)：原文件位于 dev-chat Space，归档前未纳入 Git。原有相对链接按原 Space 解释。
- [证据清单](evidence.json)：八次关键 run 的源文件 SHA-256、代码身份、原始计数、资格判定及 case 集。移除机器绝对路径，完整失败日志仍由原 Space 的 testctl run 保管。
- 两仓归档分支均为 `archives/chat-freeze-20260905`；Open 指向 `2aa120f985ed779f0d6e7c3f32fffe1166147c88`，Cloud 指向 `3492d4b8a512ce6497d0c57c4fc624f70b5334ce`。原 dev-chat 分支保留。
- 新批次基于 Open main `bc7e908f973c63300aaa63412619f5271dbbbca6` 与 Cloud main `5a3f15afa0fb811d16737607eda3642761dc9990`，已包含旧批次代码。

## 证据的适用范围

正常退出和崩溃丢回答的旧用例确有先失败后通过的记录。最终 merge run 仍为 failed：379 passed、6 failed、2 blocked，qualification 为 false。失败 case 集合与此前基线一致，不能据此宣称门禁通过，也不能据一次洪水用例通过排除所有事件交错风险。

旧 manifest 的 artifact 只标识薄 CLI；不能用它证明当时 guest 的精确内容。部分 run 的工作树为 dirty，其摘要不包含可重建的完整补丁。这些证据只用于历史追溯，不复用为新候选资格。

新批次仍需验证启动与取消交错、旧执行迟到、同一客户端的游标恢复、静默前最后一批输出的检查点，以及完成记录与检查点删除的持久性顺序。崩溃后历史轮次缺 outcome 在现有读取中显示 Failed，并非永久 Running 的证据。
