# Beta App → Live 的发布基线

App Release 从自己的 tag 源码构建并携带已签名 guest。新 WASM 修改已经随 App 交付；历史 Live
制品和 component manifest 可以保持原样，无须为“补齐内容”重发、删除或重标版本。

Beta Live 发布脚本以已发布 App、历史 component 与有效产品清单中最新的版本计算下一次 Live。例如：

```text
历史 Live 0.12.1-beta.11 + App 0.13.0-beta.2 → Live 0.13.1-beta.1
后续 Live 0.13.1-beta.1 + App 0.13.0-beta.2 → Live 0.13.1-beta.2
```

## 发布前只读核对

在服务器固定的 Open 候选仓运行，路径使用 release context 解析出的值：

```bash
node scripts/publish-component.mjs --plan --channel beta \
  --stage <resolved-stage> --cloud-root <resolved-cloud>
```

`--plan` 不构建、不创建发布 worktree、不修改制品或清单。输出候选双仓 SHA、App Release
身份、历史 component 版本、产品基线、下一 Live 版本和元数据摘要。默认先复用服务器的 `gh api`
读取，失败后尝试不带凭据的 HTTPS；两者都从官方仓库 GitHub REST
releases 列表读取 App；只接受非草稿、已发布、Beta App tag 且 guest、安装器、CLI 包、校验文件和
App 清单均上传完成的 Release。普通 Git tag、失败构建留下的 tag、滚动 `beta` tag 不算新 App。
这里的“已发布”指安装资产已公开，不代表 Cloud 已部署，也不代表任何设备已安装或运行该版本。

无法读取或没有合格 App 时停止，不回退到旧 Live 推测当前 App。API 不可达时可在能够访问 GitHub
的授权设备保存 REST 响应，随发布任务传递到服务器，再通过 `--app-releases <absolute-file>` 读取：

```bash
gh api --paginate --slurp repos/aikenc/genethub/releases | jq 'add' > reviewed-app-releases.json
```

该文件是显式的审阅输入，应覆盖完整分页并在每个新发布任务重新取得。`--plan` 与后续 `--commit`
可以使用同一个文件固定本次 App 基线；保存输出的摘要以避免传错快照。不要把 `gh release list`
文本、单个 tag、手写版本或旧任务快照当作 REST 响应。文件未经过签名认证，可信性来自正常的发布
审阅和取得渠道；它不替代设备端的签名/ABI 检查。若 component 已在快照中不存在的新 App 代际，
脚本会拒绝并要求刷新元数据。

Web-only 和服务端更新也使用 Cloud `publisher/plan-release.mjs` 分配产品版本，不能只改 build SHA。
正式发布仍走 release-beta 的持久 runner；不要在临时远程 shell 中直接执行长发布命令。
`--version` 也必须处于已发布 App 代际并不低于自动算出的下一 Live。Stable、dev 的既有算法不变。

## 发布身份记录

将 `--plan` 和成功 `--commit` 输出附在原发布记录中，区分以下事实：

| 身份 | 证据 |
| --- | --- |
| 可下载 App | `baseline.app` 的版本、Release ID、URL、发布时间及元数据摘要 |
| App 内置 guest | App 发布的同版本 WASM、签名检查结果与实际下载文件的 SHA256；不拿旧 Live 代替 |
| 历史/当前 component 更新源 | `baseline.component` 和发布后的 manifest/receipt |
| 下一次 Live 基线 | `baseline.product`、`baseline.nextLive`；本次显式版本单独记录 |
| 发布候选 | `source.openSha`、`source.cloudSha` |
| Cloud / Web 激活 | 实际部署的 build identity 和对应回执 |
| 设备已安装 | 目标设备上的二进制版本；注明设备，不能用服务器代替用户 PC |
| 设备正在运行 | 重连后的 Host / guest 身份；未重启时明确标为旧进程或未验收 |

统一版本实现、产品清单与实际激活验收以 Cloud `docs/release-identity.md` 为准。
版本管理不自动授权修改 Host 加载规则或重启 daemon。
ABI 变化仍需现有配对 App 证据；仅修正版本分配不豁免原生依赖审查，也不自动解决旧 App 对新一代
Live 的兼容性问题。新 App 安装资产可下载不等于所有设备都已升级。

## 回归范围

`testctl` 的 `publish-baseline` 专项通过真实发布 CLI 的只读入口和隔离文件验证跨流程版本分配、
无效 Release 排除、显式版本限制、首次 Live 和历史 manifest 不变。REST 文件是公开的离线操作
输入；专项不 mock 产品函数，不声明已验证安装器、设备更新或公网发布。在线只读 plan 另用于确认
实际 GitHub 元数据仍符合合同；GitHub 资产名或 REST 结构改变时须重新核对。
