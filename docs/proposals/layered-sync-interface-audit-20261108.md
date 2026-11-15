# 协议、CLI 与上下游审查附录

> 2026-11-15 文档迁移：保留原文日期、事实基线与评审状态；源码行号为历史定位。迁移范围及工作区资料说明见[提案目录](README.md)。

状态：接口级源码审查；真实运行验证另见提案。静态引用不等于运行覆盖，不宣称所有实现逐行审计或所有动作均已实跑。

基线 Open `a301ce11a496a93f090c6b9b5e401e719eee93cb`；Cloud `e7dd53ea04bbddefcb6bf4622cc206b3312c7efc`。

完整枚举 127 个 Request／27 个顶层族；79 个已广告 CLI schema 名；44 个 CLI／frontdoor 源文件共 17612 行；52 个 Cloud 字面 HTTP 路由。

范围以 Rust Request 声明为全量基线。字段签名、全部引用、CLI 源文件内容摘要和 HTTP 路由在 [机器清单](evidence/layered-sync-interface-inventory-20261108.json)。79 个 schema 名不等于完整 CLI grammar：daemon/native 命令、别名、动态 Agent 动词和旁路流另列。

## 按族人工复核与迁移决定

| 族 | 数量 | 事实／执行所有者 | 迁移决定 |
| --- | ---: | --- | --- |
| `agent` | 9 | registry + script Agent runtime | Agent 小头／能力集合；action/reload/test 保留独立动作回执 |
| `agentSpace` | 3 | workspace config + composition | 沿用 expectedRevision 与既有挂载语义；新增同步仅传播已提交观察 |
| `blob` | 2 | session blobs + locator | 沿用 seek/offset/length 和现有内容 id；分清新完整 SHA 与旧截短 id |
| `caller` | 1 | authenticated principal | 保留身份入口；不持久缓存执行授权 |
| `catalog` | 1 | PageCatalog + catalog bus | 迁移到分层条件核对；移除 known 全表；兼容期能力协商互斥 |
| `client` | 1 | client_debug + actual browser | 对嵌套命令分别分类；命令回执与页面观察分别 hash |
| `connection` | 1 | endpoint identity | 保留握手、机器指纹与实例代次；增加能力声明不改变传输 |
| `device` | 6 | device store + admissions | 只同步可展示摘要；兑换／撤权是动作，不能由缓存证明权限 |
| `diagnostics` | 1 | bounded diagnostics rings | 有界观察快照；相对时间与内容分开 |
| `directory` | 2 | OS filesystem | 单层目录清单、显式截断及续读；mkdir 走动作 |
| `file` | 6 | OS filesystem + existing file service | 目录分层、内容按需；写入事件与外部变化均失效同一读模型 |
| `fileAccess` | 2 | config file + expected revision | 复用已有 CAS；同步其展示视图，校准 CLI mutates |
| `git` | 3 | real git process + working tree | 状态／diff 作为观察对象；保留 git 原生写语义，不能只看 HEAD 缓存 |
| `hub` | 7 | Hub service + local link credential | 目录摘要条件核对；票据、登录和配对保留独立协议 |
| `log` | 1 | log files | 分段尾读与内容定位；不把增长日志作为整份 mutable JSON |
| `preview` | 1 | preview feedback files + artifact bundle | 嵌套动作逐项迁移；沿用现有版本与原子 bundle 完成 |
| `process` | 5 | OS inventory + service registry | 带实例代次和新鲜度的观察；stop/kill 回执不冒充已退出 |
| `provider` | 2 | config + provider operation receipt | 沿用 actionId 和状态回执；secret 不进入共享节点／事件 |
| `pty` | 4 | native PTY | 终端实例与状态分层，字节流保留时序和背压；输入按动作确认 |
| `round` | 3 | session round/trunk files | 保留现有分层定位；只处理请求窗口，不全量构造历史 |
| `session` | 43 | session Store + Live + inbox | 摘要／状态／正文分层；保留写锁、格式、输入幂等和取消围栏 |
| `settings` | 4 | config file | 摘要与配置分层；已提交配置更新同一读模型，保持现有原子保存 |
| `speech` | 6 | config + runtime + speech context | 能力／状态／反馈分层；音频流保留分段与时序 |
| `subscribe` | 1 | Live replay + events stream | 沿用 seq/gap/reset；节点 hash 不能替代正文顺序 |
| `unsubscribe` | 1 | peer subscription lifecycle | 沿用取消与资源清理；不增加第二个 broker |
| `update` | 5 | signed component/native updater | 展示状态可同步；保留验签、ABI、原生身份和激活回滚 |
| `workspace` | 6 | config registry + Space files | 配置和发现源保持唯一；分层清单复用 Workspaces，操作回执不等全机刷新 |

## 127 个类型化操作逐项清单

“读”只描述对外业务语义，不保证当前执行成本低；“探测”可能启动进程或网络。“混合”必须看嵌套分支，不能整体声明为可安全重试。下列定位是源定义及候选调用接点；动态 Python argv 和框架分发需结合下文手工调用链。

