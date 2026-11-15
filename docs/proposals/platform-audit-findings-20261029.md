# 平台审计与 C 局部简化结果（2026-10-29）

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

> **产品决策更新**：以下保留审计历史，不等于每条都是当前缺陷或获准实施的安全加固。
> 完整 Agent 连接等价目标 OS 用户能力；同 UID 可读本机凭证、普通 Agent 全能力、跨项目操作
> 不能直接视为需新增 ACL 修补的漏洞。§5 的最小权限/跨项目收紧建议已被该决策取代，
> 实施以 [权限与简化交接](agent-authority-simplification-handoff-20261029.md) 为准。
> 未认证、账号不匹配、撤销/过期、仅展示分享和 OS 边界仍须验证。

- 槽位：`dev-3`
- 基线：open `809720a2`（已并入 `origin/main` c6ac5610）、cloud `bc4fb54`
- 范围：平台简化提案 v3 的 C1–C4，以及 §6 五项平台审计
- 原则：先取证再改；没有测量或代码证据的不改；审计发现另行建任务，不混入本次实现

## 1. 本次实际改动（C）

### C1 Session 模型

- 删除无生产者的 `SessionSummary.workSummary`，连同 `SessionWorkSummary`、`WorkflowTaskSummary`、`WorkflowHumanWait`
  （`packages/proto/src/domain.rs`）。daemon 唯一赋值一直是 `None`
  （`session/store.rs`、`cli_front/query.rs`），workbench 的 PM/团队分支因此是死代码
  （`session/attention.ts`、`workspace/useAgentActivity.ts`）。
- 快照路径直接使用服务端 `snapshot.summary.interactionSummary`，不再用 `pendingPermissions`
  重新推导（`packages/workbench/src/session/store.ts`）。事件流增量仍保留，因为它服务于
  没有完整快照的实时更新。
- 未改：tag 词表、状态机双份。两者是跨语言镜像，删掉需要新增 proto 契约或改变实时语义，
  超出“用现有类型”的边界。

**判断依据**：`SessionSummary` 只有一处 Rust 定义并生成 TS；workbench 从未重建完整会话模型，
只补丁实时字段。真正可删的是死字段与重复推导，而不是“第二套 store”。

### C2 慢查询

- `Store::list_meta` 每个 `meta.json` 原来读两次、解析三次；现在读一次、解析一次，
  由 `load_meta_from` 复用已读文本和 header（`apps/daemon/src/session/store.rs`）。
- `SessionManager::live()` 不再在 `sessions.write()` 内做全量 `list_meta`、`load_chat`、
  `save_meta` 和中断恢复；改为独立的 `live_load` 串行锁，重活做完后再短暂拿写锁插入
  （`apps/daemon/src/session/manager.rs`）。这是 7 个并发 `workspace.list` 串行化并阻塞控制
  RPC 的直接机制。
- `scan_spaces` 的节流时间改为扫描结束后记录，并加 in-flight 守卫；扫描超过 2s 时不会让
  后续 `workspace.list` 重复扫描同一棵树（`apps/daemon/src/workspace.rs`）。
- 未改：`recover_deliveries` 的 O(P×N)、`list_with_projection` 的逐项锁、`process.list` 的
  全量扫描。它们有代码证据，但需要更大的结构调整或独立测量，先记录。

**测量建议**（复核用）：对冷会话发一次 `session.get`，`strace -c` 应只看到一次
`meta.json` 读取；并发一次 `session.list` 不应被该请求的写锁挡住。

### C3 资源泄漏

- 现场复查：`/data/tmp/gh-probe-*` 为 0，当前无 Chrome 残留。审计确认这些目录不是本工作区
  产品代码创建的，而是外部/临时会话的产物；但产品与测试里存在同类孤儿路径。
- 测试浏览器驱动改为独立进程组，关闭时先 SIGTERM 组、超时再 SIGKILL 组
  （`testing/framework/drivers/browser.ts`）。
