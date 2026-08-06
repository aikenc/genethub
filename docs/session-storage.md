# 会话存储布局：路径即索引

上位事实来源是 [architecture.md](./architecture.md)。本文只管一件事：会话在磁盘上怎么放，以及为什么这么放能让「打开一个跑了三天的会话」和「打开一个刚建的会话」花一样的力气。

三层寻址模型（session / round / blob）的动机、trunk 与 batch 的切分规则见 `docs/agent-analysis-substrate-proposal.md`。本文承接它，只回答**物理布局**。

---

## 1. 为什么要重排

分层是在协议上做的，磁盘上从来没有分过层。旧布局是这样：

```text
<data>/sessions/<workspace>/<session>.jsonl          每个 settled item 一行，包括每次工具调用
<data>/sessions/<workspace>/<session>.rounds.jsonl   RoundRecord，内含全量 itemIds 与 trunkSummaries
<data>/sessions/<workspace>/<session>.blobrefs.jsonl itemId -> BlobRef
<data>/sessions/<workspace>/<session>/blobs/<hh>.batch
```

于是每一层的定位都是**顺序扫描**，而且扫描的对象里混着正文：

| 操作 | 旧实现的真实代价 |
|------|------------------|
| 打开会话 | 解析整个 `.jsonl`（一天的 round ≈ 5000 行），全量 `condense_item`，不一致时整文件重写，然后全部常驻内存 |
| `round.trunk.get` | 对全部 items 建 HashMap 定位 trunk 边界，再把整个 `.blobrefs.jsonl` 读成 HashMap |
| `blob.get` | 顺序扫 `<hh>.batch` 并逐行反序列化，直到 hash 相等 |
| 写一条 blob | 同样扫一遍整桶做去重判断 |

最后一条最贵：桶里装的是正文，一天 5000 次写入意味着反复读解 GB 级 JSON，而且越写越慢。提案 §3.6 第 1 条本来就写了「定位不能靠扫，引用必须带 offset 与 length」——这条一直没落实。

**结论：字节预算治住了链路，没治住 IO 和 CPU。** 重排要做的就是把三层从「协议概念」变成「目录结构」。

---

## 2. 理念：路径即索引

一次读取应该由**路径直接定位到文件，由文件本身定位到内容**，不需要任何一次全量扫描，也不需要维护一份独立的索引结构。

推论有三条，后面每个决定都从它们出来：

1. **按身份寻址的东西用路径。** 一个会话一个目录，一个 round 一个目录，一个 trunk 一个文件。
2. **按内容寻址的东西用引用。** blob 无法从路径定位到字节区间，所以**引用自身必须完整**——桶、偏移、长度都在引用里。持有引用的那一行就是它的索引。
3. **任何一次读取的成本，只与它要展示的东西成正比。** 不与会话总长、round 总长、blob 总量成正比。

---

## 3. 布局

```text
<sessions-root>/<session-id>/
  meta.json                        会话元数据
  chat.jsonl                       会话层：叙事行 + 每个 round 一行折叠态
  rounds/r-000/index.jsonl         round 层索引：一行一个 trunk 摘要
  rounds/r-000/t-0000.jsonl        trunk 明细：batch 行与 blob overview 行
  rounds/r-000/t-0001.jsonl
  rounds/r-001/…
  blobs/b-9f.jsonl                 blob 正文，按内容 id 前两位合批
  state/                           adapter 私有 scratch
```

会话目录**自包含**：除了 `meta.json` 里记的 `workspaceId`，没有任何一个文件名依赖外部上下文。整个目录可以整体移动、整体删除、整体备份。

> `<sessions-root>` 今天是 `<data>/sessions/<workspace-hash>/`。会话目录自包含之后，把它换成工作目录内的 `<work>/.genethub/sessions/` 只是换一个根，不动本文任何一条规则。真要搬还需要另外三件事：写 `.git/info/exclude` 而不是 `.gitignore`、workspace observation 排除自己、以及一个中心工作区注册表来支撑横向查询——那是另一项任务。

### 3.1 chat.jsonl

一行一个 JSON 对象，`t` 是行类型，追加写。

```jsonc
{"t":"item","item":{"type":"userMessage","id":"…","text":"帮我重构存储层"}}
{"t":"round","roundId":"rd_…","ord":0,"userItemId":"…","startedAtMs":…,"endedAtMs":…,
 "outcome":"completed","trunkCount":12,"adapterTurnIds":["…"],"blockedMs":0}
{"t":"item","item":{"type":"assistantMessage","id":"…","text":"改完了，验证通过。"}}
```

