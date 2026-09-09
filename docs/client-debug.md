# 客户端联调

浏览器、手机和桌面 App 的客户端使用同一套联调运行时，不按 Stable/Beta 分支隐藏。
在页面右上角点“联调”，选择一台自己有权限连接的控制机器，点击连接。控制机器需要包含
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

登记和授权仅保存在内存。控制机器重启、客户端连续 90 秒没有心跳、页面刷新后，需要重新连接和授权。
手机浏览器在后台可能被系统挂起，因此请把联调客户端保持在前台。

## CLI

下面的 `genet` 表示当前安装渠道提供的 CLI；Agent 应使用环境中的 `GENEHUB_CLI` 绝对路径。
`--machine` 始终指定联调控制机器，`clientId` 始终指定具体客户端，不能用设备 ID 代替。

```sh
genet client list --machine <控制机器>
genet client attach <clientId> --label '本次操作方名称' --machine <控制机器>
```

`attach` 返回 `session` 能力令牌和 `pending` 状态。令牌只交给这次操作方；不要写入项目、日志或公开消息。
等待用户在客户端授权后：

```sh
genet client status <clientId> --session <session> --machine <控制机器>
genet client inspect <clientId> --session <session> --machine <控制机器>
genet client eval <clientId> --session <session> --script 'document.title' --machine <控制机器>
genet client act <clientId> --session <session> --selector '#message' --value 'hello' --machine <控制机器>
genet client screenshot <clientId> --session <session> --machine <控制机器>
genet client events <clientId> --session <session> --machine <控制机器>
```

执行命令立即返回 `commandId`，随后领取结果；`pending` 时稍后再查，`complete` 时结果只领取一次：

```sh
genet client result <clientId> --session <session> --command <commandId> --machine <控制机器>
genet client revoke <clientId> --session <session> --machine <控制机器>
```

结果包含 `ok` 和 `value` 或 `error`。`eval` 使用全局 JavaScript 表达式，支持 Promise；等待超过 20 秒返回错误，
不会声称脚本已经停止。复杂脚本可用异步 IIFE。返回结果必须可序列化为 JSON，总大小不超过 1.9 MB。
命令大小最多 128 KiB，每个客户端最多积压 8 条命令及结果，控制机器暂存结果的总预算为 16 MB。
投递或执行超过 30 秒仍未确认时返回超时错误，不会自动重试可能已执行的操作。

`act` 的 CSS 选择器必须恰好匹配一个元素；未指定 `--value` 时点击，指定时设置输入框值并派发 input/change。
`events` 返回最多 100 条客户端连接诊断和页面错误；不是无限日志订阅。
`inspect` 返回标题、可视区域、当前业务连接和 RTC 状态，以及子框架清单。
`reload` 接受同样的参数，刷新后当前授权结束。

`screenshot` 返回 `method: "dom"` 和 JPEG `dataUrl`，手机也支持。它是当前文档的 DOM 重建图像；
跨源 iframe、受保护媒体和部分 GPU 画面可能缺失，不宣称是原生屏幕截图。

## 首次启用

老客户端没有这个运行时，必须先更新前端；老控制机器也需要更新。首次更新仍走现有部署和
`genet shell`/WASM 更新机制。这个通道用于调试已加载了运行时的客户端，不能凭空控制尚未安装它的页面，
也不能在浏览器主线程完全卡死时恢复运行。
