# 桌面端规格

> 当前实现边界：Windows NSIS 与 macOS dmg 构建目标；Linux 使用 daemon/CLI 加浏览器工作台，不发布
> Tauri 桌面包。版本与发布事务见 Cloud 仓库的 `docs/devops/remote-web-wasm-patch-design.md`。

## 1. 产品模型

GeneHub Desktop 是一个最小原生壳，而不是第二套前端：

1. 启动或接管本 channel 的 daemon，并用看门狗保持它运行；
2. 首次启动完成机器鉴权；
3. 用系统 WebView 打开本 channel 官网；
4. 提供托盘、日志入口和 App 下载页入口；
5. 退出时停止自己管理的 daemon 与 agent 进程。

官网页面与 Chrome 中的页面具有相同权限。它经 Control/Fabric 连接已经授权的机器，随后复用现有
WebRTC direct 升级；即使 App 与 daemon 在同一台机器，产品网页也不会得到特殊的本机准入。

安装包只携带一个无脚本的极小 boot/error 页面。`packages/web` 产品页面不打进安装包，发布 Web 也不需要
重建 App。

## 2. 安装即鉴权

Windows NSIS 完成页默认勾选“运行 GeneHub”；用户完成安装后 App 立即启动。无人值守安装只有显式 `/R`
才启动。其他受支持平台在用户第一次打开 App 时执行同一流程：

```text
启动/接管 daemon
  -> genet hub login --hub <channel Hub>
     unpaired -> 主 WebView 打开官网 verification URL
              -> daemon 轮询 hub.status
              -> paired 后进入 /app?desktopMachine=<machineId>
     paired   -> 直接进入 /app?desktopMachine=<machineId>
```

未登录官网时，登录跳转必须保留 `desktopMachine` 查询参数；登录结束后继续打开刚绑定的本机，而不是退回
首页。网站 cookie 只属于 WebView，不交给 Rust。机器已配对时普通启动不会重复生成 claim link；托盘
“重新登录官网”是显式恢复动作，才请求一次性 claim link。

源码 Dev channel 没有公网 Hub，主 WebView 打开 literal-loopback Vite dev URL，用于开发同一网站代码；这
不是发布产品的本机 bridge。

## 3. 安全边界

远程产品页面不能获得：

- `window.__TAURI__`、Tauri command 或 renderer capability；
- daemon 的 `endpoint.json`、owner token、loopback admission 或长期本机 secret；
- 文件、进程、窗口控制、安装器执行或任意 URL 导航能力；
- 指定补丁 URL、文件路径、channel、key、ABI 或 revision 的权力。

App 配置 `withGlobalTauri: false`，renderer capability 为空，窗口使用系统装饰。Rust 只允许主 WebView导航到
固定的 HTTPS 产品地址，或源码开发所需的 literal-loopback HTTP；credentials、控制字符、`file:`、
`javascript:` 与公网明文 HTTP 都拒绝。

官网触发 Wasm 补丁时，只发送固定 `platform.patch check/apply` 控制调用。daemon 自己读取编译时固定
manifest、校验签名和来源并执行更新，网页不能改变供应链输入。

## 4. 为什么 loopback 仍保留

loopback 不服务官网产品页面，但仍是本机原生边界：

| 消费者 | 用途 |
| --- | --- |
| CLI | 读取 owner-only endpoint，作为薄客户端调用 resident daemon/active Wasm |
| Desktop 原生壳 | start/adopt/health/stop、首次 enrollment 编排 |
| 开发与运维 | 本机诊断与受控 runtime 配置 |

壳关闭 daemon 时使用绑定 action、challenge、pid、machine id、fingerprint 与短过期时间的一次性 HMAC
proof。它不把长期 bearer 放进 URL，也不依赖 Windows 不具备的 Unix signal。

CLI 不在每次命令中另起一份 Wasm。业务请求通过 resident daemon 进入当前 active Wasm，复用 session、资源
owner、授权与持续连接；只有替换 Wasm 本身的 `platform.patch` 是 native 生命周期控制。

## 5. 进程与生命周期

```text
安装包
  ├─ Tauri 壳
  ├─ genet（CLI 与 daemon 是同一个二进制）
  ├─ genet-agent
  └─ 与 Platform ABI 匹配的签名 Wasm baseline

启动
  ├─ 单实例
  ├─ 创建托盘
  ├─ 验证并接管遗留 daemon，或启动 genet daemon run
  ├─ 启动看门狗
  ├─ 执行 auth-first
  └─ 导航到固定官网

关主窗口
  └─ hide；daemon 继续运行

退出 GeneHub
  └─ stop daemon/agents -> 移除托盘 -> exit
```

