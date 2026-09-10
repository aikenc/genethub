# 客户端联调

Agent 操作入口是产品内置 [genehub-client-debug Skill](../apps/daemon/builtin-skills/genehub-client-debug/SKILL.md)，
随 daemon 自动收录到内置目录。它适用于 dev/Beta/Stable，独立于反馈取证与发布流程。

浏览器、手机和桌面 App 的客户端使用同一套联调运行时，不按 Stable/Beta 分支隐藏。
在工作台「工具」里点“联调”，选择一台自己有权限连接的控制机器，点击连接。控制机器需要包含
`client.debug` 协议的新版本。旧版本会明确拒绝，不会降级为不受授权控制的脚本执行。

控制机器只负责暂存客户端登记、授权请求、命令和结果。它是受信任的调试参与方，会读取命令及结果；
浏览器到机器、CLI 到机器分别使用现有加密数据面。中间 Relay 只转发密文。
调试工位电脑的 RTC、WASM 或 Host 时，选择另一台服务器作为控制机器。联调连接禁用 RTC 升级，
与工作台的被测连接独立；如果把被测电脑本身选作控制机器，重启它仍然会中断联调。

## 授权和多个客户端

一个文档实例对应一个 `clientId`。同一设备上的两个标签页或 App 窗口分别登记、分别授权；
iframe 是文档内的上下文，`inspect` 列出它们。同源子框架可由获准脚本访问，跨源框架继续遵守浏览器隔离。
完整刷新产生新的实例，不继承授权；普通断线重连不会延长原有截止时间。退出登录、离开页面或点击“断开联调”会立即清除本地授权。

`attach` 在选中的客户端显示操作方自报名称，并请求授权。用户可以选 30 分钟、1 小时、5 小时或 1 天，
也可以拒绝。每次执行前客户端检查本地授权、会话匹配与截止时间；服务器端也检查同一会话能力。
截止时间同时受本地墙钟和单调时钟约束。点“撤销授权”立即阻止本地新操作，即使控制机器暂时不可达。
服务端撤销会丢弃尚未执行的命令和未领取结果。已开始的任意 JavaScript 不能保证终止或撤回其副作用。

登记和授权仅保存在内存。普通断网、切换网络或手机后台挂起，不撤销仍在有效期内的授权；
恢复后继续使用原 `clientId`、操作方 `session` 和原截止时间，不重复弹框、不补足离线时间。
`client list` 的 `online` 表示最近 45 秒内收到心跳，与 `authorized` 分开。离线时新操作明确拒绝，
请等客户端在线后再提交。系统若回收页面导致完整重载，仍按新文档重新授权。

控制机器重启后登记丢失，客户端会自动重新登记，显示新的 `clientId` 并提示操作方重新发起授权。
此时不从客户端旧状态重建服务器授权，以免恢复已在服务端撤销但客户端尚未收到的授权。
无有效授权且超过 90 秒无心跳的登记会被清理，恢复时同样自动重新登记。
这些恢复行为由 `specialty.client.debug-reconnect` 验证；尚未完成物理 iPhone/桌面 App 验证。

## CLI

所有命令使用环境中的 `GENEHUB_CLI` 绝对路径，沿用当前渠道绑定；缺失即停止，不从 PATH 猜二进制。
`--machine` 始终指定联调控制机器，`clientId` 始终指定具体客户端，不能用设备 ID 代替。

```sh
"$GENEHUB_CLI" client list --machine "<控制机器>"
"$GENEHUB_CLI" client attach "<clientId>" --label '本次操作方名称' --machine "<控制机器>"
```

`attach` 返回 `session` 能力令牌和 `pending` 状态。令牌只交给这次操作方；不要写入项目、日志或公开消息。
等待用户在客户端授权后：

```sh
"$GENEHUB_CLI" client status "<clientId>" --session "<session>" --machine "<控制机器>"
"$GENEHUB_CLI" client inspect "<clientId>" --session "<session>" --machine "<控制机器>"
"$GENEHUB_CLI" client eval "<clientId>" --session "<session>" --script 'document.title' --machine "<控制机器>"
"$GENEHUB_CLI" client act "<clientId>" --session "<session>" --selector '#message' --value 'hello' --machine "<控制机器>"
"$GENEHUB_CLI" client screenshot "<clientId>" --session "<session>" --machine "<控制机器>"
"$GENEHUB_CLI" client events "<clientId>" --session "<session>" --machine "<控制机器>"
```

执行命令立即返回 `commandId`，随后领取结果；`pending` 时稍后再查，`complete` 时结果只领取一次：

```sh
"$GENEHUB_CLI" client result "<clientId>" --session "<session>" --command "<commandId>" --machine "<控制机器>"
"$GENEHUB_CLI" client revoke "<clientId>" --session "<session>" --machine "<控制机器>"
```

结果包含 `ok` 和 `value` 或 `error`。`eval` 使用全局 JavaScript 表达式，支持 Promise；等待超过 20 秒返回错误，
不会声称脚本已经停止。复杂脚本可用异步 IIFE。返回结果必须可序列化为 JSON，总大小不超过 1.9 MB。
命令大小最多 128 KiB，每个客户端最多积压 8 条命令及结果，控制机器暂存结果的总预算为 16 MB。
排队超过 30 秒的命令返回“投递前过期，未执行”；已投递后 30 秒未确认的命令返回“可能已执行”。
两种情况都不会自动重试，重连不会补执行过期队列。

`act` 的 CSS 选择器必须恰好匹配一个元素；未指定 `--value` 时点击，指定时设置输入框值并派发 input/change。
`events` 返回最多 100 条客户端连接诊断和页面错误；不是无限日志订阅。
`inspect` 返回标题、可视区域、当前业务连接和 RTC 状态，以及子框架清单。
`reload` 接受同样的参数，刷新后当前授权结束。

`screenshot` 返回 `method: "dom"` 和 JPEG `dataUrl`，手机也支持。它是当前文档的 DOM 重建图像；
跨源 iframe、受保护媒体和部分 GPU 画面可能缺失，不宣称是原生屏幕截图。

## 首次启用

老客户端没有这个运行时，必须先更新前端；老控制机器也需要更新。首次更新仍走现有部署和
`"$GENEHUB_CLI" shell`/WASM 更新机制。这个通道用于调试已加载了运行时的客户端，不能凭空控制尚未安装它的页面，
也不能在浏览器主线程完全卡死时恢复运行。