- 租约回收从只扫 `genehub-(env|legacy)-` 扩大到所有带所有权标记的 `genehub-*` 与
  `summary-ui-*`（`testing/infrastructure/environment/ownership.ts`），崩溃后残留的浏览器
  profile、scale、hook 临时树可被下一次 testctl 回收。
- 未改：bash 工具在 wasm 下只杀 shell pid、host 进程缺 `PR_SET_PDEATHSIG`、speech 外部
  runtime 未 `own_group`、PTY reader/waiter 线程不 join。这些是真实产品缺陷，但属于
  “Agent/终端生命周期”审计，另行建任务。

### C4 诊断与配置

- Fabric relay URL 不再整体写日志，只记录 host/port；URL 含 ticket/route 凭据
  （`apps/daemon/src/transport/fabric.rs`）。
- client-debug 的 `inspect` 返回 URL 时剥离 query/fragment，避免把 preview-share/claim token
  带回证据（`packages/workbench/src/client-debug/index.ts`）。
- 删除 `SupportDiagnostics` 中从未有生产者的 `workflowPatrol*` 字段，以及 CLI 的对应空值
  （`packages/proto/src/domain.rs`、`apps/daemon/src/diagnostics.rs`、`apps/cli/src/control.rs`）。
- 未改：诊断信封按信任边界保持多份（服务端 ring、页面采集、用户授权联调、测试证据）；
  合并会抹掉不同的生命周期与采集权限。

## 2. 审计后已顺手修复的低风险项

- **B 权限自批（原 B4）**：`session.respondPermission` 现在拒绝任何 `SessionController` 批准
  `Permission` 类型的工具权限；Human 的 `LocalUser` 路径不变。
- **设备列表 fail-open（原 B7）**：`devices.json` 解析失败时先把原文件改名为
  `devices.corrupt-<epoch>` 再以空列表启动；文件存在但读不出来时拒绝持久化，避免下一次配对
  覆盖唯一副本。
- **启动恢复一坏全停（原 C5）**：`recover_deliveries` 逐会话隔离错误，单个损坏会话只记录警告，
  后续会话继续恢复。
- **并发覆盖缺口（B）**：新增 `specialty.concurrency.parallel-workspaces`，在 10/20 workspace
  规模验证每个会话只看到自己的 `turnStarted`，并在 20 个在途 turn 下验证 `workspace.list` 响应；
  干净树 run `261029-1526-change-fc14` 通过。

- **Provider key 可经 Files 读取（原 B1）**：`WorkspaceRegistry::resolve` 与 `file_access::resolve`
  拒绝 `.genethub/sessions`，文件树也不再展示 `.genethub`；`models.json` 仍在会话私有目录并保持 0600，
  但 `Files`/Asset Preview 不再能通过工作区路径取到它。
- **trunk index 不 fsync（原 C2）**：`append_trunk_summary` 在 flush 后 `sync_all`，每个关闭的 trunk
  只多一次 fsync，body 已由 `save_private` 持久化。
- **内置 Agent pid 与重启后 registry（原 A1/A8）**：`GenetSession` 返回真实 pid，pump 检查点
  在 pid 变化时重新 `processes.watch`。shutdown 改为**一次 census** 找出所有 session 的
  detached 后代并清理，同组工具留给 Agent close 的组杀；逐会话 census 会拖垮 host 退出预算，
  `daemon-stops-active-sessions` 已验证通过。
- **blob 掉电丢失（原 C3）**：`put_blob` 在 flush 后 `sync_all`。本机数据卷实测约
  0.57ms/次（1000 次 0.568s），按典型 turn 的 blob 数量增加亚秒级成本，换取引用与字节同序持久化。
- **`stop_all_checked` 杀整个 Agent 组（原 A7）**：改为对 census 中逐个复核过的 pid 发 TERM/KILL，
  不再 `killpg` Agent 的组；同组后代由 Agent 自身的 close/组杀收尾。

