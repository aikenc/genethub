# SpaceBuilder

`spacebuilder/spacebuilder.py` 把 Space 的描述文件、Skill 和 Skill 里的定时 hook 生成成 Agent 实际读的文件，并用 `.spacebuilder/lock.json` 记录哪些文件归它所有。一个脚本，自带全部逻辑，不依赖 daemon。

```bash
"${GENEHUB_PYTHON:-python3}" <本目录>/spacebuilder/spacebuilder.py <check|explain|build|verify|clean> <Space 目录> --format json
```

`build` 从根 Space 开始，按 `children.scanDepth` 构建整棵树；`verify` 报告被手改的生成文件（`SB017`，含 hook 文件）；`clean` 只删它自己写的文件。

## 输入

`<Space>/agent-space.genet.json`（严格 JSON）：

| 字段 | 含义 |
|---|---|
| `schema` `name` `agents` `skills` `tags` `skillProviders` | 必填。`name` 小写 kebab-case |
| `agentCwd` | 可选，相对 Space 根的目录。规则（`AGENTS.md` 等）与 Skill 副本写到这里而不是根，daemon 也让这个 Space 的新会话从这里开始。不得绝对、不得含 `..`、不得是 `.`、`.spacebuilder`、`.genethub` |
| `identity` | 可选，相对 Space 根的文件（如 `soul.md`）。内容被**整份复制**编译进各声明 Agent 自己默认读取的指令文件：`claude-code` → `CLAUDE.md`，其余 → `AGENTS.md`（都在 `agentCwd` 下，且排在最前）。含 Codex 时合成后的 `AGENTS.md` 超过 32 KiB 报 SB019。改了源文件要重新 `build` |
| `folders` | 可选，`[{"path": "."}]`。有它就不再需要 `<name>.code-workspace`；含 `${VAR}`、绝对路径或不存在的项被跳过，全跳过时退回 `.` |
| `children.scanDepth` | 往下找子 Space 的层数 |

Skill 来源：`<Space>/.spacebuilder/skills/<名>/` 或 `skillProviders`。

## 定时 hook

Skill 目录里的 `hooks/<名>.genet.json` 生成该 Space 的 `.genethub/hooks/<skill>.<名>.genet.json`，补上 `schema`、`event: "timer"`、`cwd: "."` 和 `owner: "spacebuilder:<skill>/<名>"`，纳入所有权锁。`hooks/` 不会复制进各 Agent 的 Skill 目录——daemon 只读 `.genethub/hooks/`。hook 的格式见 daemon 文档「定时 hook」。

## 独立输出（0.1.5）

一次调用接收一个 Space 目录，按它的 `children.scanDepth` 向下构建；只生成某个岗位就直接传该岗位目录，不需要 `--member`。

```bash
"$GENEHUB_PYTHON" <本目录>/spacebuilder/spacebuilder.py build <源Space> \
  --output <临时区>/artifact/spaces/qa --format json
"$GENEHUB_PYTHON" <本目录>/spacebuilder/spacebuilder.py verify \
  <临时区>/artifact/spaces/qa --artifacts-only --format json
```

`--output` 把 Agent 规则、Skill、定时 hook 和派生的执行描述写入另一个目录，原地生成物和原地锁保持不变。Provider 的缓存或 build/post 命令仍可能修改源侧约定位置。输出不得与输入 Space 重叠或经过 symlink；重复生成只更新输出回执证明拥有的文件，拒绝覆盖非受管同名文件。

执行描述保留 agents、agentCwd、folders 和子树扫描范围，移除 identity、源 Provider、buildHooks 等编译输入。规则中的 folder 相对 **Space 根**，指令同时标明 Space 根相对 agentCwd 的位置；目标机才存在的相对目录和 `${VAR}` 声明保留，由目标环境校验。不会改写用户身份文本、脚本里手写的绝对路径。

`.spacebuilder/output-lock.json`（`spacebuilder-output.v1`）记录 builder 身份、各成员源 manifest 摘要、执行描述及生成物的摘要和权限。`verify --artifacts-only` 不读源文件、不运行 hook，只验交付字节及安全路径；它不能代替目标端目录/依赖检查和新会话验收。原有 `verify` 不会因缺源码自动降级。

输出不自动复制 `tools/`、父容器、项目仓、数据或机器配置。部署脚本应补齐必要运行资源、保留相对布局，只注册目标岗位；目标机器的 `.genethub/open.env`、数据和项目 worktree 不随更新覆盖。不要在远端对执行描述再次 build 来替代源端构建。

## 构建 pre/post（0.1.5）

Space 描述可选 `buildHooks`；这是 build 生命周期，与上述定时 hook 不同。下例脚本由项目自己提供：

```json
{
  "buildHooks": {
    "pre": [{"cwd": ".", "args": ["{python}", "tools/prepare.py", "{outputRoot}"]}],
    "post": [{"cwd": ".", "args": ["{python}", "tools/publish.py", "{outputRoot}"]}]
  }
}
```

- `cwd` 相对声明 hook 的源 Space，不得逃逸；args 是 argv，不经 shell。支持 `{python}`（当前 `sys.executable`）、`{sourceRoot}`、`{spaceRoot}`（同源根）、`{outputRoot}`、`{spaceName}`。环境同时提供 `SPACE_SOURCE_ROOT`、`SPACE_ROOT`、`SPACE_OUTPUT_ROOT`、`SPACE_NAME`。
- pre 在规划前运行，随后重新读取输入；不能在 pre 改变本次 Space 树成员。所有成员完成生成、原有 Provider post 和校验后，按发现顺序的逆序运行 Space post，入口 Space 的 post 最后运行。发布整包放入口 post。
- `check`、`explain`、dry-run、verify、clean 不运行 hook；pre 才会创建的输入在静态检查时可能尚不存在。`--require-no-post-commands` 在执行 Provider build/pre/生成前拒绝 Space pre/post 和 Provider post，不会悄悄跳过它们。
- 每条命令超时 600 秒；日志去 stderr，stdout 保持结构化报告。pre/生成/Provider post 失败不执行发布 post；Space post 失败返回 SB016。字节生成通过不代表传输或部署完成，外部副作用不自动回滚。

GeneHub 中使用内置 `$GENEHUB_PYTHON` 启动，Python hook 通过 `{python}` 沿用同一解释器。团队用现有 `tools/team.py temp new <slug> --purpose ...` 取得临时区；通用 builder 只接收路径，不依赖团队脚本。post 可用 Python 标准库 zipfile 压缩，再调用渠道绑定 `$GENEHUB_CLI`：让接收方 `file download`，保存 transferId，以 `completed` 和 SHA-256 验收，最后在目标端校验并安装。

压缩包放输出目录外，排除构建期间的 `.spacebuilder/build.lock`、`tree-build.lock`；包开始传输后不再修改，保留到接收方确认终态。不要把本机解释器或 CLI 路径用作远端命令。Agent/定时 hook 提供平台变量，普通 remote shell 不保证带 `GENEHUB_PYTHON`；先在目标机核对内置 runtime 登记，再显式传目标解释器绑定。安装脚本须按已有回执恢复、备份及替换受管文件，不整目录删除。

## 与 Rust 版的关系

`genet space builder …` 仍由 daemon 里的 Rust 版处理 `pipespace.json` 的 Space（已标废弃，保留到 workflow 取消）。有 `agent-space.genet.json` 的 Space 用本脚本。
