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

## 与 Rust 版的关系

`genet space builder …` 仍由 daemon 里的 Rust 版处理 `pipespace.json` 的 Space（已标废弃，保留到 workflow 取消）。有 `agent-space.genet.json` 的 Space 用本脚本。
