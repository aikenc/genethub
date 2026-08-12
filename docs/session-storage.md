# 会话存储布局：路径即索引

上位事实来源是 [architecture.md](./architecture.md)。本文只管一件事：会话在磁盘上怎么放，以及为什么这么放能让「打开一个跑了三天的会话」和「打开一个刚建的会话」花一样的力气。

三层寻址模型（session / round / blob）的动机、trunk 与 batch 的切分规则见 `docs/agent-analysis-substrate-proposal.md`。本文承接它，只回答**物理布局**。

---

## 1. 为什么要重排

分层是在协议上做的，磁盘上从来没有分过层。旧布局是这样，全部在 daemon 自己的数据目录下：

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
<workspace>/.genethub/sessions/<session-id>/
  writer.lock                      此会话写入权的内核锁，内容始终为空
  writer                           持锁者的名字，只用于提示
  meta.json                        会话元数据，含数据格式版本号
  chat.jsonl                       会话层：叙事行 + 每个 round 一行折叠态
  rounds/r-000/index.jsonl         round 层索引：一行一个 trunk 摘要
  rounds/r-000/t-0000.jsonl        trunk 明细：batch 行与 blob overview 行
  rounds/r-000/t-0001.jsonl
  rounds/r-001/…
  blobs/b-9f.jsonl                 blob 正文，按内容 id 前两位合批
  state/                           adapter 私有 scratch