- `item` 行是会话叙事：`userMessage`、`assistantMessage`、`todo`、`error`、`compaction`、`turnSummary`。**`toolCall` 与 `reasoning` 永远不出现在这里**，它们属于 round 层。
- `round` 行是折叠态需要的全部信息，同时**取代了旧的 `RoundRecord`**。它不再携带 `itemIds`（work item 现在由路径定位）也不再携带 `trunkSummaries`（挪进了 round 索引）。
- round 开始时先写一条只有 `userItemId` 与 `startedAtMs` 的 provisional 行，结算时再追加一条完整行；读取按 `roundId` 后写覆盖先写。保持只追加、不回改。

一个 round 跑一天，chat.jsonl 只增长两行。这是「打开会话与 round 长度无关」的根据。

### 3.2 rounds/r-NNN/

`NNN` 是 round 在会话内的序号，与 `chat.jsonl` 里的 `ord` 一致。协议里用的是 `roundId`，映射关系在 chat.jsonl 里，而它在打开会话时已经读过了。

`index.jsonl` 一行一个 trunk 摘要，就是线上的 `RoundTrunkSummary`：

```jsonc
{"index":0,"firstItemId":"…","blobCount":100,"title":"先把 store 的读写面摸清楚","batches":[…]}
```

`t-NNNN.jsonl` 是这个 trunk 的明细，顺序读一遍就能直接拼出线上的 `RoundTrunk`：

```jsonc
{"t":"batch","index":0,"firstItemId":"…","blobCount":16,"text":"先读 store.rs","monologue":"我先把…"}
{"t":"blob","itemId":"…","kind":"toolCall","overview":"cargo test -p genehub-daemon · 通过",
 "blob":{"id":"9f3ac1…","bytes":20480,"at":"9f:81920:20480"}}
```

一个 trunk 最多 100 个 blob（`TRUNK_MAX_BLOBS`），每个可见 batch 最多 16 个（`BATCH_MAX_BLOBS`），所以单个 trunk 文件稳定在几十 KB。`trunk.get` = 打开一个小文件读完，**不需要 offset 运算，也不存在偏移漂移**。

trunk 索引与 trunk 明细分开，是因为 `trunk.list` 只要标题和计数；把明细混在同一个文件里会让翻索引付明细的钱。

### 3.3 blobs/

```text
blobs/b-<id 前 2 位>.jsonl
```

一行一条，追加写，行内是 `{"id":…,"value":…}`。桶前缀取内容 id 的前两位，即 256 个桶。

**内容 id 是 SHA-256 的前 24 个十六进制字符（96 位）。** 单会话十万条量级的碰撞概率在 10⁻¹⁹ 量级，可以忽略；换来的是每个引用省下 40 字节，而引用在 trunk 文件里是逐条出现的。

**为什么是 2 位而不是 3 位。** 桶前缀唯一的作用是决定文件数量与单文件大小——查找由引用里的 offset 完成，与桶数无关。3 位（4096 桶）会让一个 300 条 blob 的普通会话散成近 300 个文件、一个三天会话散成近 4000 个；2 位在同样场景下是约 177 个和 256 个。删除会话要 unlink 的文件数、rsync 与备份要遍历的元数据，都按文件数走。桶多只在「靠扫描定位」时有价值，而扫描正是这次要删掉的东西。

**引用带定位，所以不需要 blob 索引文件。**

```rust
pub struct BlobRef {
    pub id: String,   // 24 位十六进制内容 id
    pub bytes: u64,
    pub at: String,   // "<bucket>:<offset>:<length>"，对客户端不透明
}
```

`blob.get` 拿着这个引用回来，daemon 一次 seek、一次定长读、一次解析，并校验读到的 id 与请求一致。`at` 是会话自己存储内的偏移，客户端本来就有权读这段内容，暴露它不产生越权；但仍要做边界检查与长度上限，避免构造出的偏移让 daemon panic 或吃内存。

**内容寻址在这里买的是不可变与稳定命名，不是去重。** 每个 payload 都嵌着它所属 item 的唯一 id，所以两个不同 item 永远不会哈希相同，没有可折叠的东西。曾经加过一张进程内 id→引用表想「顺手去重」，实测命中率为零，却让每个会话常驻一张随 blob 数无上限增长的 map——正是这次重排要消除的那类内存。已经删掉。真要跨重启去重，代价是打开会话时加载全量 id 索引，等于把刚砍掉的 O(N) 请回来。