- **Hosted admission 过期只在握手检查（原 B6）**：`handle_rpc` 在每次请求前检查
  `authorization_expires_at`，过期返回 401 `Unauthorized`，不再依赖连接被重连时才触发。

## 3. 五项平台审计发现（其余未修复，另行建任务）

### A. Agent 子进程退出/取消

1. **内置 Agent 不暴露 pid**：`AgentSession::pid` 默认 `None`，`GenetSession` 未覆盖，
   `processes.watch` 永不执行；`process.list`/关闭清理对内置 Agent 为空
   （`adapter/mod.rs`、`adapter/genet.rs`、`session/manager.rs`）。
2. **重启后不核对持久化清理状态**：`meta.agent_pid` 写入但启动不读；`Processes` 仅内存；
   旧的未完成 `execution_cleanup` 回执会让 `close` 永久失败（`session/manager.rs`、`processes.rs`）。
3. **Agent 崩溃后逃逸进程永久孤儿**：`claimed_by` 只认仍存活的 agent pid，下一次启动覆盖
   registry；`retire_execution` 从不调用 `Processes::stop_all*`（`processes.rs`、`manager.rs`）。
4. **PTY 关闭只移出 map**：reader 线程、fd、waiter shell 不 join/abort；permit 先释放，
   `MAX_TERMINALS` 不再约束真实资源（`pty_host.rs`）。
5. **`Group::pid` 等待后不清空**，Drop 仍 `killpg`，存在 pid 复用误杀
   （`apps/daemon/src/process.rs`）。
6. **`Group::end` 在 SIGKILL 后无超时 `wait()`**；D 状态进程可让请求/钩子永久挂起
   （`process.rs`）。
7. **`stop_all_checked` 杀整个 Agent 组**，与 `stop`/`stop_all` 的“不杀 Agent 组”策略冲突，
   且对 census pid 无年龄/命令复核（`processes.rs`、`process.rs`）。
8. **脚本 host 重启后 registry 仍指旧 CLI pid**，新 CLI 的子进程不被认领
   （`adapter/script/host.rs`、`manager.rs`）。
9. **启动/取消失败路径直接 drop `Child`**，只 SIGKILL 直接 pid，组内 sidecar 存活
   （`adapter/genet.rs`、`adapter/script/host.rs`）。
10. **仅靠 stdout EOF 发现 Agent 退出**；子进程继承 stdout 时永不 EOF，turn 永久 Running，
    child 变僵尸（`adapter/genet.rs`）。
11. **daemon shutdown 无全局 deadline**，逐会话串行清理，失败后直接丢 `Arc<Live>`
    （`session/manager.rs`）。
12. **delete 先把会话移出内存再清理/删盘**，任一步失败会留下“界面上已删、磁盘还在”的会话
    （`session/manager.rs`）。
13. **`stop_pump` 超时后 detach 而不是 abort**，pump 与 blob writer 继续持有会话
    （`session/manager.rs`）。

### B. 权限与凭证边界

1. **Provider API key 明文写入项目树**：`models.json` 在会话 `state` 目录，`Files` 能力可读，
   而 `settings` 才是凭证能力（`adapter/genet.rs`、`session/store.rs`、`files.rs`）。
2. **`LocalUser` 可由同 UID Agent 伪造**：`endpoint.json` 含 daemon bearer，Agent 可签 challenge
   取得本地用户身份，绕过仅限 Human 的审批路径（`state.rs`、`transport/local.rs`、`router.rs`）。
3. **普通 `SessionController` 拥有 Devices/Settings/Update/PtyUnconfined**；
   `device.invite` 默认发全权限邀请，提示注入的 Agent 可借此长期扩权（`authz.rs`、`router.rs`）。
4. **`Permission` 类型请求可被发起它的 Agent 自己批准**（`router.rs`），审批门形同虚设。
5. **受管 SessionController 可修改任意普通会话**（`router.rs` 只在目标受管时才检查父会话）。
6. **Hosted admission 过期只在握手/重连检查**，已建立连接不按请求复核（`endpoint.rs`）。
7. **`devices.json` 解析失败按空列表继续**，下一次持久化会覆盖真实授权列表（`devices.rs`）。
8. **controller token 确定性、无过期、经环境变量传给子进程**；泄露即 daemon 生命周期内的
   全机凭证（`manager.rs`、`adapter/mod.rs`）。