```

会话目录**自包含**：没有任何一个文件名、也没有 `meta.json` 里的任何一个字段依赖外部上下文——它属于哪个工作区由它躺在哪里决定（§3.4）。整个目录可以整体移动、整体删除、整体备份，换一个 channel 打开也还是同一批对话。

### 3.0 会话存在工作区里

根是**工作区自己的目录**，不是 daemon 的数据目录。一段对话是关于一堆代码的，它就跟着那堆代码走：复制项目连历史一起复制，删掉项目历史也一起没，卸载 GeneHub 不带走任何人的东西。

只有工作区注册表知道每个 workspace id 落在哪个目录，所以它在注册工作区的同一处告诉 `Store`（`Workspaces::load` / `open`）。工作区未激活时，它的会话就不进入当前索引——这是诚实的答案，好过在某个兜底目录里给出一个路径。`workspace.remove` 保留带原 id 的登记墓碑，但从 Store 卸载路径；重新打开同一个首根会恢复映射与全部历史。列会话因此也只列已激活工作区，跨机器的横向查询要靠 Hub，不靠扫本地磁盘。

`.genethub/` 建立时做两件事，都在任何会话文件落盘之前：

- **`chmod 700`**。会话在数据目录里时是 owner-only 的，搬进用户项目不能顺手放宽。
- **写一份内容为 `*` 的 `.gitignore`**，整个目录自我忽略。否则用户发出第一条消息后看到的第一件事，是自己的 `git status` 里多出一堆会话文件。

用 `.gitignore` 而不是 `.git/info/exclude`：前者对非 git 仓库、对 jj/hg、对还没 `git init` 的目录同样成立，且一份文件解决所有情况，不需要探测版本控制系统。

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

### 3.4 跨 channel 共用一个工作目录

会话存在项目里，就意味着 beta、正式版、各个 dev 版本对着同一个目录时看到的是**同一批对话**。这是「跟着代码走」这个决定的直接后果，也是它真正的价值：换个通道装一次，历史还在。要让这件事成立，四个问题必须先答清楚。

**身份由位置决定，不由文件内容决定。** `workspaceId` 是每次安装各自随机生成的 uuid，beta 写下的那个对正式版毫无意义。所以它**不再存进 `meta.json`**，而是在读取时由会话所在的目录反推——目录本身就是那个不会变的事实。这也是「路径即索引」在身份上的同一条规则。

**版本号是会话级的一个整数。** `meta.json` 里的 `format` 说明这份会话是什么形状写下的（当前为 `4`）。读的时候先只解析 `{format, title, createdAtMs, updatedAtMs}` 这个**永不改形状的头部**，再决定要不要解析其余部分：一个必须先完整解析成功才能发现的版本号，等于没有版本号——它要应付的恰恰是「文件其余部分已经变了」的情况。

- `format` 高于本机支持：会话**仍然列出**（它就在用户自己的项目文件夹里，无声消失比一行灰掉的记录糟糕得多），但打不开。列表行带 `unsupported: {written, supported}`，前端灰掉并说明「升级后才能打开」；daemon 侧任何 `live()` 一律拒绝。
- `format` 缺失：按 `4` 处理，那是唯一进过工作目录的布局。
- **只读不升级。** 只有写操作会把 `format` 盖成本机版本，而且是在 `save_meta` 里统一盖的，不靠每个调用点记得。旧版本读一遍新会话不会改变任何东西。
- **什么时候该 +1：** 只有当旧版本读了会**读错**的时候。加字段不算——serde 会忽略不认识的字段，旧版本照常工作，为此升版号纯属把人白白挡在外面。每次 +1 对新版本写过的每个会话都是单向门，这个分量正合适。

**写入互斥用 `<session>/writer.lock`。** 两个 daemon 同时往同一个 `chat.jsonl` 里追加 round，谁也说不清结果。所以第一次写入某个会话时抢一把内核文件锁（`fs2::try_lock_exclusive`），拿到才写。锁不放在 workspace：不同 channel 可以同时在同一项目里写不同会话，从已完成 turn Fork 出来的新会话也不会被源会话的 writer 阻塞。

滚动升级期间，新版还会共享持有旧 `<work>/.genethub/owner.lock`：多个新版的共享锁互不阻塞，但会与旧版的 workspace 排他锁互斥。这样旧、新 channel 不会因锁协议不同而双写；全部升级后它只是一道无竞争的兼容门，不再限制 workspace 并发。

- **在第一次写入时抢，不在注册工作区时抢。** 否则用户随手打开一个目录就会在里面留下 `.genethub/`。
- **抢不到只影响这个会话的写，不影响读或其他会话。** 列表照列、会话照开，其他会话照常创建和续聊；写的时候才指出持有者，并提示可从已完成 turn Fork。
- **持有者的名字写在旁边的 `writer` 里，锁文件本身永远是空的。** Windows 的排他锁连读一起挡，写在锁文件里的名字恰恰是需要读它的那个进程读不到。这个文件只用于凑出一句能读的话，判定始终是内核锁。
- **不需要清理陈旧锁。** 内核锁在进程崩溃时也会释放，而且每次写入都会重试一次，对方一退出这边立刻恢复，不用重启。
- **判断「锁被占用」不能只看 `ErrorKind::WouldBlock`。** Windows 报的是 `ERROR_LOCK_VIOLATION`，不映射到任何 kind，只看 kind 会把「别人拿着」读成「这个文件坏了」。判定收在 `lifecycle::lock_contended` 一处。

**resume 句柄可能失效，失效不等于会话报废。** `meta.json` 里的 `persist` 指向的是 agent CLI 自己的线程库（`~/.codex/` 之类），不在会话目录里：CLI 可能自己清过，项目也可能被复制到一台从没有过那些线程的机器上。这时候硬报错等于把这段对话永久锁死。做法是**退回新开一个线程**，同时往时间线里写一条明确的话说「它不再记得上面的内容」——这是用户唯一不能靠猜的事。失败的句柄随即清掉，不让后面每次启动都重付一遍这个发现成本。

> 内置 agent 是例外：它的状态就在 `<session>/state/genet/`，跟着会话目录走，所以换个 channel 打开照样接得上。外部 agent 的上下文在用户 home 下，同机器上各 channel 本来就共享，跨机器则天然接不上——正是上面这条降级要兜的情况。

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

## 6. 不迁移

旧布局的会话**不搬**，代码里也没有搬运它们的路径。

一度写过一个：打开会话时把旧的 `.jsonl` / `.rounds.jsonl` / `.blobrefs.jsonl` 重切成新目录。它连着 `LegacyRound`、`migrate_legacy` 和一组只有它用得上的 `Store` 私有方法，是这套存储里最大的一块代码，服务的却是一批开发期数据——没有任何生产用户的会话是旧格式。两次布局变更之间还要维持它同时理解两种形状，成本会一直付下去。删掉了。

结果是：旧目录里的会话不再出现在列表里，也打不开。它们的文件还在原地，谁想要可以自己去 `<data>/sessions/` 拿。这是一次性代价，换掉的是长期背着一条没人走的代码路径。

---

## 7. 验收

- **打开成本与历史无关：** 一个含 5000 次工具调用、正文合计 500MB 的会话，layered 打开读取的字节数与一个只有 3 轮对话的会话在同一量级；抓包不含任何 blob 正文。
- **展开成本有界：** `trunk.get` 读取的字节只与该 trunk 的 ≤100 条 overview 有关，不随 round 总长增长，也不触发同 round 内其他 trunk 的读取。
- **blob 定位不扫描：** 写入 5000 条 blob 的总读字节数与已写入总量无关（旧实现是平方级）；`blob.get` 的读取字节数等于该 blob 自身长度。
- **边界：** batch 第 16 条关闭、trunk 第 100 条关闭；无独白时 batch 文本回退到首个 thinking 前 100 字，再回退到「调用了 N 次工具」。
- **跨 channel 复用：** 另一个 channel 注册同一个目录后，既有会话照常列出、照常打开、照常续聊，不依赖它自己那份 workspace id。
- **版本单向：** `format` 高于本机的会话仍出现在列表里并说明原因，但打不开；本机只读它不会改动 `meta.json`。
- **写入互斥：** 同一 session 的第二个 daemon 写入被拒绝并指出占用者，读取不受影响；不同 session 可跨 channel 并行写；占用者退出后无需重启即可恢复写入；从稳定 turn Fork 的新 session 不受源 session 锁影响。
- **删除彻底：** `session.delete` 删掉整个会话目录，包括 blobs 与 scratch。
