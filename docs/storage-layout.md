# 持久化目录规范

新增任何持久化数据之前先读本文。它回答两件事：数据放哪，以及为什么。会话目录内部的物理布局见
[session-storage.md](./session-storage.md)；设计判据是引导 `G12`，禁令是律法 `L13`。

---

## 1. 两个根

| 根 | 放什么 | 生命周期 |
| --- | --- | --- |
| **Space 根下的 `.genethub/`** | 业务状态：会话、组件实例数据、Workflow 包源 | 跟着项目走：复制项目一起复制，删掉项目一起没；各 channel 共用同一份 |
| **daemon 数据目录 `<data>`** | 机器本地、可丢弃的东西：项目注册表与 rootHandle（`config.json`）、机器身份（`state.json`）、已授权设备（`devices.json`）、`logs/`、缓存 | 每个 channel 一份；卸载即整个删掉 |

判断标准只有一条：**换一个 channel 打开同一个项目，这份数据还应该在吗？** 应该在，就放 `.genethub/`；
只对这台机器、这次安装有意义，才放 `<data>`。

agent CLI 自己的线程库（`~/.codex/` 之类）不归我们管，只在会话 `meta.json` 里存它的句柄。

## 2. `.genethub/` 全貌

项目根和每个 AgentSpace 根（`spaces/<name>/`）各有一个 `.genethub/`，互不嵌套。

```text
<Space 根>/.genethub/
  .gitignore                  内容为 *，整个目录自我忽略
  sessions/<会话>/            一段对话，内部布局见 session-storage.md
    components/<组件>/        组件实例的会话级存储
  components/<组件>/          组件实例的 Space 级存储
  tombstones/<会话>.json      会话删除墓碑
  workflows/<包>/             Workflow 包源（仅项目根）；手写，可自带 git
  speech/                     项目级语音偏好与学习词表（仅项目根）
  temp/                       普通临时材料，例如 Workflow 试验材料 temp/exp/<testname>/
  owner.lock                  滚动升级期间的旧版兼容锁
```

新增顶层目录必须先登记到这张图里。

## 3. 放置规则

依次回答三个问题：

1. **谁对它负责？** 属于某个组件职责（`pm`、`executor`、`worker`、`reviewer` 等）的，放该组件实例的目录；
   属于对话本身的，放会话目录；属于跨组件的平台能力（如 `speech`）的，放 `.genethub/<能力>/` 并在第 2 节登记。
2. **活多久？** 随会话结束的放会话级 `sessions/<会话>/components/<组件>/`；跨会话存在的放 Space 级
   `components/<组件>/`。实例目录由 `session/components.rs` 解析，组件 id 是封闭集合，不能变成任意路径。
3. **怎么找到它？** 路径即索引：身份由位置决定，不存本机随机 id，也不维护需要全量扫描才能找齐的索引。

写入方式沿用会话存储已经验证过的做法（[session-storage.md](./session-storage.md) §3.4）：只追加、
版本号单向、写入互斥用内核文件锁、崩溃后锁自动释放。

## 4. 私有与可编辑

| 目录 | 谁写 |
| --- | --- |
| `sessions/`、`components/`、`tombstones/` | 只由 daemon 写。Agent 不直接改写 |
| `workflows/`、`temp/` | 普通目录，Agent 按任务需要编辑 |

"只由 daemon 写"是**纪律，不是强制**：任何有项目写权限的 Agent 技术上都能写，放进 `<data>` 也挡不住。
越权写入会在会话记录里留痕，由复查发现。不要为此设计额外的防篡改机制。

## 5. Workflow 布局

| 数据 | 位置 |
| --- | --- |
| 工作流构建（内部 Candidate）、激活指针 | 包的 Executor Space 级 `components/executor/`；无独立载体的定义包使用项目根的同名目录 |
| Run 快照（按请求归档） | 项目 PM Space 级 `components/pm/requests/<请求 id>/runs/<Run id>/run.json` |
| Run ID 定位记录、请求写锁与引用租约 | 项目 PM Space 级 `components/pm/`；定位记录可从请求目录重建 |

旧版 `<data>/workflow-runtime/` 与 Executor 会话快照不自动导入，新版不从那里读取。

## 6. 工作流构建与包观测记录

`workflow build` 将 `views/<id>/**` 和 `checklists/**` 纳入同一个不可变构建；
Run 固定构建摘要，宿主从该构建读取视图，不从当前包源补文件。
构建发现入口使用 `views/<id>/index.html` 的 `<title>`，不维护额外视图登记表。

工作流自行产生的依赖、排队和子步骤记录放在任务目录的
`.genethub/temp/observations/`，由包负责 schema 和保留周期。视图调用来源记录放在项目的
`.genethub/temp/workflow-view-calls/<Run id>/`，通过现有文件接口写入，不包含调用参数和文件内容。
这两类可编辑记录均不替代 daemon 管理的 Run 快照与 journal。

累积条目采用 `<YYMMDD-HHMMSS>_<hash>[_<slug>].json`，时间为东八区，hash 按并发和
碰撞风险选择 4/8/16 位；写入先完成临时文件，再原子发布完整条目。实体已有天然 id 时沿用 id；
单个当前值的指针文件无需拆分。历史条目排序和去重由目录与内容身份完成。