| 操作 | 分类 | 定义 | daemon／CLI／Client 候选接点 |
| --- | --- | --- | --- |
| `preview.feedback` | 混合 | [packages/proto/src/rpc.rs:33](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/authz.rs:61](../../apps/daemon/src/authz.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:688](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/preview/fileFeedback.ts:7](../../packages/workbench/src/preview/fileFeedback.ts) |
| `client.debug` | 混合 | [packages/proto/src/rpc.rs:35](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:438](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/client.rs:19](../../apps/daemon/src/cli_front/client.rs)<br>consumers: [packages/workbench/src/client-debug/index.ts:62](../../packages/workbench/src/client-debug/index.ts) |
| `connection.identity` | 读 | [packages/proto/src/rpc.rs:39](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/authz.rs:61](../../apps/daemon/src/authz.rs)<br>cli: [apps/daemon/src/cli_front/rpc.rs:127](../../apps/daemon/src/cli_front/rpc.rs)<br>client: [packages/workbench/src/protocol/client.ts:1287](../../packages/workbench/src/protocol/client.ts) |
| `subscribe` | 订阅控制 | [packages/proto/src/rpc.rs:43](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:498](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1253](../../apps/daemon/src/cli_front/converse.rs)<br>client: [packages/workbench/src/protocol/client.ts:1001](../../packages/workbench/src/protocol/client.ts)<br>consumers: [apps/daemon/builtin-skills/genehub-preview/assets/unreal/signalling.py:154](../../apps/daemon/builtin-skills/genehub-preview/assets/unreal/signalling.py) |
| `unsubscribe` | 订阅控制 | [packages/proto/src/rpc.rs:58](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:526](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:1027](../../packages/workbench/src/protocol/client.ts)<br>consumers: [apps/daemon/builtin-skills/genehub-preview/assets/unreal/signalling.py:164](../../apps/daemon/builtin-skills/genehub-preview/assets/unreal/signalling.py) |
| `catalog.sync` | 订阅控制 | [packages/proto/src/rpc.rs:62](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:487](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:890](../../packages/workbench/src/protocol/client.ts) |
| `agent.list` | 读 | [packages/proto/src/rpc.rs:73](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:533](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1112](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/app/WorkbenchApp.tsx:730](../../packages/workbench/src/app/WorkbenchApp.tsx) |
| `agent.refresh` | 探测 | [packages/proto/src/rpc.rs:77](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:537](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2759](../../packages/workbench/src/session/store.ts) |
| `agent.action` | 动作 | [packages/proto/src/rpc.rs:81](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:541](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:745](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:2821](../../packages/workbench/src/session/store.ts) |
| `agent.reload` | 动作 | [packages/proto/src/rpc.rs:85](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:548](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:757](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:2904](../../packages/workbench/src/session/store.ts) |
| `agent.reset` | 动作 | [packages/proto/src/rpc.rs:88](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:560](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:766](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:2913](../../packages/workbench/src/session/store.ts) |
| `agent.test` | 探测 | [packages/proto/src/rpc.rs:91](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:572](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:774](../../apps/daemon/src/cli_front/converse.rs) |
| `agent.logs` | 读 | [packages/proto/src/rpc.rs:98](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:579](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:792](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:2934](../../packages/workbench/src/session/store.ts) |
| `agent.requests` | 读 | [packages/proto/src/rpc.rs:107](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:590](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2850](../../packages/workbench/src/session/store.ts) |
| `agent.requestAnswer` | 动作 | [packages/proto/src/rpc.rs:110](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:597](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2829](../../packages/workbench/src/session/store.ts) |
| `session.create` | 动作 | [packages/proto/src/rpc.rs:118](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:611](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1467](../../apps/daemon/src/cli_front/converse.rs)<br>client: [packages/workbench/src/protocol/client.ts:2398](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/proto/src/lib.rs:127](../../packages/proto/src/lib.rs) |
| `session.createRouted` | 动作 | [packages/proto/src/rpc.rs:152](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:686](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1444](../../apps/daemon/src/cli_front/converse.rs) |
| `agentSpace.configure` | 动作 | [packages/proto/src/rpc.rs:174](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2181](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/space.rs:157](../../apps/daemon/src/cli_front/space.rs)<br>consumers: [packages/workbench/src/session/store.ts:1237](../../packages/workbench/src/session/store.ts) |
| `agentSpace.changePlan` | 动作 | [packages/proto/src/rpc.rs:191](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2160](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/space.rs:139](../../apps/daemon/src/cli_front/space.rs) |
| `agentSpace.children` | 读 | [packages/proto/src/rpc.rs:203](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2201](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/space.rs:97](../../apps/daemon/src/cli_front/space.rs) |
| `session.list` | 读 | [packages/proto/src/rpc.rs:205](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:758](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:852](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/session/store.ts:3686](../../packages/workbench/src/session/store.ts) |
| `session.page` | 读 | [packages/proto/src/rpc.rs:214](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:775](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:811](../../apps/daemon/src/cli_front/query.rs)<br>client: [packages/workbench/src/protocol/session-pages.ts:8](../../packages/workbench/src/protocol/session-pages.ts)<br>consumers: [packages/workbench/src/session/store.ts:3302](../../packages/workbench/src/session/store.ts) |
| `session.get` | 读 | [packages/proto/src/rpc.rs:220](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:793](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1062](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:1548](../../packages/workbench/src/session/store.ts) |
| `session.drafts` | 读 | [packages/proto/src/rpc.rs:230](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:814](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:637](../../packages/workbench/src/session/store.ts) |
| `session.drafts.replace` | 动作 | [packages/proto/src/rpc.rs:232](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:821](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2068](../../packages/workbench/src/session/store.ts) |
| `session.previewAnnotations.get` | 读 | [packages/proto/src/rpc.rs:237](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:828](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/PreviewAnnotation.tsx:100](../../packages/workbench/src/preview/PreviewAnnotation.tsx) |
| `session.previewAnnotations.upsert` | 动作 | [packages/proto/src/rpc.rs:239](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:835](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/PreviewAnnotation.tsx:197](../../packages/workbench/src/preview/PreviewAnnotation.tsx) |
| `session.previewAnnotations.remove` | 动作 | [packages/proto/src/rpc.rs:246](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:855](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/PreviewAnnotation.tsx:218](../../packages/workbench/src/preview/PreviewAnnotation.tsx) |
| `session.components` | 读 | [packages/proto/src/rpc.rs:259](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:870](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:888](../../apps/daemon/src/cli_front/query.rs) |
| `session.inspect` | 读 | [packages/proto/src/rpc.rs:261](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:877](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:906](../../apps/daemon/src/cli_front/query.rs) |
| `session.narrative` | 读 | [packages/proto/src/rpc.rs:267](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:891](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:924](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/session/store.ts:1535](../../packages/workbench/src/session/store.ts) |
| `session.rounds` | 读 | [packages/proto/src/rpc.rs:280](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:914](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:944](../../apps/daemon/src/cli_front/query.rs) |
| `session.context` | 读 | [packages/proto/src/rpc.rs:290](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:935](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:1018](../../apps/daemon/src/cli_front/query.rs) |
| `round.trunk.list` | 读 | [packages/proto/src/rpc.rs:299](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:950](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:963](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/session/ForwardDialog.tsx:189](../../packages/workbench/src/session/ForwardDialog.tsx) |
| `round.trunk.get` | 读 | [packages/proto/src/rpc.rs:308](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:966](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:981](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/session/store.ts:1652](../../packages/workbench/src/session/store.ts) |
| `blob.get` | 读 | [packages/proto/src/rpc.rs:317](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:981](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:1002](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/session/store.ts:1673](../../packages/workbench/src/session/store.ts) |
| `round.trunk.batchGet` | 读 | [packages/proto/src/rpc.rs:322](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:988](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2186](../../packages/workbench/src/session/store.ts) |
| `blob.batchGet` | 读 | [packages/proto/src/rpc.rs:330](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:995](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2221](../../packages/workbench/src/session/store.ts) |
| `session.send` | 动作 | [packages/proto/src/rpc.rs:335](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1002](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1327](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:743](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.artifact.begin` | 动作 | [packages/proto/src/rpc.rs:376](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1130](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/sessionArtifactUpload.ts:30](../../packages/workbench/src/preview/sessionArtifactUpload.ts) |
| `session.artifact.chunk` | 动作 | [packages/proto/src/rpc.rs:382](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1145](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/sessionArtifactUpload.ts:49](../../packages/workbench/src/preview/sessionArtifactUpload.ts) |
| `session.artifact.finish` | 动作 | [packages/proto/src/rpc.rs:392](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1162](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/sessionArtifactUpload.ts:65](../../packages/workbench/src/preview/sessionArtifactUpload.ts) |
| `session.artifact.abort` | 动作 | [packages/proto/src/rpc.rs:399](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1176](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/preview/sessionArtifactUpload.ts:76](../../packages/workbench/src/preview/sessionArtifactUpload.ts) |
| `session.fork` | 动作 | [packages/proto/src/rpc.rs:404](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1186](../../apps/daemon/src/router.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:794](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.forkRouted` | 动作 | [packages/proto/src/rpc.rs:417](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1231](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2266](../../packages/workbench/src/session/store.ts) |
| `session.forkExport` | 读 | [packages/proto/src/rpc.rs:425](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1305](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/app/WorkbenchApp.tsx:832](../../packages/workbench/src/app/WorkbenchApp.tsx) |
| `session.forkImport` | 动作 | [packages/proto/src/rpc.rs:427](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1315](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/app/WorkbenchApp.tsx:792](../../packages/workbench/src/app/WorkbenchApp.tsx) |
| `session.forkImportRouted` | 动作 | [packages/proto/src/rpc.rs:435](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1341](../../apps/daemon/src/router.rs) |
| `session.importList` | 读 | [packages/proto/src/rpc.rs:444](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1391](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2279](../../packages/workbench/src/session/store.ts) |
| `session.import` | 动作 | [packages/proto/src/rpc.rs:452](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1409](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2289](../../packages/workbench/src/session/store.ts) |
| `session.interrupt` | 动作 | [packages/proto/src/rpc.rs:457](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1427](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:847](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:746](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.close` | 动作 | [packages/proto/src/rpc.rs:459](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1434](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:884](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:763](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.archive` | 动作 | [packages/proto/src/rpc.rs:461](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1441](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:912](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/app/ConversationList.tsx:123](../../packages/workbench/src/app/ConversationList.tsx) |
| `session.rename` | 动作 | [packages/proto/src/rpc.rs:469](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1451](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2546](../../packages/workbench/src/session/store.ts) |
| `session.label` | 动作 | [packages/proto/src/rpc.rs:474](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1458](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:942](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:2557](../../packages/workbench/src/session/store.ts) |
| `session.describe` | 动作 | [packages/proto/src/rpc.rs:486](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1465](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:957](../../apps/daemon/src/cli_front/converse.rs) |
| `session.delete` | 动作 | [packages/proto/src/rpc.rs:494](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1472](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2578](../../packages/workbench/src/session/store.ts) |
| `session.setModel` | 动作 | [packages/proto/src/rpc.rs:496](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1479](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1042](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:776](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.switchAgent` | 动作 | [packages/proto/src/rpc.rs:503](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1538](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2383](../../packages/workbench/src/session/store.ts) |
| `session.route` | 动作 | [packages/proto/src/rpc.rs:510](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1560](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1016](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:3553](../../packages/workbench/src/session/store.ts) |
| `session.setMode` | 动作 | [packages/proto/src/rpc.rs:517](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1581](../../apps/daemon/src/router.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:779](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.setEffort` | 动作 | [packages/proto/src/rpc.rs:519](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1596](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1050](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:782](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.setFast` | 动作 | [packages/proto/src/rpc.rs:524](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1611](../../apps/daemon/src/router.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:785](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.setRuntimeAxis` | 动作 | [packages/proto/src/rpc.rs:526](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1619](../../apps/daemon/src/router.rs)<br>consumers: [apps/daemon/builtin-agents/sdk/genehub_agent/serve.py:788](../../apps/daemon/builtin-agents/sdk/genehub_agent/serve.py) |
| `session.respondPermission` | 动作 | [packages/proto/src/rpc.rs:532](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1653](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1182](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:3068](../../packages/workbench/src/session/store.ts) |
| `session.ask` | 动作 | [packages/proto/src/rpc.rs:540](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1635](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:808](../../apps/daemon/src/cli_front/converse.rs) |
| `caller.authority` | 读 | [packages/proto/src/rpc.rs:548](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1707](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:672](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/settings/ProviderConfigurationCard.tsx:21](../../packages/workbench/src/settings/ProviderConfigurationCard.tsx) |
| `provider.list` | 读 | [packages/proto/src/rpc.rs:551](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1708](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/provider.rs:42](../../apps/daemon/src/cli_front/provider.rs) |
| `provider.operation` | 混合 | [packages/proto/src/rpc.rs:553](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:187](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/provider.rs:119](../../apps/daemon/src/cli_front/provider.rs)<br>consumers: [packages/workbench/src/session/store.ts:2651](../../packages/workbench/src/session/store.ts) |
| `settings.get` | 读 | [packages/proto/src/rpc.rs:560](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1739](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/app/WorkbenchApp.tsx:732](../../packages/workbench/src/app/WorkbenchApp.tsx) |
| `settings.setProvider` | 动作 | [packages/proto/src/rpc.rs:566](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:185](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2743](../../packages/workbench/src/session/store.ts) |
| `settings.setAgentPreferences` | 动作 | [packages/proto/src/rpc.rs:598](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1743](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2426](../../packages/workbench/src/session/store.ts) |
| `settings.forgetProvider` | 动作 | [packages/proto/src/rpc.rs:604](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:186](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2800](../../packages/workbench/src/session/store.ts) |
| `speech.capabilities` | 读 | [packages/proto/src/rpc.rs:610](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1750](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/speech.rs:27](../../apps/daemon/src/cli_front/speech.rs)<br>consumers: [packages/workbench/src/speech/useSpeechInput.ts:546](../../packages/workbench/src/speech/useSpeechInput.ts) |
| `speech.settings.setQwen3` | 动作 | [packages/proto/src/rpc.rs:613](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1754](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2774](../../packages/workbench/src/session/store.ts) |
| `speech.runtime.probe` | 探测 | [packages/proto/src/rpc.rs:631](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1778](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/speech.rs:34](../../apps/daemon/src/cli_front/speech.rs)<br>consumers: [packages/workbench/src/session/store.ts:2791](../../packages/workbench/src/session/store.ts) |
| `speech.runtime.configure` | 动作 | [packages/proto/src/rpc.rs:635](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1784](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/speech.rs:50](../../apps/daemon/src/cli_front/speech.rs) |
| `speech.context.preview` | 读 | [packages/proto/src/rpc.rs:643](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1798](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/speech/useSpeechInput.ts:587](../../packages/workbench/src/speech/useSpeechInput.ts) |
| `speech.feedback.record` | 动作 | [packages/proto/src/rpc.rs:654](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1816](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/speech/useSpeechInput.ts:354](../../packages/workbench/src/speech/useSpeechInput.ts) |
| `log.tail` | 读 | [packages/proto/src/rpc.rs:676](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1871](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2673](../../packages/workbench/src/session/store.ts) |
| `diagnostics.snapshot` | 读 | [packages/proto/src/rpc.rs:689](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1890](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:816](../../packages/workbench/src/protocol/client.ts) |
| `update.check` | 探测 | [packages/proto/src/rpc.rs:695](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1903](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2686](../../packages/workbench/src/session/store.ts) |
| `update.appCheck` | 探测 | [packages/proto/src/rpc.rs:700](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1910](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2701](../../packages/workbench/src/session/store.ts) |
| `update.download` | 动作 | [packages/proto/src/rpc.rs:705](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1922](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2713](../../packages/workbench/src/session/store.ts) |
| `update.downloadState` | 读 | [packages/proto/src/rpc.rs:708](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1932](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:1053](../../packages/workbench/src/session/store.ts) |
| `update.dismiss` | 动作 | [packages/proto/src/rpc.rs:715](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1936](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2725](../../packages/workbench/src/session/store.ts) |
| `hub.status` | 读 | [packages/proto/src/rpc.rs:720](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1947](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/desktop.rs:58](../../apps/daemon/src/cli_front/desktop.rs)<br>consumers: [packages/workbench/src/preview/PreviewFloat.tsx:761](../../packages/workbench/src/preview/PreviewFloat.tsx) |
| `hub.pair` | 动作 | [packages/proto/src/rpc.rs:724](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1954](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/desktop.rs:111](../../apps/daemon/src/cli_front/desktop.rs)<br>consumers: [packages/workbench/src/session/store.ts:2965](../../packages/workbench/src/session/store.ts) |
| `hub.trial` | 动作 | [packages/proto/src/rpc.rs:732](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:1977](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:2973](../../packages/workbench/src/session/store.ts) |
| `hub.claimLink` | 动作 | [packages/proto/src/rpc.rs:739](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2001](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/desktop.rs:82](../../apps/daemon/src/cli_front/desktop.rs)<br>consumers: [packages/workbench/src/session/store.ts:2982](../../packages/workbench/src/session/store.ts) |
| `hub.machines` | 读 | [packages/proto/src/rpc.rs:749](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2014](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/machine.rs:131](../../apps/daemon/src/cli_front/machine.rs)<br>consumers: [packages/workbench/src/host/index.ts:429](../../packages/workbench/src/host/index.ts) |
| `hub.connect` | 动作 | [packages/proto/src/rpc.rs:754](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2027](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:1186](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/host/index.ts:424](../../packages/workbench/src/host/index.ts) |
| `hub.unpair` | 动作 | [packages/proto/src/rpc.rs:758](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2037](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/hub.rs:189](../../apps/daemon/src/cli_front/hub.rs)<br>consumers: [packages/workbench/src/session/store.ts:2989](../../packages/workbench/src/session/store.ts) |
| `device.list` | 读 | [packages/proto/src/rpc.rs:763](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2047](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/machine.rs:376](../../apps/daemon/src/cli_front/machine.rs)<br>consumers: [packages/workbench/src/session/store.ts:2994](../../packages/workbench/src/session/store.ts) |
| `device.invite` | 动作 | [packages/proto/src/rpc.rs:775](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2054](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/machine.rs:391](../../apps/daemon/src/cli_front/machine.rs)<br>consumers: [packages/proto/src/lib.rs:276](../../packages/proto/src/lib.rs) |
| `device.claim` | 动作 | [packages/proto/src/rpc.rs:779](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/authz.rs:63](../../apps/daemon/src/authz.rs)<br>cli: [apps/daemon/src/cli_front/rpc_wire.rs:556](../../apps/daemon/src/cli_front/rpc_wire.rs)<br>consumers: [packages/workbench/src/devices/claim.ts:36](../../packages/workbench/src/devices/claim.ts) |
| `device.revoke` | 动作 | [packages/proto/src/rpc.rs:782](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2073](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/machine.rs:417](../../apps/daemon/src/cli_front/machine.rs)<br>consumers: [packages/workbench/src/session/store.ts:3031](../../packages/workbench/src/session/store.ts) |
| `device.remoteAttach` | 动作 | [packages/proto/src/rpc.rs:785](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2083](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:3039](../../packages/workbench/src/session/store.ts) |
| `device.remoteDetach` | 动作 | [packages/proto/src/rpc.rs:796](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2097](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:3046](../../packages/workbench/src/session/store.ts) |
| `workspace.list` | 读 | [packages/proto/src/rpc.rs:800](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2122](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:744](../../apps/daemon/src/cli_front/query.rs)<br>client: [packages/workbench/src/protocol/summary-directory.ts:507](../../packages/workbench/src/protocol/summary-directory.ts)<br>consumers: [packages/workbench/src/app/WorkbenchApp.tsx:731](../../packages/workbench/src/app/WorkbenchApp.tsx) |
| `workspace.open` | 动作 | [packages/proto/src/rpc.rs:802](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2128](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/converse.rs:1518](../../apps/daemon/src/cli_front/converse.rs)<br>consumers: [packages/workbench/src/session/store.ts:1132](../../packages/workbench/src/session/store.ts) |
| `workspace.addRoot` | 动作 | [packages/proto/src/rpc.rs:805](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2135](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:732](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/workspace/AgentDetails.tsx:61](../../packages/workbench/src/workspace/AgentDetails.tsx) |
| `workspace.create` | 动作 | [packages/proto/src/rpc.rs:807](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2146](../../apps/daemon/src/router.rs) |
| `workspace.rename` | 动作 | [packages/proto/src/rpc.rs:809](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2208](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2396](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/session/store.ts:1165](../../packages/workbench/src/session/store.ts) |
| `workspace.remove` | 动作 | [packages/proto/src/rpc.rs:812](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2215](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:758](../../apps/daemon/src/cli_front/query.rs)<br>client: [packages/workbench/src/protocol/client.ts:2397](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/app/MachineDirectoryLists.tsx:208](../../packages/workbench/src/app/MachineDirectoryLists.tsx) |
| `directory.list` | 读 | [packages/proto/src/rpc.rs:818](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2236](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/workspace/OpenProject.tsx:139](../../packages/workbench/src/workspace/OpenProject.tsx) |
| `directory.mkdir` | 动作 | [packages/proto/src/rpc.rs:824](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2243](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/workspace/OpenProject.tsx:236](../../packages/workbench/src/workspace/OpenProject.tsx) |
| `fileAccess.list` | 读 | [packages/proto/src/rpc.rs:828](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2112](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:706](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/settings/FileAccessSettings.tsx:17](../../packages/workbench/src/settings/FileAccessSettings.tsx) |
| `fileAccess.configure` | 动作 | [packages/proto/src/rpc.rs:831](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2115](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/query.rs:712](../../apps/daemon/src/cli_front/query.rs)<br>consumers: [packages/workbench/src/settings/FileAccessSettings.tsx:26](../../packages/workbench/src/settings/FileAccessSettings.tsx) |
| `file.tree` | 读 | [packages/proto/src/rpc.rs:838](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2253](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2386](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/files/FilesPanel.tsx:35](../../packages/workbench/src/files/FilesPanel.tsx) |
| `file.write` | 动作 | [packages/proto/src/rpc.rs:846](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2268](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2387](../../packages/workbench/src/protocol/client.ts) |
| `file.mkdir` | 动作 | [packages/proto/src/rpc.rs:853](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2283](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/files/FilesPanel.tsx:159](../../packages/workbench/src/files/FilesPanel.tsx) |
| `file.copy` | 动作 | [packages/proto/src/rpc.rs:856](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2297](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/files/FilesPanel.tsx:185](../../packages/workbench/src/files/FilesPanel.tsx) |
| `file.move` | 动作 | [packages/proto/src/rpc.rs:863](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2331](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/files/FilesPanel.tsx:185](../../packages/workbench/src/files/FilesPanel.tsx) |
| `file.delete` | 动作 | [packages/proto/src/rpc.rs:870](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2365](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/files/FilesPanel.tsx:242](../../packages/workbench/src/files/FilesPanel.tsx) |
| `git.status` | 读 | [packages/proto/src/rpc.rs:877](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2382](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2393](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/changes/ChangesPanel.tsx:27](../../packages/workbench/src/changes/ChangesPanel.tsx) |
| `git.diff` | 读 | [packages/proto/src/rpc.rs:879](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2393](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2388](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/changes/ChangesPanel.tsx:37](../../packages/workbench/src/changes/ChangesPanel.tsx) |
| `git.commit` | 动作 | [packages/proto/src/rpc.rs:885](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2404](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2394](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/changes/ChangesPanel.tsx:46](../../packages/workbench/src/changes/ChangesPanel.tsx) |
| `pty.open` | 动作 | [packages/proto/src/rpc.rs:895](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2419](../../apps/daemon/src/router.rs)<br>client: [packages/workbench/src/protocol/client.ts:2395](../../packages/workbench/src/protocol/client.ts)<br>consumers: [packages/workbench/src/terminal/TerminalPanel.tsx:54](../../packages/workbench/src/terminal/TerminalPanel.tsx) |
| `pty.write` | 动作 | [packages/proto/src/rpc.rs:903](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2442](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/terminal/TerminalPanel.tsx:68](../../packages/workbench/src/terminal/TerminalPanel.tsx) |
| `pty.resize` | 动作 | [packages/proto/src/rpc.rs:905](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2449](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/terminal/TerminalPanel.tsx:76](../../packages/workbench/src/terminal/TerminalPanel.tsx) |
| `pty.close` | 动作 | [packages/proto/src/rpc.rs:911](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2456](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/terminal/TerminalPanel.tsx:60](../../packages/workbench/src/terminal/TerminalPanel.tsx) |
| `process.list` | 读 | [packages/proto/src/rpc.rs:920](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2463](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/process.rs:47](../../apps/daemon/src/cli_front/process.rs)<br>consumers: [packages/workbench/src/session/store.ts:3014](../../packages/workbench/src/session/store.ts) |
| `process.workspaceList` | 读 | [packages/proto/src/rpc.rs:922](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2469](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/session/store.ts:3013](../../packages/workbench/src/session/store.ts) |
| `process.serviceStop` | 动作 | [packages/proto/src/rpc.rs:925](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2481](../../apps/daemon/src/router.rs)<br>consumers: [packages/workbench/src/processes/ProcessesPanel.tsx:74](../../packages/workbench/src/processes/ProcessesPanel.tsx) |
| `process.kill` | 动作 | [packages/proto/src/rpc.rs:937](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2498](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/process.rs:79](../../apps/daemon/src/cli_front/process.rs)<br>consumers: [packages/workbench/src/session/store.ts:3020](../../packages/workbench/src/session/store.ts) |
| `process.killAll` | 动作 | [packages/proto/src/rpc.rs:940](../../packages/proto/src/rpc.rs) | daemon: [apps/daemon/src/router.rs:2514](../../apps/daemon/src/router.rs)<br>cli: [apps/daemon/src/cli_front/process.rs:129](../../apps/daemon/src/cli_front/process.rs)<br>consumers: [packages/workbench/src/session/store.ts:3025](../../packages/workbench/src/session/store.ts) |

## 嵌套命令和传输入口

- `ClientDebugRequest`：`Register`, `List`, `Poll`, `Decide`, `Complete`, `Attach`, `Status`, `Execute`, `Result`, `Revoke`。[packages/proto/src/client_debug.rs:8](../../packages/proto/src/client_debug.rs)
- `ClientDebugAction`：`Inspect`, `Eval`, `Screenshot`, `Act`, `Events`, `Reload`。[packages/proto/src/client_debug.rs:62](../../packages/proto/src/client_debug.rs)
- `ProviderOperationCommand`：`Prepare`, `Get`, `Submit`, `Verify`。[packages/proto/src/provider_control.rs:25](../../packages/proto/src/provider_control.rs)
- `PreviewFeedbackOperation`：`Source`, `Share`, `Revoke`, `Open`, `Draft`, `Upsert`, `Remove`, `BeginArtifact`, `Chunk`, `FinishArtifact`, `AbortArtifact`, `Submit`, `Read`。[packages/proto/src/preview_feedback.rs:37](../../packages/proto/src/preview_feedback.rs)
- `AgentSpaceOperation`：`SetComponent`, `RemoveComponent`, `SetParent`, `SetLifecycle`。[packages/proto/src/rpc.rs:1161](../../packages/proto/src/rpc.rs)

StreamMethod 有 9 种：`events`, `asset.preview`, `service.preview`, `shell.run`, `file.read`, `rtc.negotiate`, `rtc.config`, `protocol.identity`, `speech.transcribe`（两个常量名以 owning schema 为准）。`rpc` 是上述 127 个业务操作的载体，不计为额外业务操作。

Loopback `/health`、`/shutdown`、`/cli`、WebSocket admission，以及 Host ABI 的 process/PTY/文件/RTC、服务 HTTP/WS 和媒体面板，不是 Request 变体。保留现有控制协议；它们的当前状态和命令回执可以作为节点暴露，实时字节与信令语义继续由原服务拥有。

## CLI 已广告命令的重试语义审查

这里列出当前源码声明值，不代表正确；`workspace.open`、`workspace.add-root`、`file-access.configure` 明确有持久写入但声明 false。`agent.test` 可执行脚本，也不能按纯读重试。需要让 schema 由 owning command 的同一元数据生成，并补副作用与成本／范围合同。

| CLI schema 名 | 当前 mutates |
| --- | --- |
| `schema` | `false` |
| `status` | `false` |
| `daemon.status` | `false` |
| `context` | `false` |
| `capabilities` | `false` |
| `update.check` | `false` |
| `update.live` | `true` |
| `update.app` | `true` |
| `update.status` | `false` |
| `provider.list` | `false` |
| `provider.configure` | `true` |
| `provider.get` | `false` |
| `provider.verify` | `true` |
| `shell` | `true` |
| `file.download` | `true` |
| `file.transfer.status` | `false` |
| `file.transfer.cancel` | `true` |
| `process.list` | `false` |
| `hook.list` | `false` |
| `process.kill` | `true` |
| `process.killAll` | `true` |
| `file-access.list` | `false` |
| `file-access.configure` | `false` |
| `workspace.open` | `false` |
| `workspace.add-root` | `false` |
| `workspace.list` | `false` |
| `workspace.show` | `false` |
| `workspace.remove` | `true` |
| `space.open` | `true` |
| `preview.feedback` | `false` |
| `session.list` | `false` |
| `session.get` | `false` |
| `session.components` | `false` |
| `session.inspect` | `false` |
| `session.narrative` | `false` |
| `session.rounds` | `false` |
| `session.trunks` | `false` |
| `session.trunk` | `false` |
| `session.blob` | `false` |
| `session.context` | `false` |
| `agent.list` | `false` |
| `agent.run` | `true` |
| `agent.show` | `false` |
| `agent.action` | `true` |
| `agent.reload` | `true` |
| `agent.reset` | `true` |
| `agent.test` | `false` |
| `agent.logs` | `false` |
| `session.send` | `true` |
| `session.ask` | `true` |
| `session.respond` | `true` |
| `session.interrupt` | `true` |
| `session.close` | `true` |
| `session.archive` | `true` |
| `session.label` | `true` |
| `session.describe` | `true` |
| `session.model` | `true` |
| `machine.list` | `false` |
| `machine.show` | `false` |
| `machine.pair` | `true` |
| `machine.forget` | `true` |
| `device.list` | `false` |
| `device.invite` | `true` |
| `device.revoke` | `true` |
| `client.list` | `false` |
| `client.attach` | `true` |
| `client.status` | `false` |
| `client.result` | `true` |
| `client.inspect` | `true` |
| `client.eval` | `true` |
| `client.act` | `true` |
| `client.events` | `true` |
| `client.screenshot` | `true` |
| `client.reload` | `true` |
| `client.revoke` | `true` |
| `speech.runtime.status` | `false` |
| `speech.runtime.probe` | `false` |
| `speech.runtime.register` | `true` |
| `speech.runtime.unregister` | `true` |

## Cloud 字面 HTTP 路由清单

这是服务边界审查，不建议把账户数据库复制进 daemon 文件树。常量生成的 admission/presence/revocation 路由由 `fabric-wire.ts` 合同单列，列表不冒充所有 URL 的运行覆盖。

| 方法 | 路径 | 定义 |
| --- | --- | --- |
| POST | `/app/auth/recover` | [server/src/http/app-api.ts:267](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| GET | `/app/me` | [server/src/http/app-api.ts:300](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/feedback` | [server/src/http/app-api.ts:319](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| GET | `/app/machines` | [server/src/http/app-api.ts:453](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/machines/:id/rename` | [server/src/http/app-api.ts:461](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/activations/:code` | [server/src/http/app-api.ts:487](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/machines/:id/connect` | [server/src/http/app-api.ts:555](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/machines/:id/revoke` | [server/src/http/app-api.ts:637](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/links` | [server/src/http/app-api.ts:659](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| GET | `/app/links` | [server/src/http/app-api.ts:698](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/links/:id/revoke` | [server/src/http/app-api.ts:713](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/sessions/:id/revoke` | [server/src/http/app-api.ts:729](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| POST | `/app/sessions/:id/trust` | [server/src/http/app-api.ts:745](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| GET | `/app/audit` | [server/src/http/app-api.ts:761](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/app-api.ts) |
| GET | `/signin` | [server/src/http/auth.ts:75](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| POST | `/signin/email` | [server/src/http/auth.ts:83](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| GET | `/signin/email/:token` | [server/src/http/auth.ts:134](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| POST | `/signin/email/:token` | [server/src/http/auth.ts:153](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| GET | `/signin/github` | [server/src/http/auth.ts:172](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| GET | `/signin/github/callback` | [server/src/http/auth.ts:200](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| GET | `/app/auth/methods` | [server/src/http/auth.ts:233](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| POST | `/app/auth/signout` | [server/src/http/auth.ts:239](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/auth.ts) |
| GET | `/*` | [server/src/http/console.ts:34](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/console.ts) |
| GET | `/api/downloads` | [server/src/http/downloads.ts:503](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/downloads.ts) |
| GET | `/install.sh` | [server/src/http/downloads.ts:535](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/downloads.ts) |
| GET | `/download/:platform` | [server/src/http/downloads.ts:549](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/downloads.ts) |
| GET | `/download/${channel}/:file` | [server/src/http/downloads.ts:581](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/downloads.ts) |
| POST | `/api/device-authorizations` | [server/src/http/enrollment.ts:127](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/device-authorizations/poll` | [server/src/http/enrollment.ts:166](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/trial` | [server/src/http/enrollment.ts:203](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/machines/enroll` | [server/src/http/enrollment.ts:300](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/machines/:daemonId/claim-link` | [server/src/http/enrollment.ts:417](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| GET | `/api/machines/:daemonId/directory` | [server/src/http/enrollment.ts:473](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/machines/:daemonId/tickets` | [server/src/http/enrollment.ts:496](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/machines/:daemonId/preview-shares` | [server/src/http/enrollment.ts:533](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| POST | `/api/preview-shares/redeem` | [server/src/http/enrollment.ts:549](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| DELETE | `/api/machines/:daemonId` | [server/src/http/enrollment.ts:564](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/enrollment.ts) |
| GET | `/setup` | [server/src/http/pages.ts:154](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/pages.ts) |
| GET | `/activate` | [server/src/http/pages.ts:235](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/pages.ts) |
| POST | `/activate` | [server/src/http/pages.ts:299](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/pages.ts) |
| GET | `/link/:token` | [server/src/http/pages.ts:418](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/pages.ts) |
| POST | `/link/:token` | [server/src/http/pages.ts:451](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/pages.ts) |
| POST | `/api/fabric/v2/peer-admissions/check` | [server/src/http/peer-admission.ts:83](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/peer-admission.ts) |
| GET | `/api/rtc/config` | [server/src/http/rtc.ts:52](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/rtc.ts) |
| POST | `/api/rtc/credentials` | [server/src/http/rtc.ts:62](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/rtc.ts) |
| POST | `/api/fabric/v2/endpoints` | [server/src/http/workspace-catalog.ts:101](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspace-catalog.ts) |
| PUT | `/api/fabric/v2/workspace-catalog` | [server/src/http/workspace-catalog.ts:137](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspace-catalog.ts) |
| POST | `/api/fabric/v2/routes` | [server/src/http/workspace-catalog.ts:248](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspace-catalog.ts) |
| GET | `/app/workspaces` | [server/src/http/workspaces.ts:46](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspaces.ts) |
| POST | `/app/fabric/endpoints` | [server/src/http/workspaces.ts:62](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspaces.ts) |
| POST | `/app/fabric/routes` | [server/src/http/workspaces.ts:118](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/http/workspaces.ts) |
| GET | `/api/health` | [server/src/main.ts:166](https://github.com/aikenc/genethub-cloud/blob/1f365d620a4b6cbe8ae9e972de46fb4d4e8a232e/server/src/main.ts) |

## 调用链与具体发现

1. Native CLI `apps/cli/src/main.rs → invoke.rs → POST /cli → cli_front/mod.rs`。本地业务走 `cli_front/rpc.rs → router::handle`；远端走 `rpc_wire.rs → Fabric`。本地并不为每条业务再建一个 loopback WebSocket；不能把本地 CLI 开销误归因于建连。原生 daemon/update/agent-serve 必须继续留在原所有者。

2. `session list --lean/--active → query.rs:execute → session.page loop` 自动读到末页；`session get → recent_rounds: None`。按项目过滤并不等于有界读取。新 CLI 必须一次只返回显式页与 nextCursor；完整活动集合另有 complete 合同，不能以一页作为总数。

3. `inspect/narrative/rounds/context → SessionManager::read_view` 克隆叙事和 round，完整编码并计算 digest 后才截页；`history_snapshot` 也先构造快照再截窗口。已有物理 round/trunk/blob 分层与 seek locator 必须复用，优化要落到读取源而非仅缩小回包。

4. `catalog.sync → session/catalog.rs → PageCatalog + Live/coordination` 已有单行 ETag、活动候选、条件修复、128KiB 分块和 64MiB 快照上限。`known_sessions` 仍上传完整已缓存读集；修复逐项投影/hash。新机制应替换这条读集核对，不能再叠一套 rows、replay ring 或订阅生命周期。

5. `MachineSummaryDirectory → summary-directory-cache.ts → IndexedDB` 当前按来源保存一份目录，写入会排序最近 500 条历史、重算该来源的 checksum 并 put。已有账号／机器／指纹隔离和清理必须保留；节点级写入要同时替换旧来源整份写入，不得双写两套缓存。

6. 内置 team `team.py:session_snapshot_by_workspace` 调用无范围 `session list --lean`；`inspection` helper 用 inspect 取状态。`board.py` 虽改读 active，仍会周期性读完整活动集合。`tasks.py/runtime.py` 创建／投递依赖 messageId、creationId 和持久义务。必须迁移源模板并保留已部署用户修改；不能只封 CLI 留旧脚本报错。dev-2 尚未合入的禁用／分页合并候选也需纳入迁移对照。

7. Store `SESSION_FORMAT=10`；meta 不仅有标题，还含 inbox、执行围栏及清理回执。旧 `docs/session-storage.md` 仍有历史格式示例，不能将其作为最新 schema。把 meta/state/receipts 直接拆开会破坏已接收输入原子性。现有 writer.lock、tombstones、creation.json、inbox digest 和 provider receipts 要分别继承。

8. `files.rs` 单目录最多 2000 项／树最多 10000 节点；`workspace::list_directory` 取前 2000 项后排序。协议没有通用 complete/continuation，错误项也可能跳过。新清单必须区分未展开、截断、未知和确认不存在。

9. `file.read` 已有 offset、FileIdentity、expect 和可选整文件 SHA-256；preview 有版本与 representation，Host 有 image cache。不要新增重复下载器。非平台写入、Git checkout、软链接、跨渠道、外接卷变化均可能绕过内部事件；watch 只能加速发现，仍需受预算限制的对账。

10. `blocking::WorkBudget` 约 4ms 协作让出；WASI 没有 blocking pool，单次同步文件操作返回前无法让出。新 hash 路径仍需有界工作片和写锁外编码；Node 原型的耗时不能替代 Wasmtime 下的前台延迟证据。

11. Cloud `workspace_catalog_heads` 已有 generation/revision/snapshot_hash，workspace placements 由服务维护；Console `cloudHost` 负责账号目录与票据，Relay 只转发 opaque Fabric 数据。保留 Hub、daemon 与浏览器三种身份；新资源 ID 不能把 Hub workspace ID、daemon workspace ID、root handle 或文件路径混成同一个键。

12. Git／进程／PTY／语音／client.debug／update 都已审查其 owning dispatch 和类型。统一它们的发现、摘要、引用和回执，不把 shell、设备操作、媒体信令或软件激活变成可任意重放的状态覆盖。签名制品的 hash 校验与应用数据 hash 的用途不同，保留现有签名、ABI、原生身份与回滚流程。

13. Agent 下游为 `adapter/mod.rs` 的统一 Adapter 边界，registry 读取脚本自身的 state，`adapter/script/rpc.rs` 以 stdio JSON-RPC 2.0 管理 request/notification/Exited；内置 Agent 的 `apps/agent/src/protocol.rs` 同时影响持久消息。新 hash 只针对统一表示，不能用公共缓存重放供应商私有事件或替代 opaque resume handle。Usage 含 u64，Cost 含 f64，是整数实验 profile 不能声称覆盖全部数据的直接证据。

14. `packages/proto/src/remote_desktop.rs` 是 Service Preview 上的应用消息，不是额外 daemon Exchange。Capture `state.rs/guard.rs` 与 workbench `serviceClient.ts` 共享 session、epoch、targetGeneration、seq 和 held-state/reset；坐标与滚轮有浮点。保留实时控制的顺序、释放与超时语义，重复内容不代表可去重的重复按键；pixel-streaming 信令也由原服务拥有。摘要／实例可对象化，不能把过时输入按事件 hash 自动重放。

## 审查边界

已完成：声明级全量枚举；各方法族的分发、所有者、主要消费者与迁移决定；上述关键读写链路人工检查。未完成：每个方法所有失败分支逐行形式审计、所有供应商 Agent 的私有数据库分析、127 个方法的真实逐项运行、多机公网/手机/Windows/macOS/浏览器的重构后验收。以上均不由静态脚本或本轮原型冒充。
