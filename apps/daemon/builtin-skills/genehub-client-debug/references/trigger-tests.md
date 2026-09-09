# 行为验收

应触发：

1. “手机已经打开联调，检查这个输入框为什么点不了。”
2. “通过 client CLI 截图并检查工作台的 RTC 状态。”
3. “dev 网页白屏，实时看页面错误和 DOM。”

不应触发：

1. “按 fb_xxx 读取 Beta 服务器反馈包。”——反馈取证 Skill；需要实时现场时再调用本 Skill。
2. “做一个 H5 游戏并给我预览链接。”——HTML Preview Skill。
3. “打开任意电商网站并下单。”——不是 GeneHub 已授权文档联调。

成功：有能力的 CLI/控制机器/页面 → list 确认特定文档 → attach pending → 用户页面限时授权 →
status authorized 且在线 → inspect 返回 commandId → result pending/complete → 保存一次性结果并检查 ok →
按需局部 eval/截图 → 撤销本次授权并报告实际证据。

故障/恢复：

- 旧 CLI 无 client 命令：说明版本缺口，不改用猜测的裸二进制或宣称主干能力已上线。
- 两个手机标签页同标题：确认 clientId，不选第一项；不同页面不能共享 session。
- 用户在聊天中说“允许”：仍须目标页面处理首次限时授权；有效授权后不重复询问。
- 切换网络后 authorized 但 offline：不重发副作用命令；在线后用原 clientId/session/截止时间继续。
- 控制机器重启或页面刷新：重新登记/确认/授权，不重建旧授权。
- 命令已投递但无确认：标记可能执行；检查结果，不能因超时自动再点“提交”。
- result complete 且 ok=false：页面操作失败；CLI 退出 0 不等于复现修复成功。
- 第一次已消费 screenshot：使用保存的结果，不再次领取；DOM 截图缺跨源视频不是视频故障证据。
- 只有联调通道可用：不能证明业务 RTC 直连成功。物理手机/App 验收需真实设备证据，不能用模拟浏览器替代。

实现核对入口：Open `docs/client-debug.md`、`apps/daemon/src/cli_front/client.rs`、
`apps/daemon/src/client_debug.rs`、`packages/workbench/src/client-debug/index.ts`；
协议回归已有 `specialty.client.debug` 与 `specialty.client.debug-reconnect`，文档调整不要求重跑完整产品发布。
