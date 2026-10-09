# 第三方 Agent 接入

> 设计与取舍：[agent-script-adapters-proposal.md](./agent-script-adapters-proposal.md)。
> 线协议：[agent-serve-protocol.md](./agent-serve-protocol.md)。
> 边界 B1 不变：daemon 里不出现任何具体 Agent 的名字、命令、参数、协议或登录方式。

---

## 1. 原则

- **第三方 Agent 全部是脚本目录。** 每个 Agent 一个目录，目录名就是 Agent id。daemon 只读 `agent.toml`，
  用自己的 Python 以隔离模式拉起 `agent.py serve`，按协议收发 JSON-RPC。怎么安装、怎么登录、怎么判断登录态、
  怎么拉起 CLI、怎么翻译事件，全部写在目录里的 Python 中。
- **内置 Agent 不走脚本层。** 它的协议是我们自己定的，没有追上游的问题；它保持原生实现，保证永远有一个能用的
  Agent 去修别的。
- **默认最高权限启动，异常授权是持久化暂停点。** 这条规则不变，具体放权参数写在各 Agent 的脚本里
  （见第 3 节）。会话里的权限请求和提问仍是 `permissionRequested` 会话事件，暂停与恢复机制不变。
- **用户可以长期不回复。** 按 [architecture.md](./architecture.md) §3.4，问题和恢复信息保存后停止当前执行及会话子进程，不保留等待回答的 RPC 或连接。用户回来回答时开启新执行，继续同一 Session / 用户 round；正常退出保留待答状态，主动取消或关闭会话结束恢复义务。
- **用户不执行 CLI。** 安装、登录、更新都是脚本声明的动作，在工作台点按钮完成；需要人决定或输入的内容
  （确认安装、登录链接、设备码、API key）通过 Agent 级用户请求只交给人，不进时间线、不进模型、不进日志。

**持久动作入口：** 安装确认及 Codex API Key 输入已使用 `ctx.ask`：先保存非秘密准备记录、取得短确认，再结束当前动作并确认其进程组及孙进程退出，之后展示请求。回答通过新执行恢复；停止中断和外部结果未知保留记录，不盲目重放。旧 `ctx.request` 保留内存式兼容，用户脚本需迁移。当前 Codex/Cursor 账号授权无法停止后续接，界面明确说明工作台账号登录尚不支持，提供取消或外部凭据检查，不保活 CLI，也不引入终端登录兜底。参见 [线协议](./agent-serve-protocol.md) 和提案 §16.7。

## 2. 目录

```
<渠道数据目录>/agents/
  builtin/<id>/   随 daemon 发布，启动时物化，只读
  user/<id>/      用户或 Agent 新建、或从 builtin 复制出来改的；同名时整体覆盖 builtin
  state/<id>/     脚本自己的持久状态（安装前缀、目录缓存）；reset 时保留
  sdk/            boot.py 与 genehub_agent
  runtime/        Python 安装脚本和它装的 Python
```

源码位置：`apps/daemon/builtin-agents/`（`agents/`、`sdk/`、`runtime/`），构建时编进组件，
随 Live Release 更新。

改动只通过 `genet agent reload <id>` 生效；`genet agent reset <id>` 删除 `user/<id>`。
连续启动失败的本地覆盖版本会被临时搁置，退回内置版本。

## 3. 第一期内置的 Agent

| id | 会话协议 | 安装 | 登录 | 默认放权 |
|---|---|---|---|---|
| `codex` | `codex app-server` JSON-RPC，每个会话一个 app-server | npm 装进 `state/codex/npm` | API Key 通过持久输入卡片；账号 OAuth/设备码暂停恢复尚不支持 | `approval_policy="never"` + `sandbox_mode="danger-full-access"` |
| `cursor` | 每轮一个 `cursor-agent` print 进程，stream-json | 官方安装脚本（curl / irm） | `cursor-agent login`，链接以二维码显示 | `--force --sandbox disabled --trust --approve-mcps` |

两者都会：

- 先推送 `state/<id>` 里缓存的模型目录，再探测，探测失败时界面不会变空；
- 在 `serve` 启动时检查并更新由 GeneHub 安装的 CLI（每 24 小时最多一次）；
- 自己迁移会话里存着、但当前目录已经没有的模型、模式和思考强度，并发出 `*Changed` 事件。

Codex 另外监视 `auth.json`（`CODEX_HOME` 或 `~/.codex`），以及 app-server 输出的 `token_revoked` / `401`；
出现时在下一轮开始前重启 app-server 并 `thread/resume`，重新登录对已打开的会话立即生效。

各目录里的 `README.md` 说明文件分工；协议实现细节写在各自的模块文档里。

## 4. 已移除、待以脚本重新接入的 Agent

Claude Code、TClaude、CodeBuddy、OpenCode 和 `agents.custom` 里声明的自定义 ACP Agent 的 Rust 适配器已删除。
重新接入之前：

- 它们的历史会话仍可只读查看；
- 继续发消息会得到「这个 Agent 现在不可用」；
- tag 路由自动绕开它们。

配置文件里遗留的 `agents.custom` 被忽略。重新接入的顺序见提案 §13.2，每一步只新增脚本目录，平台不改。

## 5. 写一个新的 Agent

看 `<渠道数据目录>/agents/README.md`（源码：`apps/daemon/builtin-agents/README.md`）。最小的 Agent 是一个
`agent.toml` 加二十几行 `agent.py`；`codex/` 和 `cursor/` 是完整示例。验收：

```bash
"$GENEHUB_CLI" agent test <id> [--live]
"$GENEHUB_CLI" agent reload <id>
"$GENEHUB_CLI" agent logs <id>
```

## 6. 起不来的时候

- 列表里的说明文字来自脚本；脚本本身起不来时由 daemon 写明原因（Python 运行时未安装、`agent.toml`、握手失败、
  退出码和最后几行 stderr）。
- `genet agent logs <id>` 给出脚本的 stderr 和 daemon 记下的协议问题（不合规的事件、超时重启）。
- 工作台里不可用的脚本 Agent 有「让内置 Agent 修复」：开一个内置 Agent 会话，按上面的流程复制、修改、
  测试、`reload`。
