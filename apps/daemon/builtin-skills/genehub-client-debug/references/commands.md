# 命令与结果

以下尖括号是需替换的参数，不是可原样执行的 shell 文本。`GENEHUB_CLI` 由 GeneHub 注入，
`--machine` 始终指向用户在联调面板选择的控制机器。控制机器就在当前机器时省略该参数。

```sh
"$GENEHUB_CLI" client list --machine <coordinator-id>
"$GENEHUB_CLI" client attach <client-id> --label '页面布局诊断' --machine <coordinator-id>
"$GENEHUB_CLI" client status <client-id> --session <capability> --machine <coordinator-id>
"$GENEHUB_CLI" client inspect <client-id> --session <capability> --machine <coordinator-id>
"$GENEHUB_CLI" client events <client-id> --session <capability> --machine <coordinator-id>
"$GENEHUB_CLI" client screenshot <client-id> --session <capability> --machine <coordinator-id>
"$GENEHUB_CLI" client result <client-id> --session <capability> --command <command-id> --machine <coordinator-id>
"$GENEHUB_CLI" client revoke <client-id> --session <capability> --machine <coordinator-id>
```

CLI stdout 为 `genet.cli/v1` 信封，成功时 `type: "client.debug"`，业务数据在 `data` 中：

| 调用 | `data` | 下一步 |
| --- | --- | --- |
| list | 客户端数组，每项有 clientId、label、url、userAgent、authorized、online | 确认具体文档 |
| attach | session、status=pending、authorizationTimeoutSeconds | 私有保存令牌，等待页面授权 |
| status | status、remainingMs、可选 seconds | 确认 authorized；与 list 的 online 分开判断 |
| inspect 等操作 | commandId | 保存 ID，查询 result |
| result 尚未完成 | status=pending | 约 1 秒后再查询同一命令，不重新提交操作 |
| result 已完成 | status=complete、result={ok,value/error} | 先保存，再解读；结果已被消费 |

`type: "error"` 时读信封 `error.code` / `message`，与页面返回的 `result.ok=false` 区分。
等待结果约 35 秒仍无结论时停止轮询并核对在线/授权状态和是否可能已执行，不无限等待或盲目重放。
每客户端最多积压 8 条命令及结果；一般逐条领取，别并发灌入整套检查。

## DOM 与页面脚本

`inspect` 已提供 title、url、visibility、viewport、业务 connection/rtc/rtcFailure 和 iframe 清单。
需要更多内容时使用 `eval --script <表达式>`；返回可 JSON 序列化的必要字段，不返回 DOM 节点或整个 store。

```js
// 可作为 --script 的一个参数：定位布局溢出，不采集用户输入。
(() => {
  const el = document.querySelector('#target');
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const css = getComputedStyle(el);
  return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    display: css.display, overflow: css.overflow, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
})()
```

eval 支持 Promise 和异步 IIFE，使用全局执行环境，不能假设存在开发构建的模块局部变量。
脚本上限 128 KiB；结果 JSON 上限 1.9 MB。缩小选择器范围或分段采集，不靠无限增大超时解决。
执行等待超过 20 秒返回错误，但已开始脚本可能仍在运行。

`act --selector <css>` 点击恰好一个 HTMLElement；加 `--value <text>` 设置 input/textarea/select 的值，
派发 input/change。它不模拟完整的键盘/鼠标序列，也不跨 Shadow DOM 或 iframe 搜索。
需要同源 iframe 时先 inspect 确认，再用获准的 eval 进入该 document；跨源 iframe 保持浏览器隔离。
不要使用这些操作点击联调面板内的授权控件。

`reload` 同样先拿 commandId、再领取 result；刷新后旧文档授权结束，重新 list/attach。
不能把 reload 当成保留授权的普通断线重连。

## 截图导出

screenshot 的 `result.value` 是 `{method:"dom", dataUrl:"data:image/jpeg;base64,...", limitations:...}`。
第一次 result 领取时直接捕获完整 JSON 到私有内存/文件；不要先输出到对话再调用 result 获取第二次。
校验 method、JPEG data URL 和 base64 后，将字节保存到任务内具体 `.jpg` 文件，并用当前宿主的图片查看工具检查。
只分享必要且检查过隐私的图片；工作区预览链接指向真实相对文件。截图重建自 DOM，不能用它证明跨源视频、
WebGL/原生画面确实空白；需要该部分证据时请用户通过反馈入口附带原生截图。