### C. 会话持久化

1. **工具调用与 reasoning 不做崩溃检查点**；只有叙事约每秒落盘，崩溃可丢最多约 100 轮/
   500 blob 的工具证据（`manager.rs`、`store.rs`）。
2. **trunk 写失败直接丢 item**，trunk index 只 flush 不 fsync；崩溃后 trunk 不可达（`store.rs`）。
3. **blob 追加不 fsync**，引用它的 trunk 行已 fsync，掉电后工具输出静默丢失（`store.rs`）。
4. **后台进程所有权仅内存**，崩溃后无法回收也已记录（与 A2/B4 重叠）。
5. **一个坏会话会中断全部启动恢复**：`recover_deliveries` 用 `?` 逐会话推进（`inbox.rs`）。
6. **`replace_drafts` 先改内存再落盘**，保存失败后读到的仍是未保存草稿（`manager.rs`）。
7. **损坏 `meta.json` 无修复路径**，只能手工处理（`store.rs`）。

**已确认可靠**：`save_private` 的临时文件+fsync+rename、chat 追加 fsync、坏行跳过、
删除先 tombstone。

### D. 文件/终端资源生命周期

与 A 中 PTY/进程项重叠；补充：每次截断的 bash 输出在系统临时目录生成
`genet-bash-<uuid>.log`，从不删除（`apps/agent/src/tools/bash.rs`）。

### E. 内置模板/团队 Skill 分发

1. **admin Space 每次启动强制覆盖**：`builtin_expert::refresh` 按字节重写模板与 descriptor，
   用户/Agent 对 admin 的编辑在下次启动丢失；写入非原子，半途失败会留下混合树
   （`builtin_expert.rs`）。
2. **`<data>/builtin-skills` 每次会话启动覆盖并裁剪**；用户放在这里的定制会被删除，
   而 `team.py` 正从这里取新团队模板（`skills.rs`、`team.py`）。
3. **一个安装失败让整个内置 Skill 目录对所有会话消失**：`skills.rs` 首次失败即返回 `None`，
   `AppState` 忽略错误（`skills.rs`、`state.rs`）。
4. **`install_file` 覆盖路径非原子**：Windows 上先删目标再 rename，崩溃窗口会删掉产品 Skill；
   临时名只含 host pid，同进程并发可互删（`skills.rs`）。
5. **已有团队不自动升级**；模板路径指向 live 的 `<data>/builtin-skills`，daemon 更新会在
   升级过程中改变合并目标；无协议版本检查（`team.py`、`upgrade.md`）。

## 4. 建议的后续任务拆分

1. 进程与终端生命周期（A + D）：修 pid 暴露、重启核对、组杀策略、PTY join、end 超时。
2. 凭证边界（B1/B2/B3/B4）：models.json 移出项目树、LocalUser 证明绑定会话、邀请默认最小权限、
   Permission 不得自我批准。
3. 持久化证据（C1–C3）：工具调用检查点、trunk index fsync、blob fsync。
4. 模板分发（E1–E4）：原子覆盖、失败隔离、用户编辑保留策略。
5. 其余（B5–B8、C5–C7）按风险排序补测后再改。

以上均未在本次 C 任务中实施；C 只处理了有直接证据且低风险的简化与泄漏路径。

## 5. 四项产品边界的影响分析

### 5.1 同 UID Agent 可伪造 `LocalUser`

现状：`endpoint.json`（0600）保存 daemon bearer；同 UID 的 Agent 子进程可读它并完成本地
challenge，取得 `LocalUser`。`LocalUser` 是 provider 配置、计划/问题回答、工具权限批准等
“只有 Human 能做”的操作所依赖的身份。

