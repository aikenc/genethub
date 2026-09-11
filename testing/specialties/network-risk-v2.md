# 网络业务风险专项 v2

本版以公开业务接口、真实浏览器和 OS/磁盘事实覆盖网络故障对业务的影响。
统一选择标签 network-risk-v2；不更改 gate 策略。用 beta 选择器包含 Node 和浏览器，
这是带标签的本地专项选集，不等于完整 Beta 验证，也不执行发布。

## 范围

| 风险面 | 纳入的专项文件/目录 | v2 的补强或保留依据 |
| --- | --- | --- |
| 连接、续传、RTC/Fabric、性能 | connectivity 全部、multichannel 全部 | 新增双通道同时中断、下行丢失、并发保存、离线取消、多订阅隔离；延迟副作用/新身份/真实传输中探针 |
| 权限与授权生命周期 | authorization 全部 | 新增只读凭据续传后仍禁止写入；Hosted 撤权同时检查准入与实际磁盘写入 |
| 服务预览、HTTP/WS、ICE、媒体、进程 | preview 全部 | SSE 验证完整有序 1..5；TURN 错密钥和错机器身份拒绝；真实媒体解码与停止回收保留 |
| 背压和业务并存 | concurrency 全部 | 六客户端测试修正额外准备连接计数；八连接候选要求保留独立测试；控制面/Agent 压力与隔离保留 |
| 用户联调授权、长断网 | client/debug、debug-reconnect | 保留真实页面授权、超过 95 秒掉线、过期队列、不可重放操作、离线撤销及重启 |
| 重启后业务状态 | recovery/daemon-crash、agent/execution-contract | 保留磁盘与原客户端恢复、旧 cursor/新 daemon 生命周期；普通重启增验工作区原身份/名称 |
| 传输边界及双仓合同 | wasm/fabric、contracts/network-baseline、connectivity/resume-core | 保留现有 TLS 起始字节、组件能力与原生性质；真实 Relay/Cloud 合同执行；不冒充端到端质量 |

没有为增加变更数量重写已有独立 oracle。仅增加选集标签的文件表示已纳入审计与回归，
不表示该文件的业务断言已重写。冻结 legacy、发布/安装、非网络业务的完整回归不包含在此标签里。

## 执行

先通过 broker 获取 OPEN/CLOUD 的绝对路径。SPACE 为当前 PipeSpace，runs 必须被 Git 忽略。

    npm --prefix "$OPEN/testing" run typecheck
    npm --prefix "$OPEN/testing" run testctl -- lint --open "$OPEN" --cloud "$CLOUD"
    npm --prefix "$OPEN/testing" run testctl -- governance check --open "$OPEN" --cloud "$CLOUD"
    npm --prefix "$OPEN/testing" run testctl -- plan --open "$OPEN" --cloud "$CLOUD" --gate beta --tags network-risk-v2
    npm --prefix "$OPEN/testing" run testctl -- run --space "$SPACE" --open "$OPEN" --cloud "$CLOUD" --gate beta --tags network-risk-v2 --topic network-v2 --environments 16

通过 testctl inspect --run <绝对 run 路径> --failed 或 --case <ID> 下钻。
不要将网络专项所用 beta 选择器解释成已部署或通过 Beta 全量门禁。

## 环境及证据边界

- Chromium 使用真实 WebRTC。TCP 代理仅改变真实链路，不解析/修改产品加密记录。
- 媒体需 GENEHUB_PREVIEW_MEDIA_PYTHON 指向 Python 3.11+，按产品 demo/requirements.txt 安装 aiohttp/aiortc/numpy/PyAV；缺失必须 blocked。
- 历史兼容需显式匹配的旧 CLI/component。未提供时保持 blocked，不用同一当前版本或协议模拟替代。
- 所有进程、端口、数据库、工作区和授权均 case 独立；原始凭据不落测试产物。
- 原有吞吐目标不降低。8 客户端、5 秒撤权、2 秒小 RPC、5 秒取消回收仍为候选业务标准，尚不等于正式 SLA。
- 公共 package 消费者证明客户端接口行为；仅真实工作台页面/媒体专项证明对应 UI 事实。
- 现有 wasm/fabric 的极小网络对端仅证明握手/首字节，补偿证据是实际 Relay、浏览器和 Hosted 专项；不得当作真实 Relay 端到端成功。
- 移动系统挂起、Safari/WebView、NAT/真实 TURN 数据面、弱网全排列、24 小时 soak、滚动升级双向组合仍需对应载体和环境。短时本机绿色不覆盖这些风险。
- 失败分别归类为产品行为、测试夹具、环境前置，保留首次 run；不得把失败改为预期通过。

## 本轮验证后修正的夹具

- 联调页面的测试时钟在页面加载前安装，确保产品创建的定时器归属一致；仍验证本地时钟到期拒绝，
  不将其当作真实 Hosted 租期测试（Hosted 用例单独等待真实时间）。
- 真实 App host 每次取 endpoint 都通过公开 CLI 取得新的一次性凭据，via 与实际 loopback 入口一致。
  手机尺寸进程列表的服务打开、视频解码和释放仍由原 UI 路径验证。
- 失败消息携带阶段、连接状态或有限的 DOM 控件摘要；取消失败带 procfs 状态和原进程身份比较；
  撤权失败带实际磁盘副作用。并发邀请错误仅记成功/失败状态，不序列化可能包含凭据的结果对象。