外壳崩溃时 daemon 有意继续运行，远程任务不因 GUI 崩溃而中断。下次启动读取 owner-only
`endpoint.json`，通过 challenge-HMAC 同时验证 pid、machine id 与 fingerprint，成功后接管，而不是启动
第二个 daemon 抢锁。

看门狗检测 daemon 丢失后重启，间隔指数退避。产品网页不依赖本机端口，所以 daemon 重启后的新端口只
影响原生监督与 CLI，不需要向远程 Web 注入新 endpoint。

Windows 安装器替换二进制前先停止外壳，再按 lock-file pid 停 daemon 进程树，最后确认目标文件已可写；
不同 channel 的进程名、数据目录和 bundle id 分离。App 安装会中断正在执行的任务，因此由用户明确运行
安装包，不允许官网页面直接执行下载文件。

## 6. 前端与原生能力

同一 `packages/web` 构建服务浏览器、桌面 WebView 和手机浏览器。Desktop 不再维护一套产品静态产物，也
不向网站注入 `Host.kind = desktop` 之类的能力。普通浏览器和 App 看到相同 Cloud route、响应式 UI、
Fabric 与 WebRTC 行为。

托盘属于 Rust，不属于网页。当前入口是：

```text
打开主界面
本机状态：启动中 / 运行中 / 正在恢复 / 已停止
连接到 Hub
重新登录官网
检查更新（打开固定 channel App 下载页）
打开日志目录
退出 GeneHub
```

窗口使用系统标题栏。官网页面不画或控制最小化、最大化、移动与关闭按钮。点击关闭只隐藏主窗口，托盘
仍在；只有“退出 GeneHub”停止 daemon。

## 7. 更新与版本展示

用户只需要理解两种更新：

| 类型 | 内容 | 体验 |
| --- | --- | --- |
| Wasm 补丁 | 同 `platformAbi` 的业务逻辑 | 官网检查并应用；daemon 不重启 |
| App 安装包 | Platform/ABI、壳、CLI、内置 Agent 与 matching Wasm | 官网下载，用户运行安装包 |

Wasm 更新是冷替换：有活动 session、terminal 或 native resource 时默认不更新；用户可以等待，或二次确认
“终止任务并更新”。没有活动任务跨版本保留、state transfer、slot、previous 或自动 rollback。candidate 在
提交前完成签名、编译、boot 与 health 校验；失败时 active 未改变，已激活问题用更高 revision
forward-fix。

设置页显示三类诊断身份：

- `App/Platform <release>`；
- `Wasm r<logicRevision> · 协议 v<protocolVersion>`；
- `Web <webBuildId>`。

`platformAbi` 是 Wasm 补丁唯一兼容门；协议版本只用于最新 Web 选择落后 Wasm 的 adapter。ABI 不匹配时
页面提示更新 App 安装包。App manifest 的 `bundledLogic` 记录内置 Wasm 的 channel、revision、ABI、
protocol、component digest 与 key，Platform 更新不会与 Wasm 脱节。

App 更新入口只打开编译时固定的 channel 下载页。远程页面不能把 URL 或本地路径交给 Rust 执行。

## 8. 包体与构建约束

- 安装包中没有 Node runtime 或 `node_modules`；Node 只用于构建期和服务端。
- WebView 使用系统 WebView，不打包 Chromium。
- 发布安装包包含平台对应的 Rust sidecar 与签名 Wasm baseline，不包含外部 agent SDK/CLI。
- Windows 与 macOS 构建记录真实安装器大小，压缩后目标不超过 80 MB。
- `frontendDist` 只能指向极小 boot surface；任何把 `packages/web` 重新打进产品 bundle 的改动由 wiring
  测试拒绝。

## 9. 分支与 Beta 验收

分支 merge-ready 必须证明：

1. 固定网站导航、空 renderer capability、无 Tauri global/command；
2. 未配对、已配对、claim recovery 与 `desktopMachine` 登录返回路径；
3. 真实 daemon 的 start/adopt/watch/stop 与 Windows installer 进程顺序；
4. Windows 安装完成页提供立即启动入口；
5. App 下载页固定为 channel 常量，网页不能安装任意文件；
6. desktop Rust tests 在受支持的 GTK/WebKit 或 Windows runner 编译通过。

真实 Beta 域名、cookie/OAuth、Windows 安装完成回调、同机 WebRTC 与代码签名属于合入后的 Beta 环境
门禁，不用 mock 宣称已经发生。分支阶段不得创建 tag、Release、写官网或启动 Beta 部署。