- **方案 A：把 `LocalUser` 限定为 Workbench 页面身份，CLI 只保留 `SessionController`。**
  影响：`genet` 在终端里不能再提交 provider key、回答计划/问题、批准工具权限；团队脚本和
  定时 hook 里依赖 CLI 用户权限的路径会 401；`genet daemon stop/status` 这类本机管理命令
  也需要另设 TTY 确认通道。用户必须打开 Workbench 完成这些操作。
- **方案 B：承认“同 UID 即本地用户”是 OS 边界，不再用代码区分 Agent 与 Human。**
  影响：零体验变化；但提示注入的 Agent 可以读取 bearer 并以用户身份操作，现有 Human-only
  门禁只是建议性的。
- **方案 C：把 bearer 移出文件系统（内核 keyring / 父进程 fd 传递 / OS 认证）。**
  影响：需要平台外能力，跨 Linux/macOS/Windows 实现不同；用户无感，但工程量大。

建议：在“平台不做沙箱、限制交给部署”的前提下选 B，并在安全模型里明确写清；若要 A/C，
需要先决定 Human 在本机的认证方式。

### 5.2 `device.invite` 默认全权限

现状：不传 scope 时邀请带全部 grants；一次性码可被转发，攻击者配对后获得持久访问。

- **改为默认最小权限（Read + Session，按需加 Files/Preview）。**
  影响：手机配对后可以看会话、发消息，但不能直接跑命令/开终端/改设置；需要这些能力时在
  配对界面显式勾选。现有“手机全权管理机器”的用法多一步；依赖默认全权的自动化/测试要显式
  传 scope。
- **保留全权默认，只在下发邀请时提示。**
  影响：体验不变，但风险仍在；提示很容易被忽略。

建议：默认最小权限，保留“显式全权”入口；这是唯一能限制“邀请码被转发”后果的代码层改动。

### 5.3 受管/普通 SessionController 可改其他普通会话

现状：目标会话不是受管时，`authorize_session_request` 直接放行任何 `SessionController`；
普通 Agent 的 CLI 也能改名/发送/删除同机其他普通会话。

- **按项目作用域收紧**：调用者只能改自己会话、同项目的普通会话、或自己委托的受管子会话。
  影响：团队内前台给同项目 Worker 发消息/改名继续可用；跨项目操作被拒绝。需要跑
  `expert-collaboration` / 团队看板 journeys 验证 team.py 的路径。
- **只允许 LocalUser 改其他普通会话。**
  影响：团队 Agent 之间的协作会断，除非全部改走 Workbench；不建议。

建议：按项目作用域收紧；这是既保留团队、又能挡住跨项目越权的折中。

### 5.4 controller token 无过期

现状：`HMAC(secret, session_id)`，daemon 进程内不变，随环境变量进入 Agent；daemon 重启才失效。

- **绑定到 Agent 进程实例（每次启动随机 nonce）。**
  影响：Agent 重启后旧 token 立即失效，正在后台运行的旧 CLI 命令会 401；正常会话内无感。
- **加固定过期（如 24h/7d）。**
  影响：超过期限的长会话/定时 hook 会失效，且 token 只在 Agent 启动时注入，无法无感续期；
  需要额外刷新通道。

建议：绑定 Agent 进程实例；不做固定过期，避免长会话体验退化。

### 5.5 模板与兼容壳

- **admin Space / `<data>/builtin-skills` 覆盖用户编辑。** 改成保留用户改动会让产品模板
  升级不再可预测，且旧模板会被复制进新团队。折中：覆盖前把差异文件备份到
  `.spacebuilder/backup/<timestamp>/`，并保留“产品自有目录”的语义；用户可恢复但不会自动
  生效。影响是目录里多出备份，不改变升级结果。
- **`expert.py`**：删除会让仍有旧钩子的团队在升级后断链；保留则多一个转发壳。折中：在
  `team.py` 升级时把钩子重写到 `team.py`，之后再删壳；需要一次迁移任务，不能直接删。
