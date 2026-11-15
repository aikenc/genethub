# GeneHub 设计提案与历史记录

2026-11-15 从 `spaces/dev-3/docs/` 迁入项目仓，保存 21 份文档和 9 份 JSON 配套证据。
文档随产品分支提交，之后清理或复用开发槽位不会删除已提交的提案。

## 同步体系

当前讨论入口是[同步内核 v9：用统一状态面简化平台，支撑十几台机器与大量 Agent 协同](sync-kernel-v9-20261115.md)，2026-11-15，状态为待评审，尚未实施。执行方式见[落地与迭代打磨方案](sync-kernel-landing-20261115.md)。v9 取代 v8 的目标、范围、拓扑、迁移顺序与验收；v8 的数据源合同、首期内核删减与存活方向，以及 v7 的节点树、令牌与协议章节继续有效。

| 文档 | 用途 |
| --- | --- |
| [同步内核 v9](sync-kernel-v9-20261115.md) | 当前入口：一条权威规则加三个原语、机器间订阅与汇聚转发、应用子树与变化触发 hook、全量迁移清单、复杂度增减评估 |
| [同步内核落地与迭代打磨方案](sync-kernel-landing-20261115.md) | v9 的执行配套：文档关系与优先级、阶段与槽位、协议结构目标形态、Harness 循环接入与同步红线/警告线、Harness 扩展拟议 |
| [同步内核 v8](sync-kernel-v8-20261115.md) | v9 引用的数据源可靠性合同、首期内核删减、存活方向；执行分区降为由实测触发的后续项 |
| [同步内核 v7](sync-kernel-v7-20261108.md) | v8 引用的节点树、令牌与协议设计 |
| [同步核心 v6](sync-core-v6-20261108.md) | v7 引用的边界、存储与应用场景 |
| [统一节点同步体系 v5](unified-node-sync-system-v5-20261108.md) | 平台应用细节及规模目标 |
| [统一信息同步架构 v4](unified-state-sync-architecture-v4-20261108.md) | 历史源码分析与案例依据 |
| [统一信息同步架构 v3](unified-state-sync-architecture-v3-20261108.md) | 历史版本 |
| [分层文件 hash 方案 v2](layered-file-hash-sync-proposal-v2-20261108.md) | 历史版本 |
| [分层文件 hash 初稿](layered-file-hash-sync-proposal-20261108.md) | 初期实验与取舍；部分原型文件已不在当前检出 |
| [协议、CLI 与上下游审查附录](layered-sync-interface-audit-20261108.md) | 历史接口清单，实施前需按最新代码复核 |

## 平台简化与权限

以下保留各自编写时的结论和候选状态。完整连接简化的旧候选后来已合入主干：Open 的 [PR #71](https://github.com/aikenc/genethub/pull/71) 与 Cloud 的 [PR #37](https://github.com/aikenc/genethub-cloud/pull/37)。历史文档中的“待合入”等字样描述当时状态，不是当前发布状态。

- [平台层简化初稿](platform-simplification-proposal-20261028.md)
- [平台层简化 v2](platform-simplification-proposal-20261028-v2.md)
- [平台层简化 v3](platform-simplification-proposal-20261028-v3.md)
- [平台审计发现](platform-audit-findings-20261029.md)
- [下一步简化可行性](next-simplification-feasibility-20261029.md)
- [完整连接权限与简化提案](agent-authority-simplification-proposal-20261029.md)
- [权限与简化实施交接](agent-authority-simplification-handoff-20261029.md)

## 团队与连接

- [团队可靠性改进提案](team-reliability-improvement-proposal-20261026.md)
- [连接稳定性提案迁移记录](connection-stability-proposal-20261024.md)：历史指向 dev-2 的记录，当前页面不包含该提案全文。

## 历史交付记录

- [阶段性收尾](stage-closeout-20261029.md)
- [完整连接简化实施记录](full-agent-simplification-progress-20261030.md)
- [完整连接简化验证记录](full-agent-simplification-final-validation-20261030.md)
- [完整连接简化候选与收尾](full-agent-simplification-closeout-20261030.md)

## 引用与迁移边界

[迁移清单](migration-manifest.json)逐文件记录原始和迁入后的 SHA-256，以及每个改写引用的去向。9 份 JSON 证据保持原始字节，其中的旧路径、版本和测试资格属于当时的观察，不能当作当前验收结果。

同仓源码链接可在普通检出中打开；Cloud 源码链接固定在迁移时核验的提交，需要对应仓库访问权限。源码行号保留原文历史定位，本文没有重新评审旧方案或刷新源码分析。

原文还引用了开发槽内的跑测摘要、回执、其他槽位提案和 Skill 指导。这些文件不属于本次迁入的 30 个文件，仍留在原工作区；引用已改为注明原位置的文本，并在迁移清单中记录可用性与摘要。缺失的历史原型明确标记为当前检出不存在，未伪造可访问链接。后续执行时必须重新取证，不能仅凭这些历史引用宣称验证通过。
