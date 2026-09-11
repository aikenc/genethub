# 多通道网络业务专项

状态：已建立可执行专项；是否合格以精确输入对应的 testctl manifest 为准，失败用例不作为预期成功。
本轮仅测试工程，不修改产品行为。规范沿用配对 Cloud 的 testing engineering principles/laws。

## 入口与使用

专用 gate：`specialty:multichannel`。v2 共 26 个独立 case（v1 的 19 个加 7 个新用例）；既有 ID 和失败历史保持。
从当前 Space 执行，先 plan、确认非空选集，再 run：

```bash
npm --prefix "$OPEN/testing" run testctl -- plan --open "$OPEN" --cloud "$CLOUD" --gate specialty:multichannel --tags multichannel
npm --prefix "$OPEN/testing" run testctl -- run --space "$SPACE" --open "$OPEN" --cloud "$CLOUD" --gate specialty:multichannel --tags multichannel --topic multichannel --environments 16
```

OPEN/CLOUD 必须采用 worktree broker 的绝对路径，SPACE 为当前 Space。多个 tag 要重复传 `--tags`，不能逗号拼接。
浏览器用例需要真实 Chromium。Hosted 使用真实 Cloud、Relay、CLI 配对和 session HTTP API。
历史版本用例需要显式指定配套的 `GENEHUB_MULTICHANNEL_PREVIOUS_CLI` 和 `GENEHUB_MULTICHANNEL_PREVIOUS_COMPONENT`，缺失或整套与当前产物字节相同为 blocked。
旧 CLI/component 在独立数据目录启动真实 coordinator；两项旧产物哈希写入 case 证据；该环境变量不代表已批准任何兼容策略。

新增 gate 只选择 multichannel 标签，不改变原 change/browser 分流，不把专项资格作为发布资格。
所有新增 case 在该 gate 下 required；不得因已知缺陷转为 skip 或 expected-pass。
现有发布 gate 对新 case 的选择仍依照统一 policy，缺前置或断言失败不能资格通过。

## 业务契约与候选指标

默认业务负载通过 `@genehub/workbench/client`、真实 CLI、Hub HTTP 和注册服务接口发起。
真实工作台使用同一个 Client；不 import 产品私有实现，不调用 Journal/Registry/attach 内部接口。
协议性质测试保持独立；精确控制帧丢失由已有性质测试补偿，不通过解密网络代理伪造黑盒故障。

候选指标（用于暴露需求缺口，尚不表示正式 SLA）：

- 8 条普通业务连接：对应“两设备各四个标签页”的最低容量探针；不是 8 个 RTC 标签页完整容量证明。
- 撤权 5 秒内停止已有访问；至少不得超过原授权租期再加 5 秒容差。
- 60 秒恢复窗口；该窗口不延长业务 deadline。
- 本地慢消费者并存时小 RPC <2 秒，取消后生产者进程 <5 秒回收。
- 10 轮预热后 60 轮客户端建立/关闭，RSS 增量≤64 MiB、FD 增量≤8。
- 既有 neteff 原阈值保持不变。

这些值是显式候选验收指标，不能根据本轮实现上限改小来制造绿色。
60 轮 churn 是有界资源回归，不替代 24 小时 soak，也不证明无限时间无泄漏。

## 场景与证据

| 提案范围 | 可执行 case（省略 specialty.multichannel. 前缀） | 独立业务事实 |
| --- | --- | --- |
| N01/N02/N03 RTC 升级/回退/Relay 故障 | 既有 connectivity.rtc-subscription-ownership | 真实浏览器完成事件、订阅、取消、Relay 暂停和 native RTC 关闭；原 ID、无重订阅 |
| N04 单路径与反复断链 | 既有 connectivity.logical-resume；repeated-loss-one-operation | 真实进程磁盘启动标记一次、完整 stdout、恢复后 RPC |
| N05 恢复期限和业务期限 | recovery-expiry-terminal；deadline-includes-outage | 原流终态、无业务重发、超时后无延迟副作用 |
| N06 业务操作并存与取消 | file-write-under-loss；pty-retains-session；slow-stream-cancel-fairness | 256 KiB 真实传输后断链、1 MiB 文件逐字相等；PTY 环境变量保留；真实 PID 回收 |
| N07 受限服务恢复 | direct-preview-resume | 真实 runner 注册，原 HTTP 响应 20 个片段完整，后端只收到一次请求 |
| N08 撤权 | hosted-live-revocation；hosted-revoked-lease-expiry | 真实来源 session 撤销后，已有 RTC 的公开 RPC 被拒绝 |
| N09 续期 | hosted-lease-renewal | 跨真实短租期、原订阅事件持续、未重建；必须观察到新 admission 发行，不能把错误持续放行当续期 |
| N10 并存与容量回收 | capacity-eight-clients；closed-client-releases-capacity | admitted/usable 数；12 次关闭后能再次接入 |
| N11 公平性与吞吐 | slow-stream-cancel-fairness；既有两项 neteff | RPC 延迟、取消进程事实、同链路 TCP 对照与字节正确性 |
| N12 资源 | connection-churn-resources | 同一真实 daemon 的 OS RSS/FD；逐轮公共 RPC |
| N13 实际 CLI | native-cli-resume | CLI 自己配对、执行命令、输出与退出状态；不拿 TS shell 流冒充 CLI |

