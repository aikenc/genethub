# 应用登记与接入协议 v1

本协议由 daemon 以 Rust 实现，与 Node/Python 无关。外部程序可直接实现；[Python 示例](../assets/python-adapter/app.py) 与 [Node 多后端示例](../assets/node-adapter/run.mjs) 是可选参考源码，不是 GeneHub 运行依赖。

## 登记与发现

源电脑程序启动并就绪后，在**目标 daemon 的实际私有数据目录**的 `service-previews/` 中登记。不要把私有登记写进工作区，也不要在聊天输出文件内容。

- `entry`：已存在的工作区 HTML 文件的真实绝对路径。Windows 计算键时去掉扩展路径前缀并将反斜杠转 `/`。
- 文件名：`sha256(规范化 entry 的 UTF-8).hexdigest() + ".json"`。
- 目录仅所有者访问；文件仅所有者读写；禁止符号链接。JSON 不超过 16 KiB。
- 用新建私有临时文件与不覆盖式原子发布，避免覆盖另一运行；退出时只删除自己 runId 对应的登记。
- 同一入口一次运行；重启生成新的 runId 和 secret。旧登记残留时先核实源程序已退出，再显式清理，不能盲目覆盖。

字段：

| 字段 | 内容 |
|---|---|
| version | 整数 1 |
| entry | 上述入口路径 |
| runId | 16 随机字节的 32 字符小写 hex |
| secret | 32 随机字节的 64 字符小写 hex；私有认证材料 |
| port | 应用协议 WebSocket 的 loopback 监听端口 |
| name | 显示名称，最多 120 字符 |
| routes | `[{prefix:"/api/example/",websocket:true}]`，只声明应用实际提供的路径 |
| media | 无媒体时 null；否则 `{offerPath,stopPath,microphone:"none"或"webrtc"}` |
| iceServers | 无自定义配置时 `[]` |
| dataPolicy | `auto` 或 `direct-only`，只约束业务数据传输 |
| pid | 可选，当前登记程序真实 PID；新版后台运行列表使用它关联进程树，不作为终止授权 |
| control | 可选，默认 false；true 表示实现下述认证 shutdown，只清理自己管理的程序 |

Workspace 由入口在已登记工作区根目录内的归属确定。Session 来自已有进程追踪，无法确认时显示外部程序登记，不伪造会话 ID。列表仅输出净化后的入口、名称、runId、可达情况和停止能力；不会输出 secret/port。

## 认证 WebSocket

应用监听 `ws://127.0.0.1:<port>/`，拒绝带 Origin 的握手。所有消息使用二进制 WebSocket frame：

- `0x00 + UTF-8 JSON`：控制消息；
- `0x01 + 原始字节`：业务数据；
- 单独 `0x02`：daemon 对已消费应用响应包的 ACK。

一包最多 256 KiB，包括类型字节。**这里没有四字节长度前缀**；长度前缀属于 GeneHub 数据面与客户端之间的另一层封装。

认证顺序（5 秒内完成）：

1. daemon 发 `{nonce}`，nonce 为 64 字符随机 hex。
2. 应用发 `{proof:HMAC_SHA256(secret文本, "server:"+nonce+":"+runId)的hex}`。
3. daemon 发 `{proof:HMAC_SHA256(secret文本, "client:"+nonce+":"+runId)的hex}`。
4. 应用恒定时间校验后发 `{kind:"ready"}`。

secret 的 UTF-8 文本本身作为 key，**不先解 hex**。认证失败关闭连接。describe/ice 探测可能在认证完成后立即关闭，这不代表应用应退出。

## HTTP、流式响应与 WebSocket

一次认证连接只承载一次操作：

- HTTP 开始：`{kind:"http",method,path,headers}`；接若干二进制业务包；`{kind:"end"}` 表示请求体结束。
- HTTP 响应：`{kind:"head",status,headers}`；接若干二进制业务包；`{kind:"end"}` 结束。
- WS 开始：`{kind:"ws",path}`；应用确认 `{kind:"open"}`。
- WS 文本：`{kind:"text",text}`；二进制用 `0x01` 包；关闭用 `{kind:"close",code,reason}`。

认证之后，应用每发一个业务响应包，应等待 daemon 的 ACK 再继续。ACK 必须独立于请求处理消费，避免同时收发时死锁。认证包和 shutdown 确认不等待 ACK。

限制请求体 8 MiB、单包 256 KiB、桥连接一小时、慢消费等待 30 秒，并限制连接数与队列。只允许声明的路由；规范化并校验路径，禁止逃逸。禁止任意 URL 代理、重定向跟随、Cookie/Authorization 透传。写操作不自动重试。取消或断线后应结束本次操作。

## 应用停止与媒体释放

`control:true` 的应用可在认证完成后收到 `{kind:"shutdown"}`，返回 `{kind:"stopping"}` 后正常退出，清理自己启动并管理的后端、媒体会话和登记。daemon 会重新读取并校验请求中的 runId；不能对替换后的新一代发送旧停止请求。

仅附着用户已打开的软件时，不应声明可关闭该软件。停止按钮的含义由应用管理权决定，不因登记 PID 而扩大。

媒体继续使用 [媒体契约](media-contract.md)。WebRTC 音视频不经业务桥转发。媒体会话应有显式 stop、失败回收和失联到期策略；页面关闭或数据连接断开不能替代后端会话释放机制。

## 后台进程面板

新客户端通过 `process.services.v1` feature 使用工作区进程列表。这是停止应用和排障入口，不是用户打开预览的主路径；主路径是聊天里的入口 HTML 链接。服务节点关联进程树，支持时提供“停止应用”。进程存活与服务可达分别判断。运行换代后在预览中点“重新检查服务”。

普通应用无需自己实现 GeneHub 客户端 RPC；它只需实现本页的本机登记与协议。不要在 iframe 中嵌入 daemon 客户端或私有凭证。