**桶文件可以很大，这不是问题。** 一条 100MB 的构建日志就是桶里的一行。读取按 offset 定长取，不受文件总长影响；写入是追加，也不受影响。真正会被文件大小拖垮的是顺序扫描，而这里已经没有顺序扫描了。

---

## 4. 复杂度对照

N = 会话总 item 数，R = round 数，T = 某个 round 的 trunk 数，B = 一个 trunk 内的 blob 数（≤100）。

| 操作 | 旧 | 新 |
|------|-----|-----|
| 打开会话（layered） | O(N) 读 + O(N) 解析 + O(N) 常驻 | O(叙事行 + R) 读，最后 round 再加 O(T) + O(B) |
| `round.trunk.list` | O(N) | O(T)，只读一个 index 文件 |
| `round.trunk.get` | O(N) 建 HashMap + O(N) 读 blobrefs | O(B)，读一个小文件 |
| `blob.get` | O(桶字节) 扫描 + 全量反序列化 | 一次 seek + 定长读 |
| 写一条 blob | O(桶字节) 扫描去重 | 一次追加，无查重 |
| 结算一个 round | 写一行含全量 itemIds 的记录（一天级约 250KB） | 写一行折叠态（约 300 字节） |
| 常驻内存 | 全部 items | 叙事 + 当前 round 的活跃 trunk |

三天、四个 round、其中一个跑满一天的会话，打开时读的字节从「整条时间线」降到「叙事 + 4 行 round + 1 个 trunk 索引 + 1 个 trunk 明细」。

---

## 5. 被这次改动删掉的东西

**`layered:false` 的全量时间线。** 新布局下重建一条完整时间线要打开每个 round 的每个 trunk 文件再归并，正是重排要消灭的 O(N)；而带宽上它本来就是无上限的。核查过消费者：`packages/web` 始终传 `layered:true`，relay 只转发不解析这个字段，CLI 还没有会话面，只有 `testing/` 在用 `false`。为一个没有生产消费者的路径保留一套更差的读法，是纯负债。`subscribe` 的 `layered` 参数一并去掉，分层成为唯一行为。

**`session.rounds.jsonl` 与 `RoundRecord.item_ids`。** 前者的内容并进了 chat.jsonl 的 round 行，后者不再有存在理由：work item 由 `rounds/r-NNN/t-NNNN.jsonl` 的路径定位，不需要一份 id 清单来指认归属。

**`session.blobrefs.jsonl`。** 引用内联进 trunk 行。

---

## 6. 迁移

旧布局与新布局不共存。会话第一次被打开时**一次性重写**，与既有的 `ensure_rounds_migrated` 同一套纪律：

1. 读旧 `.jsonl`、`.rounds.jsonl`、`.blobrefs.jsonl` 与旧 blob 批文件。
2. 按旧账本的 round 分段；旧账本缺失时退回「一个 adapter turn 一个 round」，标 `synthesized: true`。
3. 用与运行时同一个 `TrunkBuilder` 重新切分 trunk，写出新目录。
4. 旧 blob 正文按新 id 与新桶重写，得到带 offset 的引用。
5. 全部写完并 fsync 后才删旧文件；中途失败保留旧文件，下次打开重来。

判据是新目录里 `chat.jsonl` 是否存在，与旧迁移一样只看文件在不在、不看内容多少。已经被历史 `replace_items` 抹掉的正文**不可恢复**，迁移不假装能取回，那些 item 迁过来时没有 blob 引用。

---

## 7. 验收

- **打开成本与历史无关：** 一个含 5000 次工具调用、正文合计 500MB 的会话，layered 打开读取的字节数与一个只有 3 轮对话的会话在同一量级；抓包不含任何 blob 正文。
- **展开成本有界：** `trunk.get` 读取的字节只与该 trunk 的 ≤100 条 overview 有关，不随 round 总长增长，也不触发同 round 内其他 trunk 的读取。
- **blob 定位不扫描：** 写入 5000 条 blob 的总读字节数与已写入总量无关（旧实现是平方级）；`blob.get` 的读取字节数等于该 blob 自身长度。
- **边界：** batch 第 16 条关闭、trunk 第 100 条关闭；无独白时 batch 文本回退到首个 thinking 前 100 字，再回退到「调用了 N 次工具」。
- **迁移幂等：** 同一个旧会话连续冷启动两次，第二次不再重写；迁移中途杀掉进程，旧文件仍在且下次能重来。
- **删除彻底：** `session.delete` 删掉整个会话目录，包括 blobs 与 scratch。