## 故障真实性与隔离

TCP driver 只转发不透明字节，故障可以断开所有当前 socket、拒绝新 socket、或在指定上行或下行字节数后断开。
本地 WebSocket URL 含一次性 admission：每次重拨只改新 URL 的 authority，保留 URL/query 与 server proof 配对。
不能复用旧 URL，也不能将 local CLI admission 当成可长期保存的 remote endpoint。
CLI 远程目标使用真实 Relay rendezvous。

浏览器通过公共 Client 开关 RTC；实际断链由原生 RTCPeerConnection.close 注入，原生实现未被替换。
Hosted 生命周期通过可配置真实 60 秒租期和公开 session revoke，不改数据库、不改系统时钟。
服务 fixture 是 runner 启动的真实 HTTP 应用，用磁盘请求记录作为重执行业务的独立 oracle。

每 case 独立 testctl 环境、进程、目录、端口、Hub 数据库和凭据；凭据只驻内存。
Node 业务无需浏览器；RTC browser 和 neteff heavy 分别使用声明资源池。
worker 意外退出记录有界栈位置与退出码，不写原始 stdout/stderr 或 credential-bearing 错误文本。

## 尚未被本矩阵完整证明的范围

- N01–N04 有真实交叉载体回归，但新增 both-paths-subscription 覆盖两条通道同时中断及原订阅恢复；超过保留期限的双通道组合、移动 OS 后台挂起/NAT 变化尚非全排列。
- N07 原流恢复与禁止降级是不同契约；现有 core policy 断言保留，本 case 不声称完成网络内容泄漏审计。
- N12 没有用 60 轮测试冒充长时间 soak。24 小时、真实广域网和更多慢流组合仍需专项资源与正式阈值。
- N13 App 原生壳/移动端尚未进入本次 Linux 载体范围。
- 当前消费者跨一个租期的测试不是多天授权生命周期证明。

## 判定与交付

报告逐项区分产品断言失败、测试夹具失败、前置 blocked 和通过。
“测试写好了并跑出缺陷”可以交付为 local-change，但不允许称为绿色候选或可发布产品。
产品修复进入独立任务/提交，保留本次失败 run，再用同一个业务断言复验。


## v2 业务风险补强

新增 response-loss-one-execution、concurrent-writes-under-loss、offline-cancel-no-side-effect、
subscriptions-isolated-under-loss、both-paths-subscription、revoked-write-fabric、revoked-write-rtc。
分别证明下行丢失时单次执行、并发保存不串数据、离线取消无延迟副作用、多订阅隔离、双通道恢复、
撤权后的 Fabric/RTC 写入权限。所有故障验证实际连接/字节变化；副作用由真实磁盘核对。

已有 deadline 用例等待到危险副作用本应发生之后再断言；expiry 额外验证旧逻辑身份不复活；
取消用例通过 Linux procfs 的启动时间识别原进程，并区分继续运行和 zombie 未回收；
Hosted 撤权独立验证新准入被 401/403 拒绝；吞吐公平性探针确认真实数据已在传且尚未完成。
完整相邻专项范围、命令及限制见 [网络风险 v2](../network-risk-v2.md)。

旧版兼容不属于当前业务要求；previous-cli-current-daemon 已移出验收，历史 run 保留原始阻断记录。
